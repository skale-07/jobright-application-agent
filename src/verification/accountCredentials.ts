import { getAccount, getOrCreateAccount } from "../accounts/vault.js";
import { readGmailToken } from "../gmail/tokenStore.js";
import { loadPublicProfile } from "../candidate/publicProfileIO.js";
import { getConfig } from "../config/index.js";

/**
 * Account-credential preparation for verification portals (Workday-style
 * "create an account to apply" walls) — extracted from runNavigation so
 * the policy is one tested unit instead of inline orchestration:
 *
 *   1. An EXISTING vault account for the host is always reused.
 *   2. A new account is minted ONLY when the page actually shows a login
 *      wall (never speculatively) and only when a mailbox address exists
 *      to receive its verification mail (Gmail token first, then the
 *      public profile's email).
 *   3. jobright.ai never gets credentials — that session is the
 *      operator's own login.
 *
 * The returned secrets list feeds the caller's artifact scrubber;
 * credentials themselves ride only the in-memory task into the sidecar.
 */

export type PortalCredentials =
  | { available: false }
  | { available: true; username: string; password: string };

export function candidateEmailForAccounts(overrides?: {
  gmailEmail?: string | null;
  profileEmail?: string | null;
}): string {
  if (overrides) {
    return overrides.gmailEmail ?? overrides.profileEmail ?? "";
  }
  return (
    readGmailToken()?.account_email ??
    (() => {
      try {
        return loadPublicProfile().email;
      } catch {
        return "";
      }
    })()
  );
}

/**
 * Live 2026-08-14: a REAL Workday account was created with
 * candidate@example.com — the placeholder from the example profile — and
 * its verification code went to a mailbox nobody owns, wedging the
 * application permanently. An address like that is never usable: refuse
 * loudly (naming the fix) instead of minting an unreachable account.
 */
const PLACEHOLDER_EMAIL_RE =
  /@example\.(com|org|net)$|@(example|placeholder|invalid|localhost)$|@email\.com$|^your[._-]?email@/i;

export function isPlaceholderEmail(email: string): boolean {
  return PLACEHOLDER_EMAIL_RE.test(email.trim());
}

export function prepareCredentialsForHost(input: {
  host: string | null;
  runId: string;
  loginWallDetected: boolean;
  /** Test seam: replaces the Gmail-token → profile email ladder. */
  emailOverride?: string;
}): { credentials: PortalCredentials; notes: string[]; secrets: string[] } {
  const notes: string[] = [];
  const secrets: string[] = [];
  const host = input.host?.toLowerCase() ?? null;

  if (!host || /(^|\.)jobright\.ai$/i.test(host)) {
    return { credentials: { available: false }, notes, secrets };
  }

  // STANDING credentials (operator directive 2026-08-12): one email +
  // password used on EVERY employer portal, so signing in is never a
  // per-site chore. This is deliberately the first thing tried — a
  // per-host vault entry only exists when a portal forced its own
  // password, and that case is handled below.
  const cfg = getConfig();
  const standingPassword = cfg.portalLoginPassword;
  if (standingPassword) {
    let standingEmail =
      cfg.portalLoginEmail ?? input.emailOverride ?? candidateEmailForAccounts();
    if (standingEmail && isPlaceholderEmail(standingEmail)) {
      notes.push(
        `REFUSED: login email "${standingEmail}" is a placeholder — a real portal account would send its verification mail to a mailbox nobody owns. Set PORTAL_LOGIN_EMAIL to your real address.`,
      );
      standingEmail = "";
    }
    if (standingEmail) {
      const perHost = getAccount(host);
      // A per-host entry wins ONLY when its password differs from the
      // standing one (i.e. the site forced a change and it was stored).
      if (perHost && perHost.password !== standingPassword) {
        secrets.push(perHost.password);
        notes.push(`vault: per-host password for ${host} (overrides the standing login)`);
        return {
          credentials: {
            available: true,
            username: perHost.username,
            password: perHost.password,
          },
          notes,
          secrets,
        };
      }
      secrets.push(standingPassword);
      notes.push(`standing portal login used for ${host}`);
      return {
        credentials: {
          available: true,
          username: standingEmail,
          password: standingPassword,
        },
        notes,
        secrets,
      };
    }
    notes.push(
      "PORTAL_LOGIN_PASSWORD is set but no login email is available (set PORTAL_LOGIN_EMAIL)",
    );
  }

  const existing = getAccount(host);
  if (existing) {
    secrets.push(existing.password);
    notes.push(`vault: existing account for ${host}`);
    return {
      credentials: {
        available: true,
        username: existing.username,
        password: existing.password,
      },
      notes,
      secrets,
    };
  }

  if (!input.loginWallDetected) {
    // No wall in evidence — never mint an account speculatively.
    return { credentials: { available: false }, notes, secrets };
  }

  const email = input.emailOverride ?? candidateEmailForAccounts();
  if (!email) {
    notes.push(
      `vault: cannot mint an account for ${host} — no candidate email (Gmail token and public profile both missing)`,
    );
    return { credentials: { available: false }, notes, secrets };
  }
  if (isPlaceholderEmail(email)) {
    notes.push(
      `REFUSED: will not mint an account for ${host} with placeholder email "${email}" — its verification mail would go to a mailbox nobody owns (live 2026-08-14: candidate@example.com wedged a real Workday application). Fix the email in your public profile / PORTAL_LOGIN_EMAIL.`,
    );
    return { credentials: { available: false }, notes, secrets };
  }

  const { account, created } = getOrCreateAccount(host, {
    email,
    runId: input.runId,
  });
  secrets.push(account.password);
  notes.push(`vault: ${created ? "created" : "loaded"} account for ${host}`);
  return {
    credentials: {
      available: true,
      username: account.username,
      password: account.password,
    },
    notes,
    secrets,
  };
}
