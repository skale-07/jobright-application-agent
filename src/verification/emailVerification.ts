import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { GmailClient } from "../gmail/client.js";
import { readGmailToken } from "../gmail/tokenStore.js";
import {
  waitForVerificationEmail,
  type VerificationWaitResult,
} from "../gmail/waitForVerification.js";
import { outlookCodeProvider } from "./codeProviders.js";
import { gmailWebCodeProvider } from "./gmailWebProvider.js";

/**
 * The one nav-time email-verification seam: a portal said "we emailed you
 * a code/link" and Dispatch must retrieve it to continue signing in or
 * creating an account. Providers, in preference order:
 *
 *   1. Gmail REST — only when a saved API token exists (it usually will
 *      not: Google restricts the readonly scope to verified OAuth apps).
 *      The one transport that retrieves magic LINKS (domain-validated).
 *   2. Gmail WEB — read-only Playwright scan of mail.google.com in the
 *      operator's Google-authenticated session (GMAIL_VERIFICATION_ENABLED,
 *      no token needed). Codes only.
 *   3. Outlook — read-only DOM scan of the operator's authenticated web
 *      session (OUTLOOK_VERIFICATION_ENABLED). Codes only.
 *
 * Rendered mailboxes are codes-only because a reading pane cannot be
 * domain-validated as strictly as raw MIME. All fail closed behind their
 * flags; none ever composes or sends (sendGuards discipline unchanged).
 * Codes/links are transient secrets — callers scrub them from anything
 * persisted.
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

/**
 * True when ANY mailbox provider could service a verification wait. The
 * Gmail flag alone is enough: the browser-based mailbox scan needs no API
 * token (the REST API is unavailable for this operator).
 */
export function emailVerificationAvailable(): boolean {
  const cfg = getConfig();
  return cfg.gmailVerificationEnabled || cfg.outlookVerificationEnabled;
}

/**
 * Provider-ordered waiter, or null when nothing is enabled. Gmail first;
 * an Outlook fallback runs only when Gmail is unavailable OR timed out
 * (a second mailbox is a second chance, not a race).
 */
type CodeFetch = (input: {
  requestedAt: string;
  emailHint: string | null;
}) => Promise<{ code: string; source: string } | null>;

export function resolveNavVerificationWaiter(overrides?: {
  gmailWaiter?: NavVerificationWaiter;
  gmailWebFetch?: CodeFetch;
  outlookFetch?: CodeFetch;
}): NavVerificationWaiter | null {
  const cfg = getConfig();
  // Gmail REST rides only when a token exists (the API is unavailable for
  // this operator — the WEB mailbox scan is the primary Gmail transport).
  const gmailRestOn =
    overrides?.gmailWaiter !== undefined ||
    (cfg.gmailVerificationEnabled && readGmailToken() !== null);
  const gmailWebOn =
    overrides?.gmailWebFetch !== undefined || cfg.gmailVerificationEnabled;
  const outlookOn =
    overrides?.outlookFetch !== undefined || cfg.outlookVerificationEnabled;
  if (!gmailRestOn && !gmailWebOn && !outlookOn) return null;

  const gmailWaiter: NavVerificationWaiter | null = gmailRestOn
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

  // Mailbox-scan fallbacks in order: Gmail web first (same account the
  // portal mailed), Outlook second. Codes only — links stay REST-only.
  const scanFetchers: Array<CodeFetch> = [];
  if (gmailWebOn) scanFetchers.push(overrides?.gmailWebFetch ?? gmailWebCodeProvider());
  if (outlookOn) scanFetchers.push(overrides?.outlookFetch ?? outlookCodeProvider());

  return async (need, allowedDomains) => {
    let pollsUsed = 0;
    if (gmailWaiter) {
      const viaGmail = await gmailWaiter(need, allowedDomains);
      if (viaGmail.kind !== "timeout") return viaGmail;
      pollsUsed += viaGmail.pollsUsed;
    }
    for (const fetch of scanFetchers) {
      const fetched = await fetch({
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
