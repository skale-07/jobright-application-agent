import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { GmailClient } from "../gmail/client.js";
import { readGmailToken } from "../gmail/tokenStore.js";
import {
  waitForVerificationEmail,
  type VerificationWaitResult,
} from "../gmail/waitForVerification.js";
import { outlookCodeProvider } from "./codeProviders.js";
import {
  gmailWebNavFetch,
  type MailboxVerificationHit,
} from "./gmailWebProvider.js";

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
 *      no token needed). Codes AND magic links: sender trust + freshness
 *      gate the link (tracking-domain wrappers are legitimate); where a
 *      link lands is still judged by congruence + final-URL validation.
 *   3. Outlook — read-only DOM scan of the operator's authenticated web
 *      session (OUTLOOK_VERIFICATION_ENABLED). Codes.
 *
 * All fail closed behind their flags; none ever composes or sends
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
/** A mailbox-scan fetch: code or magic link, from a verified-fresh email. */
type ScanFetch = (input: {
  requestedAt: string;
  emailHint: string | null;
}) => Promise<(MailboxVerificationHit & { source: string }) | null>;

/**
 * Which mailbox to scan FIRST for a code sent to `email`. The address the
 * site mailed is the evidence: an @outlook/@hotmail/@live address means
 * the code is in Outlook, and opening Gmail first just burns a minute of
 * polling on the wrong inbox (live 2026-08-12). Unknown domains keep the
 * historical order.
 */
export function mailboxProviderOrder(
  email: string | null,
): Array<"gmail" | "outlook"> {
  const domain = (email ?? "").toLowerCase().split("@")[1] ?? "";
  if (/(^|\.)(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) {
    return ["outlook", "gmail"];
  }
  if (/(^|\.)(gmail|googlemail)\.com$/.test(domain)) {
    return ["gmail", "outlook"];
  }
  return ["gmail", "outlook"];
}

export function resolveNavVerificationWaiter(overrides?: {
  gmailWaiter?: NavVerificationWaiter;
  gmailWebFetch?: ScanFetch;
  outlookFetch?: ScanFetch;
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

  // Mailbox-scan providers. Gmail web reads codes AND magic links; Outlook
  // reads codes. Which one runs FIRST is decided per-request by the
  // address the site actually mailed (see mailboxProviderOrder) — a
  // hardcoded Gmail-first chain opened the wrong mailbox for an operator
  // whose portal login is an Outlook address (live 2026-08-12).
  const gmailFetch: ScanFetch | null = gmailWebOn
    ? (overrides?.gmailWebFetch ?? gmailWebNavFetch())
    : null;
  const outlookFetch: ScanFetch | null = outlookOn
    ? (overrides?.outlookFetch ??
      (async (input) => {
        const fetched = await outlookCodeProvider()(input);
        return fetched
          ? { kind: "code", value: fetched.code, source: fetched.source }
          : null;
      }))
    : null;

  return async (need, allowedDomains) => {
    let pollsUsed = 0;
    if (gmailWaiter) {
      const viaGmail = await gmailWaiter(need, allowedDomains);
      if (viaGmail.kind !== "timeout") return viaGmail;
      pollsUsed += viaGmail.pollsUsed;
    }
    const order = mailboxProviderOrder(
      need.sent_to || getConfig().portalLoginEmail || null,
    );
    const scanFetchers = order
      .map((name) => (name === "gmail" ? gmailFetch : outlookFetch))
      .filter((f): f is ScanFetch => f !== null);
    for (const fetch of scanFetchers) {
      const hit = await fetch({
        requestedAt: need.requested_at,
        emailHint: need.sent_to || null,
      });
      pollsUsed += 1;
      if (hit) {
        logger.info(`verification ${hit.kind} retrieved`, {
          service: "verification",
          action: "nav_code",
          metadata: { provider: hit.source, kind: hit.kind },
        });
        return hit.kind === "code"
          ? {
              kind: "code",
              code: hit.value,
              messageId: `${hit.source}:mailbox-scan`,
              pollsUsed,
            }
          : {
              kind: "link",
              url: hit.value,
              messageId: `${hit.source}:mailbox-scan`,
              pollsUsed,
            };
      }
    }
    return { kind: "timeout", pollsUsed };
  };
}
