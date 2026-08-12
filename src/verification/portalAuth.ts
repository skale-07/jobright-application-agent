import type { Locator, Page } from "playwright";
import { assertNavigationAllowed } from "../navigation/navigationGuards.js";
import { isTrustedWorkdayHost } from "../ats/workday/urlValidation.js";
import { workdaySelectorsV1 } from "../ats/workday/selectors.js";
import { prepareCredentialsForHost } from "./accountCredentials.js";
import { getAccount } from "../accounts/vault.js";
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
 *   - Host gate: recognized ATS auth hosts only (Workday tenants today).
 *     "A page said Sign In" is NEVER enough on an arbitrary host — that
 *     is how credentials get sprayed at phishing pages.
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
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/(^|\.)jobright\.ai$/i.test(host)) return false;
    return getAccount(host) !== null;
  } catch {
    return false;
  }
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
    return { status: "refused", verification_used: false, notes, secrets };
  }

  const emailInput = await firstVisible(page, sel.emailInput);
  const passwordInput = await firstVisible(page, sel.passwordInput);
  if (!emailInput || !passwordInput) {
    notes.push("portal auth: no sign-in form on this page");
    return { status: "not_an_auth_wall", verification_used: false, notes, secrets };
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
  if (!creds.credentials.available) {
    notes.push("portal auth: no credentials available (no candidate email)");
    return { status: "wall_remains", verification_used: false, notes, secrets };
  }
  const { username, password } = creds.credentials;
  // The vault emits "created account" the first time it mints one for a
  // host, "existing"/"loaded" when it reuses. A freshly created account has
  // no portal login yet, so it needs the create-account form.
  const isNewAccount = creds.notes.some((n) => /vault: created account/i.test(n));

  // Choose the form: a brand-new account prefers Create Account; an
  // existing vault account signs in. Flip forms via the tenant's link
  // when the other one is showing.
  const verifyPassword = await firstVisible(page, sel.verifyPasswordInput);
  const onCreateForm = verifyPassword !== null;
  if (isNewAccount && !onCreateForm) {
    const link = await firstVisible(page, sel.createAccountLink);
    if (link) {
      await link.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(settle);
      notes.push("portal auth: switched to the create-account form");
    }
  } else if (!isNewAccount && onCreateForm) {
    const link = await firstVisible(page, sel.signInLink);
    if (link) {
      await link.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(settle);
      notes.push("portal auth: switched to the sign-in form");
    }
  }

  // Re-resolve after any form flip.
  const email2 = (await firstVisible(page, sel.emailInput)) ?? emailInput;
  const password2 = (await firstVisible(page, sel.passwordInput)) ?? passwordInput;
  await email2.fill(username, { timeout: 5_000 });
  await password2.fill(password, { timeout: 5_000 });
  const verify2 = await firstVisible(page, sel.verifyPasswordInput);
  if (verify2) {
    await verify2.fill(password, { timeout: 5_000 });
    const checkbox = await firstVisible(page, sel.createAccountCheckbox);
    if (checkbox) await checkbox.check({ timeout: 3_000 }).catch(() => undefined);
  }
  const creating = verify2 !== null;
  const submit = creating
    ? ((await firstVisible(page, sel.createAccountSubmit)) ??
      (await firstVisible(page, sel.signInSubmit)))
    : ((await firstVisible(page, sel.signInSubmit)) ??
      (await firstVisible(page, sel.createAccountSubmit)));
  if (!submit) {
    notes.push("portal auth: no submit control on the auth form");
    return { status: "wall_remains", verification_used: false, notes, secrets };
  }
  const requestedAt = new Date().toISOString();
  await submit.click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(settle);
  notes.push(creating ? "portal auth: create-account submitted" : "portal auth: sign-in submitted");

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
      notes.push(
        "portal auth: verification requested but no mailbox provider is enabled",
      );
      return { status: "wall_remains", verification_used: false, notes, secrets };
    }
    const wait = await waiter(
      { sent_to: username, requested_at: requestedAt },
      [host],
    );
    if (wait.kind === "code") {
      secrets.push(wait.code);
      await codeInput.fill(wait.code, { timeout: 5_000 });
      const verifySubmit = await firstVisible(page, sel.verificationSubmit);
      if (verifySubmit) await verifySubmit.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(settle);
      verificationUsed = true;
      notes.push("portal auth: emailed code entered");
    } else if (wait.kind === "link") {
      secrets.push(wait.url);
      await page.goto(wait.url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(settle);
      verificationUsed = true;
      notes.push("portal auth: emailed verification link opened");
    } else {
      notes.push("portal auth: verification email not found within the poll budget");
      return { status: "wall_remains", verification_used: false, notes, secrets };
    }
  } else if (codeInput) {
    notes.push(
      "portal auth: code input present but page shows no verification prompt — mailbox not consulted",
    );
  }

  // Success = the auth form is gone. Bad-credentials text = named failure.
  const stillEmail = await firstVisible(page, sel.emailInput);
  const stillPassword = await firstVisible(page, sel.passwordInput);
  if (!stillEmail || !stillPassword) {
    return {
      status: creating ? "account_created" : "signed_in",
      verification_used: verificationUsed,
      notes,
      secrets,
    };
  }
  const afterText = await page
    .innerText("body", { timeout: 3_000 })
    .then((t) => t.slice(0, 2_000))
    .catch(() => "");
  if (sel.badCredentialsMarkers.test(afterText)) {
    notes.push("portal auth: the portal rejected the attempt (bad credentials / unverified)");
  } else {
    notes.push("portal auth: auth form still present after submit");
  }
  return { status: "wall_remains", verification_used: verificationUsed, notes, secrets };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
