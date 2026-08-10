import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { GmailClient } from "../gmail/client.js";
import { readGmailToken } from "../gmail/tokenStore.js";
import {
  waitForVerificationEmail,
  type VerificationWaitResult,
} from "../gmail/waitForVerification.js";
import { outlookCodeProvider } from "./codeProviders.js";

/**
 * The one nav-time email-verification seam: a portal said "we emailed you
 * a code/link" and Dispatch must retrieve it to continue signing in or
 * creating an account. Providers, in preference order:
 *
 *   1. Gmail — readonly REST client (GMAIL_VERIFICATION_ENABLED + saved
 *      token). Retrieves both OTP codes and magic links.
 *   2. Outlook — read-only DOM scan of the operator's authenticated web
 *      session (OUTLOOK_VERIFICATION_ENABLED). Codes only in v1: link
 *      extraction from a rendered reading pane cannot be domain-validated
 *      as strictly as raw MIME, so links stay Gmail-only for now.
 *
 * Both fail closed behind their flags; neither ever composes or sends
 * (sendGuards discipline unchanged). Codes/links are transient secrets —
 * callers scrub them from anything persisted.
 */

export type EmailVerificationNeed = {
  sent_to: string;
  sender_hint?: string | undefined;
  subject_hint?: string | undefined;
  requested_at: string;
};

export type NavVerificationWaiter = (
  need: EmailVerificationNeed,
  allowedDomains: string[],
) => Promise<VerificationWaitResult>;

/** True when ANY mailbox provider could service a verification wait. */
export function emailVerificationAvailable(): boolean {
  const cfg = getConfig();
  return (
    (cfg.gmailVerificationEnabled && readGmailToken() !== null) ||
    cfg.outlookVerificationEnabled
  );
}

/**
 * Provider-ordered waiter, or null when nothing is enabled. Gmail first;
 * an Outlook fallback runs only when Gmail is unavailable OR timed out
 * (a second mailbox is a second chance, not a race).
 */
export function resolveNavVerificationWaiter(overrides?: {
  gmailWaiter?: NavVerificationWaiter;
  outlookFetch?: (input: {
    requestedAt: string;
    emailHint: string | null;
  }) => Promise<{ code: string; source: string } | null>;
}): NavVerificationWaiter | null {
  const cfg = getConfig();
  const gmailOn =
    overrides?.gmailWaiter !== undefined ||
    (cfg.gmailVerificationEnabled && readGmailToken() !== null);
  const outlookOn =
    overrides?.outlookFetch !== undefined || cfg.outlookVerificationEnabled;
  if (!gmailOn && !outlookOn) return null;

  const gmailWaiter: NavVerificationWaiter | null = gmailOn
    ? (overrides?.gmailWaiter ??
      (async (need, allowedDomains) => {
        const client = new GmailClient();
        return waitForVerificationEmail({
          client,
          need,
          extraAllowedDomains: allowedDomains,
        });
      }))
    : null;

  const outlookFetch = outlookOn
    ? (overrides?.outlookFetch ?? outlookCodeProvider())
    : null;

  return async (need, allowedDomains) => {
    let pollsUsed = 0;
    if (gmailWaiter) {
      const viaGmail = await gmailWaiter(need, allowedDomains);
      if (viaGmail.kind !== "timeout") return viaGmail;
      pollsUsed += viaGmail.pollsUsed;
    }
    if (outlookFetch) {
      const fetched = await outlookFetch({
        requestedAt: need.requested_at,
        emailHint: need.sent_to || null,
      });
      pollsUsed += 1;
      if (fetched) {
        logger.info("verification code retrieved", {
          service: "verification",
          action: "nav_code",
          metadata: { provider: fetched.source, code_length: fetched.code.length },
        });
        return {
          kind: "code",
          code: fetched.code,
          messageId: `${fetched.source}:mailbox-scan`,
          pollsUsed,
        };
      }
    }
    return { kind: "timeout", pollsUsed };
  };
}
