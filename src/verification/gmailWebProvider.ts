import type { Page } from "playwright";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { extractMagicLink, extractOtpCode } from "../gmail/verificationParsers.js";
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
 * storage state otherwise. Read-only: navigation and DOM reads, codes and
 * links extracted by the shared deterministic parsers, nothing composed,
 * nothing persisted. Sender trust is the gate for links (the message
 * already passed freshness + verification filters); what a link resolves
 * to is still judged downstream by congruence + final-URL validation.
 */

const GMAIL_URL = "https://mail.google.com/mail/u/0/";

export type MailboxVerificationHit =
  | { kind: "code"; value: string }
  | { kind: "link"; value: string };

type ScanOptions = {
  /** Only messages at or after this instant qualify — never reuse an old code. */
  requestedAt: string;
  maxMessages?: number;
  /** Slack for clock skew between the mail server and this machine. */
  skewMs?: number;
  /** "code" (submit recovery) or "code_or_link" (nav walls). */
  accept?: "code" | "code_or_link";
  /**
   * Poll loop only: drop rows with no parseable datetime. Unknown
   * timestamps used to count as fresh, so the previous sandbox OTP was
   * typed while the new mail was still in flight.
   */
  requireProvenFresh?: boolean;
};

type RankedHit = {
  hit: MailboxVerificationHit;
  timestamp: number | null;
  index: number;
};

function freshnessFloor(options: ScanOptions): number {
  return new Date(options.requestedAt).getTime() - (options.skewMs ?? 120_000);
}

/**
 * Scan the currently-open Gmail inbox page for a fresh verification email
 * and extract its OTP — or, in "code_or_link" mode, its verification link
 * when no code exists (magic-link flows). Verification-ish rows only,
 * freshness floor against the request instant, shared deterministic
 * parsers. Extracted so a fixture-served Gmail DOM proves the scan logic
 * offline.
 */
export async function scanGmailInboxForVerification(
  page: Page,
  options: ScanOptions,
): Promise<MailboxVerificationHit | null> {
  const ranked = await rankGmailInboxHits(page, options);
  return ranked?.hit ?? null;
}

/**
 * Walk every verification-ish row (cap 8) and pick the newest remaining
 * mail. Live 2026-08-16: first-match returned 389820 (previous sandbox
 * run) while 392556 had just been mailed — Gmail list order is usually
 * newest-first, but an old row with no parseable timestamp used to
 * qualify immediately and abort the poll.
 */
async function rankGmailInboxHits(
  page: Page,
  options: ScanOptions,
): Promise<RankedHit | null> {
  const sel = gmailWebSelectorsV1.mail;
  const accept = options.accept ?? "code";
  const floor = freshnessFloor(options);
  await page
    .waitForSelector(sel.inboxListItem, { timeout: 20_000 })
    .catch(() => undefined);
  const items = page.locator(sel.inboxListItem);
  const count = Math.min(await items.count(), options.maxMessages ?? 8);
  const found: RankedHit[] = [];
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const preview = ((await item.textContent().catch(() => "")) ?? "").slice(0, 400);
    if (!/verif|code|confirm|security|one[- ]time|magic|sign[- ]?in link/i.test(preview)) {
      continue;
    }
    const timestamp = await rowTimestamp(item);
    if (Number.isFinite(floor) && isOlderThan(timestamp, floor)) continue;
    if (options.requireProvenFresh && !isProvenFresh(timestamp, floor)) continue;
    let hit: MailboxVerificationHit | null = null;
    // Never take the OTP from the inbox snippet: Gmail conversation
    // rows keep showing the FIRST message's preview. Open the thread
    // and read every message body — newest is last in the DOM.
    await item.click().catch(() => undefined);
    await page.waitForTimeout(800);
    const panes = page.locator(sel.readingPaneBody);
    const bodies = (await panes.allTextContents().catch(() => []))
      .map((t) => t.slice(0, 8_000))
      .join("\n");
    const bodyText = bodies.slice(0, 20_000);
    const code = extractOtpCode("", bodyText);
    if (code) hit = { kind: "code", value: code };
    else if (accept === "code_or_link") {
      const last = panes.last();
      const hrefs = (await last
        .locator("a[href^='https://']")
        .evaluateAll((els: Array<{ getAttribute: (n: string) => string | null }>) =>
          els.map((el) => el.getAttribute("href") ?? ""),
        )
        .catch(() => [] as string[])) as string[];
      const sender =
        (await page
          .locator("[email]")
          .first()
          .getAttribute("email", { timeout: 1000 })
          .catch(() => null)) ?? undefined;
      const link = extractMagicLink(
        [...hrefs.slice(0, 40), bodyText].join("\n"),
        sender !== undefined ? { senderAddress: sender } : {},
      );
      if (link) hit = { kind: "link", value: link };
    }
    await page.goBack().catch(() => undefined);
    await page.waitForTimeout(400);
    if (hit) found.push({ hit, timestamp, index: i });
  }
  if (found.length === 0) return null;
  const dated = found.filter((c) => c.timestamp !== null);
  if (dated.length > 0) {
    dated.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return dated[0]!;
  }
  found.sort((a, b) => a.index - b.index);
  return found[0]!;
}

