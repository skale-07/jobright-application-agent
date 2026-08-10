import type { Page } from "playwright";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { extractOtpCode } from "../gmail/verificationParsers.js";
import { gmailWebSelectorsV1 } from "../gmail/webSelectors.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import type { FetchVerificationCode } from "./codeProviders.js";

/** Local CDP probe (duplicated from the nav layer to avoid an import cycle). */
async function cdpReachable(cdpUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(new URL("/json/version", cdpUrl), {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Gmail verification via the BROWSER, not the API: the operator's Gmail
 * REST access is unavailable (Google restricts the readonly scope to
 * verified OAuth apps), so this provider reads mail.google.com through the
 * same Google-authenticated session JobRight login already established —
 * the operator's CDP debug Chrome when reachable, the saved jobright
 * storage state otherwise. Read-only: navigation and DOM reads, codes
 * extracted by the shared deterministic parser, nothing composed, nothing
 * persisted. Codes only (no magic links): a rendered mailbox cannot be
 * domain-validated as strictly as raw MIME.
 */

const GMAIL_URL = "https://mail.google.com/mail/u/0/";

/**
 * Scan the currently-open Gmail inbox page for a fresh verification email
 * and extract its OTP. Mirrors the Outlook reader: verification-ish rows
 * only, freshness floor against the request instant, shared OTP parser.
 * Extracted so a fixture-served Gmail DOM proves the scan logic offline.
 */
export async function readCodeFromGmailInboxPage(
  page: Page,
  options: {
    /** Only messages at or after this instant qualify — never reuse an old code. */
    requestedAt: string;
    maxMessages?: number;
    /** Slack for clock skew between the mail server and this machine. */
    skewMs?: number;
  },
): Promise<string | null> {
  const sel = gmailWebSelectorsV1.mail;
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
    // Only open messages that look verification-ish — never trawl the mailbox.
    if (!/verif|code|confirm|security|one[- ]time/i.test(preview)) continue;
    // Drop anything demonstrably older than the request: an expired code
    // typed into a form burns the attempt.
    if (Number.isFinite(floor) && isOlderThan(await rowTimestamp(item), floor)) {
      continue;
    }
    await item.click().catch(() => undefined);
    await page.waitForTimeout(800);
    const body = page.locator(sel.readingPaneBody).first();
    const bodyText =
      ((await body.textContent().catch(() => "")) ?? "").slice(0, 20_000);
    const code = extractOtpCode(preview, bodyText);
    if (code) return code;
    // Back to the list for the next candidate (in-page for split panes;
    // history-back covers full-page opens).
    await page.goBack().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  return null;
}

/** Gmail stamps rows with a full datetime in span[title]; absent ⇒ unknown. */
async function rowTimestamp(
  item: ReturnType<Page["locator"]>,
): Promise<number | null> {
  const attr = gmailWebSelectorsV1.mail.rowTimestampAttr;
  const target = item.locator(`span[${attr}]`).last();
  if ((await target.count().catch(() => 0)) === 0) return null;
  const raw = await target.getAttribute(attr, { timeout: 1000 }).catch(() => null);
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Unknown timestamps are kept — the OTP parser is the next filter. */
function isOlderThan(timestamp: number | null, floorMs: number): boolean {
  return timestamp !== null && timestamp < floorMs;
}

/**
 * Bounded mailbox poll (6 × 10s), flag-gated by GMAIL_VERIFICATION_ENABLED.
 * Session preference: the operator's CDP debug Chrome (already
 * Google-signed-in for JobRight) when its endpoint answers, else the saved
 * jobright storage state headless.
 */
export function gmailWebCodeProvider(): FetchVerificationCode {
  return async ({ requestedAt }) => {
    const cfg = getConfig();
    if (!cfg.gmailVerificationEnabled) return null;
    const useCdp = await cdpReachable(cfg.agentCdpUrl);
    const session = new PlaywrightServiceSession({
      service: "jobright",
      ...(useCdp ? { mode: "CDP_ATTACH" as const } : {}),
      headless: true,
    });
    try {
      await session.open();
      const page = await session.newPage({ purpose: "gmail_code_read" });
      for (let poll = 0; poll < 6; poll++) {
        await page.goto(GMAIL_URL, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        const code = await readCodeFromGmailInboxPage(page, { requestedAt });
        if (code) {
          logger.info("verification code found in gmail (web)", {
            service: "gmail",
            action: "verification_code_web",
            metadata: { poll, session: useCdp ? "cdp" : "storage_state" },
          });
          return { code, source: "gmail-web" };
        }
        await page.waitForTimeout(10_000);
      }
      return null;
    } catch (err) {
      logger.warn("gmail web mailbox scan failed", {
        service: "gmail",
        action: "verification_code_web_error",
        metadata: {
          reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
        },
      });
      return null;
    } finally {
      await session.close().catch(() => undefined);
    }
  };
}
