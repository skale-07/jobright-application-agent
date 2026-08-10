import { getAccount, getOrCreateAccount } from "../accounts/vault.js";
import { readGmailToken } from "../gmail/tokenStore.js";
import { loadPublicProfile } from "../candidate/publicProfileIO.js";

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