/** Codes-only wrapper (submit recovery + existing tests). */
export async function readCodeFromGmailInboxPage(
  page: Page,
  options: { requestedAt: string; maxMessages?: number; skewMs?: number },
): Promise<string | null> {
  const hit = await scanGmailInboxForVerification(page, {
    ...options,
    accept: "code",
  });
  return hit?.kind === "code" ? hit.value : null;
}

/**
 * Gmail stamps a datetime in span[title]; the same row has many other
 * titles (star, important, …). Parse every title and take the latest
 * parseable instant — `.last()` used to grab a non-datetime and treat
 * the row as undated/fresh.
 */
async function rowTimestamp(
  item: ReturnType<Page["locator"]>,
): Promise<number | null> {
  const attr = gmailWebSelectorsV1.mail.rowTimestampAttr;
  const titles = await item
    .locator(`span[${attr}]`)
    .evaluateAll((els: Array<{ getAttribute: (n: string) => string | null }>) =>
      els.map((el) => el.getAttribute("title") ?? ""),
    )
    .catch(() => [] as string[]);
  const parsed = titles
    .map((raw) => parseMailboxTimestamp(raw))
    .filter((t): t is number => t !== null);
  if (parsed.length === 0) return null;
  return Math.max(...parsed);
}

/** ISO first; Gmail recent rows often only title "1:31 PM". */
function parseMailboxTimestamp(raw: string, nowMs = Date.now()): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const abs = Date.parse(trimmed);
  if (Number.isFinite(abs)) return abs;
  const tod = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(trimmed);
  if (!tod) return null;
  let hours = Number(tod[1]);
  const minutes = Number(tod[2]);
  const seconds = Number(tod[3] ?? 0);
  const ap = tod[4]!.toUpperCase();
  if (ap === "PM" && hours < 12) hours += 12;
  if (ap === "AM" && hours === 12) hours = 0;
  const d = new Date(nowMs);
  d.setHours(hours, minutes, seconds, 0);
  let t = d.getTime();
  if (t > nowMs + 5 * 60_000) t -= 24 * 60 * 60_000;
  return t;
}

function isOlderThan(timestamp: number | null, floorMs: number): boolean {
  return timestamp !== null && timestamp < floorMs;
}

function isProvenFresh(timestamp: number | null, floorMs: number): boolean {
  return timestamp !== null && timestamp >= floorMs;
}

/**
 * Bounded mailbox poll (6 × 10s), flag-gated by GMAIL_VERIFICATION_ENABLED.
 * Session preference: the operator's CDP debug Chrome (already
 * Google-signed-in for JobRight) when its endpoint answers, else the saved
 * jobright storage state headless.
 */
async function pollGmailWeb(
  requestedAt: string,
  accept: "code" | "code_or_link",
  headless = true,
): Promise<MailboxVerificationHit | null> {
  const cfg = getConfig();
  if (!cfg.gmailVerificationEnabled) return null;
  const useCdp = await cdpReachable(cfg.agentCdpUrl);
  // CDP attach ignores headless (operator Chrome is already visible).
  // STORAGE_STATE launches honor headless for smoke-test visibility.
  const session = new PlaywrightServiceSession({
    service: "jobright",
    ...(useCdp ? { mode: "CDP_ATTACH" as const } : {}),
    headless: useCdp ? true : headless,
  });
  try {
    await session.open();
    const page = await session.newPage({ purpose: "gmail_code_read" });
    const floor = freshnessFloor({ requestedAt, accept });
    for (let poll = 0; poll < 6; poll++) {
      await page.goto(GMAIL_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const ranked = await rankGmailInboxHits(page, {
        requestedAt,
        accept,
        requireProvenFresh: true,
      });
      // A code with no parseable date is usually the PREVIOUS sandbox
      // mail still sitting at the top of the inbox. Keep polling until a
      // row dated at/after the request shows up.
      if (ranked && isProvenFresh(ranked.timestamp, floor)) {
        logger.info(`verification ${ranked.hit.kind} found in gmail (web)`, {
          service: "gmail",
          action: "verification_code_web",
          metadata: {
            poll,
            kind: ranked.hit.kind,
            session: useCdp ? "cdp" : "storage_state",
          },
        });
        return ranked.hit;
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
}

export function gmailWebCodeProvider(options?: {
  headless?: boolean;
}): FetchVerificationCode {
  const headless = options?.headless ?? true;
  return async ({ requestedAt }) => {
    const hit = await pollGmailWeb(requestedAt, "code", headless);
    return hit?.kind === "code" ? { code: hit.value, source: "gmail-web" } : null;
  };
}

/** Nav-wall variant: codes AND magic links (verified-sender trust). */
export function gmailWebNavFetch(options?: {
  headless?: boolean;
}): (input: {
  requestedAt: string;
  emailHint: string | null;
}) => Promise<(MailboxVerificationHit & { source: string }) | null> {
  const headless = options?.headless ?? true;
  return async ({ requestedAt }) => {
    const hit = await pollGmailWeb(requestedAt, "code_or_link", headless);
    return hit ? { ...hit, source: "gmail-web" } : null;
  };
}
