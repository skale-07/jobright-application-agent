import type { Page } from "playwright";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { GmailClient } from "../gmail/client.js";
import { readGmailToken } from "../gmail/tokenStore.js";
import { waitForVerificationEmail } from "../gmail/waitForVerification.js";
import { extractOtpCode } from "../gmail/verificationParsers.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { outlookSelectorsV1 } from "../outlook/selectors.js";
import { gmailWebCodeProvider } from "./gmailWebProvider.js";

/**
 * Verification-code providers for the submit recovery layer. Both are
 * READ-ONLY mailbox access and both fail closed behind their flags:
 * Gmail via the existing readonly REST client (GMAIL_VERIFICATION_ENABLED),
 * Outlook via the operator's authenticated web session
 * (OUTLOOK_VERIFICATION_ENABLED) — navigation and DOM reads only, never
 * compose/send (sendGuards + check-forbidden discipline unchanged).
 * Codes are transient auth tokens: passed in memory, typed once, never
 * persisted to SQLite/artifacts/logs.
 */

export type FetchVerificationCode = (input: {
  requestedAt: string;
  emailHint: string | null;
}) => Promise<{ code: string; source: string } | null>;

/** Try fetchers in order; the first code wins, all-dry returns null. */
export function chainVerificationCodeProviders(
  fetchers: FetchVerificationCode[],
): FetchVerificationCode {
  return async (input) => {
    for (const fetch of fetchers) {
      const result = await fetch(input);
      if (result) return result;
    }
    return null;
  };
}

/**
 * Every enabled provider, chained: Outlook first (per request), then the
 * Gmail WEB mailbox scan (browser-based — the REST API is unavailable for
 * this operator), then Gmail REST as a last resort when a token exists.
 */
export function resolveVerificationCodeProvider(): FetchVerificationCode | null {
  const cfg = getConfig();
  const fetchers: FetchVerificationCode[] = [];
  if (cfg.outlookVerificationEnabled) fetchers.push(outlookCodeProvider());
  if (cfg.gmailVerificationEnabled) {
    fetchers.push(gmailWebCodeProvider());
    if (readGmailToken()) fetchers.push(gmailCodeProvider());
  }
  return fetchers.length > 0 ? chainVerificationCodeProviders(fetchers) : null;
}

export function gmailCodeProvider(): FetchVerificationCode {
  return async ({ requestedAt, emailHint }) => {
    const token = readGmailToken();
    if (!token) return null;
    const client = new GmailClient();
    const result = await waitForVerificationEmail({
      client,
      need: {
        sent_to: emailHint ?? token.account_email,
        requested_at: requestedAt,
      },
    });
    if (result.kind !== "code") return null;
    return { code: result.code, source: "gmail" };
  };
}

/**
 * Outlook web mailbox scan (registry: outlookSelectorsV1.mail — synthetic,
 * live-UNVERIFIED like the drafts selectors; the acceptance test is a code
 * that actually unlocks the submit control). Bounded: 6 polls × 10s.
 */
export function outlookCodeProvider(): FetchVerificationCode {
  return async ({ requestedAt }) => {
    const cfg = getConfig();
    if (!cfg.outlookVerificationEnabled) return null;
    const session = new PlaywrightServiceSession({
      service: "outlook",
      headless: true,
    });
    try {
      const page = await session.newPage({ purpose: "verification_code_read" });
      for (let poll = 0; poll < 6; poll++) {
        await page.goto("https://outlook.live.com/mail/", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        const code = await readCodeFromMailboxPage(page, {
          requestedAt,
        });
        if (code) {
          logger.info("verification code found in outlook", {
            service: "outlook",
            action: "verification_code",
            metadata: { poll },
          });
          return { code, source: "outlook" };
        }
        await page.waitForTimeout(10_000);
      }
      return null;
    } finally {
      await session.close();
    }
  };
}

/**
 * Scan the currently-open mailbox page for a fresh verification email and
 * extract its OTP with the shared deterministic parser. Extracted so a
 * fixture-served mailbox DOM can prove the scan logic offline.
 */
export async function readCodeFromMailboxPage(
  page: Page,
  options: {
    /** Only messages at or after this instant qualify — never reuse an old code. */
    requestedAt: string;
    maxMessages?: number;
    /** Slack for clock skew between the mail server and this machine. */
    skewMs?: number;
  },
): Promise<string | null> {
  const sel = outlookSelectorsV1.mail;
  const floor =
    new Date(options.requestedAt).getTime() - (options.skewMs ?? 120_000);
  await page
    .waitForSelector(sel.inboxListItem, { timeout: 20_000 })
    .catch(() => undefined);
  const items = page.locator(sel.inboxListItem);
  const count = Math.min(await items.count(), options.maxMessages ?? 8);
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const preview = ((await item.textContent().catch(() => "")) ?? "").slice(0, 400);
    // Only open messages that look verification-ish — never trawl the
    // whole mailbox.
    if (!/verif|code|confirm|security|one[- ]time/i.test(preview)) continue;
    // Drop anything demonstrably older than the request: an expired code
    // typed into the form is worse than no code (it burns the attempt).
    if (Number.isFinite(floor) && isOlderThan(await messageTimestamp(item), floor)) {
      continue;
    }
    await item.click().catch(() => undefined);
    await page.waitForTimeout(800);
    const body = page.locator(sel.readingPaneBody).first();
    const bodyText =
      ((await body.textContent().catch(() => "")) ?? "").slice(0, 20_000);
    const code = extractOtpCode(preview, bodyText);
    if (code) return code;
  }
  return null;
}

/** Outlook stamps list rows with a datetime attribute; absent ⇒ unknown. */
async function messageTimestamp(
  item: ReturnType<Page["locator"]>,
): Promise<number | null> {
  for (const attr of ["data-datetime", "datetime", "title"]) {
    const target = item.locator(`[${attr}]`).first();
    // Bounded: getAttribute auto-waits for the element, and most rows will
    // not carry most of these attributes.
    if ((await target.count().catch(() => 0)) === 0) continue;
    const raw = await target.getAttribute(attr, { timeout: 1000 }).catch(() => null);
    const parsed = raw ? Date.parse(raw) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Unknown timestamps are kept — the OTP parser is the next filter. */
function isOlderThan(timestamp: number | null, floorMs: number): boolean {
  return timestamp !== null && timestamp < floorMs;
}
