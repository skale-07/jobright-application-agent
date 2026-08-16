import type { Locator, Page } from "playwright";
import { assertNavigationAllowed } from "../navigation/navigationGuards.js";
import { isTrustedWorkdayHost } from "../ats/workday/urlValidation.js";
import { workdaySelectorsV1 } from "../ats/workday/selectors.js";
import { prepareCredentialsForHost } from "./accountCredentials.js";
import { getAccount } from "../accounts/vault.js";
import { getConfig } from "../config/index.js";
import {
  diagnoseLoginWall,
  summarizeLoginWall,
  type LoginWallDiagnosis,
} from "./loginWallDiagnosis.js";
import {
  resolveNavVerificationWaiter,
  type NavVerificationWaiter,
} from "./emailVerification.js";
import { verificationEvidencePresent } from "../navigation/runNavigation.js";
import { performTransition } from "../browser/transition.js";
import { recordTransitionOutcome } from "../storage/transitionOutcomes.js";

/**
 * Deterministic ATS portal auth (operator directive 2026-08-11): when a
 * recognized ATS host shows a sign-in / create-account wall, ALWAYS
 * authenticate with the standing candidate email (the same mailbox the
 * verification scanner reads) and PORTAL_LOGIN_PASSWORD —
 * sign in when an account already exists, create it otherwise,
 * and complete emailed verification ONLY when the page asks for it.
 *
 * Workday posting pages (Crowe live 2026-08-14, operator screenshots):
 *   Apply → "Start Your Application" modal → Apply Manually →
 *   Create Account form with "Already have an account? Sign In".
 * Portal auth must click that sequence BEFORE it looks for inputs.
 * Autofill-with-resume is never the unattended path.
 *
 * Hard rails:
 *   - Host gate: standing credentials (PORTAL_LOGIN_*) authorize any
 *     https employer host the apply flow reaches. Without them, only
 *     recognized ATS families and vault-seeded hosts qualify. jobright is
 *     never credentialed, and a form must actually be present.
 *   - Passwords/codes ride memory only — never notes.
 *   - Bounded: Apply + Apply Manually + one Sign In flip + one
 *     create/sign-in attempt + one mailbox poll cycle.
 *   - Guarded by NAVIGATION_ENABLED.
 */

export type PortalAuthOutcome = {
  status:
    | "signed_in"
    | "account_created"
    | "wall_remains"
    | "not_an_auth_wall"
    | "refused";
  verification_used: boolean;
  /** Whether an account was created after the sign-in was rejected. */
  escalated_to_create: boolean;
  /** Zero-mutation read of the wall's shape (logged + artifacted). */
  diagnosis: LoginWallDiagnosis | null;
  notes: string[];
  /** Secrets touched during the flow — callers scrub artifacts with these. */
  secrets: string[];
};

export type PortalAuthSeams = {
  waiter?: NavVerificationWaiter | null;
  emailOverride?: string;
  /** Settle wait between actions (tests pass 0). */
  settleMs?: number;
};

/**
 * Where portal auth may type credentials. Two ways in, both explicit:
 *   1. a recognized ATS host family (Workday tenants today), or
 *   2. a host the OPERATOR seeded in the vault themselves
 *      (`accounts:set --host ...`) — storing a login for a host IS the
 *      authorization to use it there, and reuse-only means nothing is
 *      ever minted for an unrecognized host.
 * Everything else is refused: "a page said Sign In" is never enough.
 */
