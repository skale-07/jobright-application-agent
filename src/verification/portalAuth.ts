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

/**
 * Deterministic ATS portal auth (operator directive 2026-08-11): when a
 * recognized ATS host shows a sign-in / create-account wall, ALWAYS
 * authenticate with the standing candidate email (the same mailbox the
 * verification scanner reads) and the vault's per-host password —
 * sign in when the vault already holds the account, create it otherwise,
 * and complete the emailed verification when — and ONLY when — the page
 * actually asks for it.
 *
 * Hard rails:
 *   - Host gate: standing credentials (PORTAL_LOGIN_*) authorize any
 *     https employer host the apply flow reaches — that is the operator's
 *     explicit "one login everywhere" decision. Without them, only
 *     recognized ATS families and vault-seeded hosts qualify. jobright is
 *     never credentialed, and a form must actually be present.
 *   - Vault policy is unchanged (reuse; mint per-host random password;
 *     never jobright). Passwords/codes ride memory only — never notes.
 *   - Bounded: one create attempt + one sign-in attempt + one mailbox
 *     poll cycle per call.
 *   - Guarded by NAVIGATION_ENABLED (this mutates a third-party site).
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
  // jobright is the operator's own session — never credentialed here.
  if (/(^|\.)jobright\.ai$/i.test(host)) return false;
  // Standing credentials are an explicit, standing operator decision to
  // use one login on every employer portal: configuring them authorizes
  // any employer host the apply flow actually reaches. https only, and
  // portal auth still requires a real sign-in form on the page.
  if (getConfig().portalLoginPassword && parsed.protocol === "https:") {
    return true;
  }
  // Otherwise a per-host vault entry is the authorization.
  return getAccount(host) !== null;
}

async function firstVisible(page: Page, selector: string): Promise<Locator | null> {
  const loc = page.locator(selector).first();
  if ((await loc.count().catch(() => 0)) === 0) return null;
  if (!(await loc.isVisible().catch(() => false))) return null;
  return loc;
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

  if (!isRecognizedAtsAuthHost(url)) {
    notes.push(`portal auth refused: ${safeHost(url)} is not a recognized ATS auth host`);
    return { status: "refused", verification_used: false, escalated_to_create: false, diagnosis: null, notes, secrets };
  }

  // Read the wall's shape BEFORE touching it — this is what makes a
  // parked login debuggable after the fact (operator request 2026-08-12).
  const diagnosis = await diagnoseLoginWall(page);
  notes.push(summarizeLoginWall(diagnosis));

  const emailInput =
    (await firstVisible(page, sel.emailInput)) ??
    (await firstVisible(
      page,
      "input[type='email'], input[name*='email' i], input[autocomplete='username']",
    ));
  const passwordInput =
    (await firstVisible(page, sel.passwordInput)) ??
    (await firstVisible(page, "input[type='password']"));
  if (!emailInput || !passwordInput) {
    notes.push("portal auth: no sign-in form on this page");
    return {
      status: "not_an_auth_wall",
      verification_used: false,
      escalated_to_create: false,
      diagnosis,
      notes,
      secrets,
    };
  }

  const host = safeHost(url);
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
  if (!creds.credentials.available) {
    notes.push("portal auth: no credentials available (set PORTAL_LOGIN_EMAIL/PASSWORD)");
    return done("wall_remains");
  }
  const { username, password } = creds.credentials;

  /** Fill + submit whichever form is on screen. Returns the post-state. */
  const attempt = async (
    kind: "sign_in" | "create",
  ): Promise<{ diag: LoginWallDiagnosis; formGone: boolean }> => {
    const emailField =
      (await firstVisible(page, sel.emailInput)) ??
      (await firstVisible(
        page,
        "input[type='email'], input[name*='email' i], input[autocomplete='username']",
      ));
    const passwordFields = page.locator("input[type='password']");
    const passwordCount = await passwordFields.count().catch(() => 0);
    if (emailField) await emailField.fill(username, { timeout: 5_000 }).catch(() => undefined);
    for (let i = 0; i < Math.min(passwordCount, 2); i++) {
      // Both the password and the confirm field take the same value; a
      // create form that asks twice is satisfied without inventing one.
      await passwordFields.nth(i).fill(password, { timeout: 5_000 }).catch(() => undefined);
    }
    const checkbox = await firstVisible(page, sel.createAccountCheckbox);
    if (kind === "create" && checkbox) {
      await checkbox.check({ timeout: 3_000 }).catch(() => undefined);
    }
    const submit =
      (await firstVisible(
        page,
        kind === "create" ? sel.createAccountSubmit : sel.signInSubmit,
      )) ??
      (await (async () => {
        const namePattern =
          kind === "create"
            ? /create account|sign up|register/i
            : /^(sign in|log ?in|continue|submit)$/i;
        for (const role of ["button", "link"] as const) {
          const c = page.getByRole(role, { name: namePattern }).first();
          if (
            (await c.count().catch(() => 0)) > 0 &&
            (await c.isVisible().catch(() => false))
          ) {
            return c;
          }
        }
        return null;
      })());
    if (!submit) {
      notes.push(`portal auth: no ${kind} submit control found`);
      return { diag: await diagnoseLoginWall(page), formGone: false };
    }
    await submit.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(Math.max(settle, 1_200));
    const after = await diagnoseLoginWall(page);
    const formGone = !after.fields.password && !after.errorText;
    notes.push(
      `portal auth ${kind}: ${formGone ? "form cleared" : after.classification}` +
        (after.errorText ? ` — "${after.errorText.slice(0, 100)}"` : ""),
    );
    return { diag: after, formGone };
  };

  // A create form already on screen is filled as a create; otherwise sign
  // in FIRST and only escalate to account creation when the portal
  // actually rejects the login (operator directive 2026-08-12).
  let escalated = false;
  let state =
    diagnosis.classification === "create_account_form"
      ? await attempt("create")
      : await attempt("sign_in");
  if (diagnosis.classification === "create_account_form") escalated = true;

  if (!state.formGone && state.diag.classification === "credentials_rejected") {
    const route = state.diag.createAccountRoute;
    if (route) {
      let opened = false;
      for (const role of ["link", "button"] as const) {
        const control = page.getByRole(role, { name: route }).first();
        if (
          (await control.count().catch(() => 0)) > 0 &&
          (await control.isVisible().catch(() => false))
        ) {
          await control.click({ timeout: 5_000 }).catch(() => undefined);
          await page.waitForTimeout(Math.max(settle, 1_000));
          opened = true;
          break;
        }
      }
      if (opened) {
        notes.push(`portal auth: sign-in rejected — opened "${route}" to create the account`);
        escalated = true;
        state = await attempt("create");
      }
    } else {
      notes.push(
        "portal auth: sign-in rejected and no create-account route is offered on this page",
      );
    }
  }

  // Email verification — ONLY when the page asks (operator rule: the
  // mailbox is never scanned on spec).
  let verificationUsed = false;
  const codeInput = await firstVisible(page, sel.verificationCodeInput);
  const pageText = await page
    .innerText("body", { timeout: 3_000 })
    .then((t) => t.slice(0, 2_000))
    .catch(() => "");
  if (codeInput && verificationEvidencePresent(pageText)) {
    const waiter =
      seams.waiter !== undefined ? seams.waiter : resolveNavVerificationWaiter();
    if (!waiter) {
      notes.push("portal auth: verification requested but no mailbox provider is enabled");
      return done("wall_remains", { escalated, diag: state.diag });
    }
    const wait = await waiter(
      { sent_to: username, requested_at: new Date().toISOString() },
      [host],
    );
    if (wait.kind === "code") {
      secrets.push(wait.code);
      await codeInput.fill(wait.code, { timeout: 5_000 }).catch(() => undefined);
      const verifySubmit = await firstVisible(page, sel.verificationSubmit);
      if (verifySubmit) await verifySubmit.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(Math.max(settle, 1_000));
      verificationUsed = true;
      notes.push("portal auth: emailed code entered");
    } else if (wait.kind === "link") {
      secrets.push(wait.url);
      await page
        .goto(wait.url, { waitUntil: "domcontentloaded", timeout: 20_000 })
        .catch(() => undefined);
      await page.waitForTimeout(Math.max(settle, 1_000));
      verificationUsed = true;
      notes.push("portal auth: emailed verification link opened");
    } else {
      notes.push("portal auth: verification email not found within the poll budget");
      return done("wall_remains", { escalated, diag: state.diag });
    }
  } else if (codeInput) {
    notes.push(
      "portal auth: code input present but page shows no verification prompt — mailbox not consulted",
    );
  }

  const finalDiag = await diagnoseLoginWall(page);
  if (!finalDiag.fields.password || finalDiag.classification === "no_form_found") {
    return done(escalated ? "account_created" : "signed_in", {
      verification: verificationUsed,
      escalated,
      diag: finalDiag,
    });
  }
  notes.push(`portal auth: wall remains (${finalDiag.classification})`);
  return done("wall_remains", { verification: verificationUsed, escalated, diag: finalDiag });
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
