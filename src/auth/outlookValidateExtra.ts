import type { Page } from "playwright";
import type { AuthValidationResult } from "./types.js";

/**
 * Work/school (and most modern personal M365) Outlook on the web.
 * `outlook.live.com/mail/` often redirects unsigned or half-signed
 * sessions to the microsoft.com marketing page with a /mail/ deeplink —
 * that is NOT the inbox (live operator failure 2026-08-12, jh.edu).
 */
export const OUTLOOK_WEB_MAIL_URL = "https://outlook.office.com/mail/";
export const OUTLOOK_WEB_DRAFTS_URL = "https://outlook.office.com/mail/drafts";

function isOutlookMailHost(hostname: string): boolean {
  return (
    /(^|\.)outlook\.office\.com$/i.test(hostname) ||
    /(^|\.)outlook\.office365\.com$/i.test(hostname) ||
    /(^|\.)outlook\.live\.com$/i.test(hostname)
  );
}

/**
 * Reject the microsoft.com product marketing page (and similar) that
 * storageState/persistent sessions land on when /mail wasn't actually
 * reached. Pattern-only URL checks miss this because it's not a login host.
 */
export function assessOutlookAuthUrl(url: string): AuthValidationResult | null {
  const checkedAt = new Date().toISOString();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      status: "UNAUTHENTICATED",
      url,
      reason: "Outlook page URL is not parseable",
      checkedAt,
    };
  }
  const host = parsed.hostname;
  if (/(^|\.)microsoft\.com$/i.test(host)) {
    return {
      ok: false,
      status: "UNAUTHENTICATED",
      url,
      reason:
        "Landed on microsoft.com marketing (not Outlook mail). Re-run login:outlook against outlook.office.com/mail/ and finish until the inbox is visible.",
      checkedAt,
    };
  }
  if (!isOutlookMailHost(host)) {
    return {
      ok: false,
      status: "UNAUTHENTICATED",
      url,
      reason: `Not on an Outlook mail host (got ${host})`,
      checkedAt,
    };
  }
  if (!/\/mail(\/|$)/i.test(parsed.pathname) && !/\/owa(\/|$)/i.test(parsed.pathname)) {
    return {
      ok: false,
      status: "UNAUTHENTICATED",
      url,
      reason: "Outlook host without /mail (or /owa) path — inbox not reached",
      checkedAt,
    };
  }
  return null;
}

export async function validateOutlookAuthExtra(
  page: Page,
): Promise<AuthValidationResult | null> {
  return assessOutlookAuthUrl(page.url());
}