export function isRecognizedAtsAuthHost(url: string): boolean {
  if (isTrustedWorkdayHost(url)) return true;
  let host: string;
  let parsed: URL;
  try {
    parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (/(^|\.)jobright\.ai$/i.test(host)) return false;
  // Loopback = the operator's own sandbox (src/sandbox/server.ts): the
  // https transport requirement protects nothing on 127.0.0.1, and
  // recognizing it lets the operator rehearse the account-creation /
  // sign-in flow locally with the same PORTAL_LOGIN_* credentials the
  // live portals use.
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (
    getConfig().portalLoginPassword &&
    (parsed.protocol === "https:" || isLoopback)
  ) {
    return true;
  }
  return getAccount(host) !== null;
}

async function firstVisible(page: Page, selector: string): Promise<Locator | null> {
  const loc = page.locator(selector).first();
  if ((await loc.count().catch(() => 0)) === 0) return null;
  if (!(await loc.isVisible().catch(() => false))) return null;
  return loc;
}

async function visibleNamed(
  page: Page,
  name: RegExp,
  roles: Array<"button" | "link"> = ["button", "link"],
): Promise<Locator | null> {
  for (const role of roles) {
    const c = page.getByRole(role, { name }).first();
    if (
      (await c.count().catch(() => 0)) > 0 &&
      (await c.isVisible().catch(() => false))
    ) {
      return c;
    }
  }
  return null;
}

/**
 * A <button> inside a <form> with no type, or type=submit, submits that
 * form. Workday's "Already have an account? Sign In" is type=button (a
 * view switch). The sandbox puts Create Account and Sign In on ONE page;
 * clicking Sign In as a "flip" POSTs the empty sign-in form.
 */
async function isFormSubmitControl(loc: Locator): Promise<boolean> {
  return loc
    .evaluate((el: {
      tagName: string;
      getAttribute: (n: string) => string | null;
      closest: (s: string) => unknown;
    }) => {
      const tag = el.tagName;
      if (tag !== "BUTTON" && tag !== "INPUT") return false;
      const raw = el.getAttribute("type");
      const type = (raw ?? (tag === "BUTTON" ? "submit" : "")).toLowerCase();
      if (type !== "submit") return false;
      return el.closest("form") !== null;
    })
    .catch(() => false);
}

/** The wrapping <form> of a submit, or null when the ATS does not use one. */
async function formOf(loc: Locator): Promise<Locator | null> {
  const inside = await loc
    .evaluate((el: { closest: (s: string) => unknown }) =>
      Boolean(el.closest("form")),
    )
    .catch(() => false);
  if (!inside) return null;
  return loc.locator("xpath=./ancestor::form[1]");
}

async function locateAuthFields(page: Page): Promise<{
  email: Locator | null;
  password: Locator | null;
}> {
  const sel = workdaySelectorsV1.auth;
  const email =
    (await firstVisible(page, sel.emailInput)) ??
    (await firstVisible(
      page,
      "input[type='email'], input[name*='email' i], input[autocomplete='username']",
    ));
  const password =
    (await firstVisible(page, sel.passwordInput)) ??
    (await firstVisible(page, "input[type='password']"));
  return { email, password };
}

export async function authenticateAtsPortal(
  page: Page,
  seams: PortalAuthSeams = {},
): Promise<PortalAuthOutcome> {
  assertNavigationAllowed("authenticateAtsPortal");
  const notes: string[] = [];
  const secrets: string[] = [];
  const settle = seams.settleMs ?? 800;
  const sel = workdaySelectorsV1.auth;
  const url = page.url();
  const host = safeHost(url);

  if (!isRecognizedAtsAuthHost(url)) {
    notes.push(`portal auth refused: ${host} is not a recognized ATS auth host`);
    return {
      status: "refused",
      verification_used: false,
      escalated_to_create: false,
      diagnosis: null,
      notes,
      secrets,
    };
  }

  const diagnosis = await diagnoseLoginWall(page);
  notes.push(summarizeLoginWall(diagnosis));

  let fields = await locateAuthFields(page);
  if (!fields.email || !fields.password) {
    await openWorkdayApplyChooser(page, notes, settle);
    fields = await locateAuthFields(page);
  }

  const creds = prepareCredentialsForHost({
    host,
    runId: `portal-auth-${Date.now()}`,
    loginWallDetected: true,
    ...(seams.emailOverride ? { emailOverride: seams.emailOverride } : {}),
  });
  notes.push(...creds.notes);
  secrets.push(...creds.secrets);
  const done = (
    status: PortalAuthOutcome["status"],
    extra: { verification?: boolean; escalated?: boolean; diag?: LoginWallDiagnosis } = {},
  ): PortalAuthOutcome => ({
    status,
    verification_used: extra.verification ?? false,
    escalated_to_create: extra.escalated ?? false,
    diagnosis: extra.diag ?? diagnosis,
    notes,
    secrets,
  });

  const settleEmailedCodeWall = async (input: {
    username: string;
    escalated: boolean;
  }): Promise<PortalAuthOutcome | null> => {
    const codeInput =
      (await firstVisible(page, sel.verificationCodeInput)) ??
      (await firstVisible(page, "input[autocomplete='one-time-code']"));
    const pageText = await page
      .innerText("body", { timeout: 3_000 })
      .then((t) => t.slice(0, 2_000))
      .catch(() => "");
    if (!codeInput || !verificationEvidencePresent(pageText)) {
      if (codeInput) {
        notes.push(
          "portal auth: code input present but page shows no verification prompt — mailbox not consulted",
        );
      }
      return null;
    }
    const waiter =
      seams.waiter !== undefined ? seams.waiter : resolveNavVerificationWaiter();
    if (!waiter) {
      notes.push(
        "portal auth: verification requested but no mailbox provider is enabled",
      );
      return done("wall_remains", { escalated: input.escalated });
    }
    const wait = await waiter(
      { sent_to: input.username, requested_at: new Date().toISOString() },
      [host],
    );
    let verificationUsed = false;
    if (wait.kind === "code") {
      secrets.push(wait.code);
      await codeInput.fill(wait.code, { timeout: 5_000 }).catch(() => undefined);
      const verifySubmit = await firstVisible(page, sel.verificationSubmit);
      if (verifySubmit) {
        await verifySubmit.click({ timeout: 5_000 }).catch(() => undefined);
      }
      await settlePage(page, settle, 1_000);
      verificationUsed = true;
      notes.push("portal auth: emailed code entered");
    } else if (wait.kind === "link") {
      secrets.push(wait.url);
      await page
        .goto(wait.url, { waitUntil: "domcontentloaded", timeout: 20_000 })
        .catch(() => undefined);
      await settlePage(page, settle, 1_000);
      verificationUsed = true;
      notes.push("portal auth: emailed verification link opened");
    } else {
      notes.push(
        "portal auth: verification email not found within the poll budget",
      );
      return done("wall_remains", { escalated: input.escalated });
    }
    const stillCode =
      ((await firstVisible(page, sel.verificationCodeInput)) ??
        (await firstVisible(page, "input[autocomplete='one-time-code']"))) !==
        null &&
      verificationEvidencePresent(
        await page
          .innerText("body", { timeout: 3_000 })
          .then((t) => t.slice(0, 2_000))
          .catch(() => ""),
      );
    if (stillCode) {
      notes.push("portal auth: emailed-code wall remains");
      return done("wall_remains", {
        verification: verificationUsed,
        escalated: input.escalated,
        diag: await diagnoseLoginWall(page),
      });
    }
    return done(input.escalated ? "account_created" : "signed_in", {
      verification: verificationUsed,
      escalated: input.escalated,
      diag: await diagnoseLoginWall(page),
    });
  };

  if (!fields.email || !fields.password) {
    // Already on the emailed-code wall (create redirected here, or a retry
    // landed on /portal/verify). Scan the mailbox; do not plan this page
    // as an application form.
    if (!creds.credentials.available) {
      const codeInput =
        (await firstVisible(page, sel.verificationCodeInput)) ??
        (await firstVisible(page, "input[autocomplete='one-time-code']"));
      if (codeInput) {
        notes.push(
          "portal auth: emailed-code wall but no credentials (set PORTAL_LOGIN_EMAIL/PASSWORD)",
        );
        return done("wall_remains");
      }
      notes.push("portal auth: no sign-in form on this page");
      return {
        status: "not_an_auth_wall",
        verification_used: false,
        escalated_to_create: false,
        diagnosis: await diagnoseLoginWall(page),
        notes,
        secrets,
      };
    }
    const codeOnly = await settleEmailedCodeWall({
      username: creds.credentials.username,
      escalated: false,
    });
    if (codeOnly) return codeOnly;
    notes.push("portal auth: no sign-in form on this page");
    return {
      status: "not_an_auth_wall",
      verification_used: false,
      escalated_to_create: false,
      diagnosis: await diagnoseLoginWall(page),
      notes,
      secrets,
    };
  }

  if (!creds.credentials.available) {
    notes.push("portal auth: no credentials available (set PORTAL_LOGIN_EMAIL/PASSWORD)");
    return done("wall_remains");
  }
  const { username, password } = creds.credentials;

  // Workday lands on Create Account after Apply Manually. Prefer Sign In
  // when standing credentials exist (operator already has the account).
  // Do NOT click a Sign In *submit* — that posts an empty form. A real
  // flip is Workday's type=button signInLink. When both forms are already
  // on the page, skip the click and just target the Sign In form.
  let preferSignIn = false;
  const wallNow = await diagnoseLoginWall(page);
  if (
    wallNow.classification === "create_account_form" &&
    creds.notes.some((n) => /standing portal login|vault: (existing|per-host)/i.test(n))
  ) {
    const signIn =
      (await firstVisible(page, sel.signInLink)) ??
      (await visibleNamed(page, /^(already have an account\??\s*)?sign in$/i));
    if (signIn && !(await isFormSubmitControl(signIn))) {
      await signIn.click({ timeout: 5_000 }).catch(() => undefined);
      await settlePage(page, settle, 800);
      preferSignIn = true;
      notes.push("portal auth: flipped Create Account → Sign In (standing credentials)");
    } else if (await visibleNamed(page, /^(sign in|log ?in)$/i)) {
      preferSignIn = true;
      notes.push(
        "portal auth: Sign In form already on this page — using standing credentials",
      );
    }
  }

  const attempt = async (
    kind: "sign_in" | "create",
  ): Promise<{ diag: LoginWallDiagnosis; formGone: boolean }> => {
    const submit =
      (await firstVisible(
        page,
        kind === "create" ? sel.createAccountSubmit : sel.signInSubmit,
      )) ??
      (await visibleNamed(
        page,
        kind === "create"
          ? /create account|sign up|register/i
          : /^(sign in|log ?in|continue|submit)$/i,
      ));
    if (!submit) {
      notes.push(`portal auth: no ${kind} submit control found`);
      return { diag: await diagnoseLoginWall(page), formGone: false };
    }
    const form = await formOf(submit);
    const emailField = form
      ? form
          .locator(
            "input[type='email'], input[name*='email' i], input[autocomplete='username']",
          )
          .first()
      : ((await firstVisible(page, sel.emailInput)) ??
        (await firstVisible(
          page,
          "input[type='email'], input[name*='email' i], input[autocomplete='username']",
        )));
    const passwordFields = form
      ? form.locator("input[type='password']")
      : page.locator("input[type='password']");
    const passwordCount = await passwordFields.count().catch(() => 0);
    if (emailField && (await emailField.count().catch(() => 0)) > 0) {
      await emailField.fill(username, { timeout: 5_000 }).catch(() => undefined);
    }
    for (let i = 0; i < Math.min(passwordCount, 2); i++) {
      await passwordFields.nth(i).fill(password, { timeout: 5_000 }).catch(() => undefined);
    }
    const checkbox = await firstVisible(page, sel.createAccountCheckbox);
    if (kind === "create" && checkbox) {
      await checkbox.check({ timeout: 3_000 }).catch(() => undefined);
    }
    await submit.click({ timeout: 10_000 }).catch(() => undefined);
    await settlePage(page, settle, 1_200);
    const after = await diagnoseLoginWall(page);
    const formGone = !after.fields.password && !after.errorText;
    notes.push(
      `portal auth ${kind}: ${formGone ? "form cleared" : after.classification}` +
        (after.errorText ? ` — "${after.errorText.slice(0, 100)}"` : ""),
    );
    return { diag: after, formGone };
  };

  const wallAfterChooser = await diagnoseLoginWall(page);
  let escalated = false;
  const startAsCreate =
    !preferSignIn && wallAfterChooser.classification === "create_account_form";
  let state = startAsCreate ? await attempt("create") : await attempt("sign_in");
  if (startAsCreate) escalated = true;

  if (!state.formGone && state.diag.classification === "credentials_rejected") {
    const route = state.diag.createAccountRoute;
    // Dual-form walls already show Create Account. Clicking that submit
    // would POST an empty create form; just fill it.
    if (state.diag.fields.confirmPassword) {
      notes.push("portal auth: sign-in rejected — creating the account on this page");
      escalated = true;
      state = await attempt("create");
    } else if (route) {
      const control = await visibleNamed(page, new RegExp(`^${escapeRe(route)}$`, "i"));
      if (control && !(await isFormSubmitControl(control))) {
        await control.click({ timeout: 5_000 }).catch(() => undefined);
        await settlePage(page, settle, 1_000);
        notes.push(`portal auth: sign-in rejected — opened "${route}" to create the account`);
        escalated = true;
        state = await attempt("create");
      } else if (control && (await isFormSubmitControl(control))) {
        notes.push("portal auth: sign-in rejected — creating the account on this page");
        escalated = true;
        state = await attempt("create");
      }
    } else {
      notes.push(
        "portal auth: sign-in rejected and no create-account route is offered on this page",
      );
    }
  }

  const codeResult = await settleEmailedCodeWall({ username, escalated });
  if (codeResult) return codeResult;

  const finalDiag = await diagnoseLoginWall(page);
  if (!finalDiag.fields.password || finalDiag.classification === "no_form_found") {
    return done(escalated ? "account_created" : "signed_in", {
      escalated,
      diag: finalDiag,
    });
  }
  notes.push(`portal auth: wall remains (${finalDiag.classification})`);
  return done("wall_remains", { escalated, diag: finalDiag });
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tests pass settleMs: 0 so fixture clicks stay synchronous. */
async function settlePage(
  page: Page,
  settle: number,
  liveFloorMs: number,
): Promise<void> {
  const ms = settle === 0 ? 0 : Math.max(settle, liveFloorMs);
  if (ms > 0) await page.waitForTimeout(ms);
}

/**
 * Poll for the auth form to render. Workday's SPA rebuilds the page after
 * "Apply Manually" and takes SECONDS — live 2026-08-14 (Crowe): the walk
 * clicked Apply, clicked Apply Manually, waited 800ms, found no third
 * button, and returned; the Create Account form the operator was looking
 * at rendered right after. The run then reported "no sign-in form on this
 * page" with credentials sitting unused in the env. Bounded poll, and
 * tests keep settle 0 so fixtures stay synchronous.
 */
async function waitForAuthForm(
  page: Page,
  settle: number,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (settle === 0) return (await firstVisible(page, "input[type='password']")) !== null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await firstVisible(page, "input[type='password']")) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(300);
  }
}

/**
 * Workday posting → Start Your Application modal → Apply Manually.
 * Cap 3 clicks. Never Autofill with Resume. Never wizard submit.
 */
async function openWorkdayApplyChooser(
  page: Page,
  notes: string[],
  settle: number,
): Promise<void> {
  const sel = workdaySelectorsV1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await firstVisible(page, "input[type='password']")) return;

    const manual =
      (await firstVisible(page, sel.applyMethods.applyManually)) ??
      (await visibleNamed(page, /^apply manually$/i));
    if (manual) {
      await manual.click({ timeout: 8_000 }).catch(() => undefined);
      notes.push(`portal auth: clicked Apply Manually (attempt ${attempt})`);
      // Apply Manually is the LAST click before the account form — wait for
      // it rather than probing for another button 800ms later.
      if (await waitForAuthForm(page, settle)) {
        notes.push("portal auth: account form rendered after Apply Manually");
        return;
      }
      notes.push("portal auth: no account form within 15s of Apply Manually");
      continue;
    }

    const apply =
      (await firstVisible(page, sel.applyButton)) ??
      (await firstVisible(page, sel.auth.gatedEntry)) ??
      (await visibleNamed(page, /^apply( now)?$/i));
    if (apply) {
      const label = ((await apply.textContent().catch(() => null)) ?? "Apply")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      // The shared transition primitive replaces click+800ms-floor:
      // change-detected settle, one obstruction-sweep retry on a silent
      // no-op click, and telemetry for the improve loop.
      const transition = await performTransition(page, apply, {
        settleTimeoutMs: settle === 0 ? 0 : 15_000,
        adoptPopups: false,
      });
      recordTransitionOutcome({
        seam: "portal_auth_apply",
        host: safeHost(page.url()),
        result: transition,
      });
      notes.push(`portal auth: clicked "${label || "Apply"}" (attempt ${attempt})`);
      continue;
    }

    // No button left to click. That is usually because the form is ON ITS
    // WAY — Workday swaps the page out from under the probe. Give it the
    // same wait before declaring there is no sign-in form here.
    if (attempt > 1 && (await waitForAuthForm(page, settle))) {
      notes.push("portal auth: account form rendered while waiting");
      return;
    }
    notes.push(
      `portal auth: Apply / Apply Manually not found on attempt ${attempt}`,
    );
    return;
  }
}
