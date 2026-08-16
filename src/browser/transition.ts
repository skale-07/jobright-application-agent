import type { Locator, Page } from "playwright";
import { dismissPageObstructions } from "./obstructions.js";
import { classifyPage, type PageClassification } from "../ats/shared/pageClassify.js";

/**
 * The ONE way to click something that should take the flow somewhere else.
 *
 * Before this primitive, every page-to-page hop was an ad-hoc
 * click-plus-sleep: portal auth used 800ms floors, the wizard walk grew
 * its own change-detection, Apply clicks had bespoke popup promises — six
 * approximations of the same behavior, each with its own failure mode
 * (sleeps racing SPAs, stale snapshots, silent no-op clicks, flows
 * stranded when the click opened a new tab).
 *
 * performTransition does the whole dance once, tested:
 *   snapshot → (optional) obstruction sweep → scroll into view → arm a
 *   popup listener → click → bounded change-detection poll (URL change,
 *   DOM change, or a caller-supplied ready marker) → one retry on a
 *   silent no-op → adopt the popup if the click opened one → classify the
 *   landing page.
 *
 * It never decides POLICY: whether an "auth" landing is fine, whether a
 * popup should be kept — callers judge the returned facts. settleTimeoutMs
 * of 0 keeps synchronous fixtures synchronous (single immediate check, no
 * polling) so tests stay fast.
 */
export type TransitionResult = {
  /** The page (or adopted popup) differs from the pre-click state. */
  landed: boolean;
  /** Where the flow should CONTINUE: the popup when one was adopted. */
  page: Page;
  adopted_popup: boolean;
  classification: PageClassification;
  url: string;
  html: string;
  retried: boolean;
  elapsed_ms: number;
  notes: string[];
};

export type TransitionOptions = {
  /** Max ms to wait for the page to change. 0 = one immediate check. */
  settleTimeoutMs?: number;
  /** Landing counts as settled once this matches (plus a DOM change). */
  readyMarker?: RegExp;
  /** Sweep cookie/promo obstructions before clicking (default false —
   * only callers already inside a mutation gate should turn it on). */
  sweepObstructions?: boolean;
  /** Re-click once if the first click changed nothing (default true). */
  retryOnUnchanged?: boolean;
  /** Adopt a popup the click opens and continue there (default true). */
  adoptPopups?: boolean;
  /** Per-ATS confirmation markers forwarded to classifyPage. */
  confirmationMarkers?: RegExp;
};

const POLL_MS = 200;

export async function performTransition(
  page: Page,
  target: Locator,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  const started = Date.now();
  const notes: string[] = [];
  const settleTimeoutMs = options.settleTimeoutMs ?? 10_000;
  const retryOnUnchanged = options.retryOnUnchanged ?? true;
  const adoptPopups = options.adoptPopups ?? true;

  if (options.sweepObstructions) {
    const swept = await dismissPageObstructions(page).catch(() => null);
    if (swept && swept.dismissed.length > 0) {
      notes.push(`obstructions dismissed before click: ${swept.dismissed.join(", ")}`);
    }
  }

  const preHtml = await page.content().catch(() => "");
  const preUrl = page.url();

  let popup: Page | null = null;
  const popupListener = (p: Page): void => {
    popup = p;
  };
  if (adoptPopups) page.context().on("page", popupListener);

  const clickOnce = async (attempt: number): Promise<void> => {
    await target.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    await target.click({ timeout: 10_000 }).catch((e: Error) => {
      notes.push(`click attempt ${attempt} failed: ${e.message.slice(0, 100)}`);
    });
  };

  const settled = async (): Promise<{ changed: boolean; html: string }> => {
    const deadline = Date.now() + settleTimeoutMs;
    for (;;) {
      const html = await page.content().catch(() => "");
      const changed =
        page.url() !== preUrl ||
        (html !== preHtml &&
          (options.readyMarker === undefined || options.readyMarker.test(html)));
      if (changed || popup !== null) return { changed, html };
      if (Date.now() >= deadline) return { changed: false, html };
      await page.waitForTimeout(POLL_MS);
    }
  };

  try {
    await clickOnce(1);
    await page
      .waitForLoadState("domcontentloaded", { timeout: 15_000 })
      .catch(() => undefined);
    let { changed, html } = await settled();
    let retried = false;

    if (!changed && popup === null && retryOnUnchanged) {
      retried = true;
      notes.push("no page change after click — one retry (sweep + scroll + re-click)");
      const swept = await dismissPageObstructions(page).catch(() => null);
      if (swept && swept.dismissed.length > 0) {
        notes.push(`obstructions dismissed on retry: ${swept.dismissed.join(", ")}`);
      }
      await clickOnce(2);
      ({ changed, html } = await settled());
    }

    // A popup with a real document IS the landing — the flow continues
    // there (some ATSes open their form in a new window; the old code
    // stranded the runner on the launcher page).
    const adopted = popup as Page | null;
    if (adopted !== null) {
      // window.open('') reports about:blank until the opener assigns
      // location (navhard 1200ms delay; JobRight interstitial). Reading
      // the URL immediately closed the tab and stranded the fill on the
      // posting. Navigation already waits (settledPopupUrl); this is the
      // same wait on the fill hop.
      let popupUrl = adopted.url();
      if ((!popupUrl || popupUrl === "about:blank") && settleTimeoutMs > 0) {
        await adopted
          .waitForURL((u) => u.toString() !== "about:blank", {
            timeout: settleTimeoutMs,
          })
          .catch(() => undefined);
        popupUrl = adopted.url();
        if (popupUrl && popupUrl !== "about:blank") {
          notes.push("popup settled off about:blank after the interstitial");
        }
      }
      if (popupUrl && popupUrl !== "about:blank") {
        await adopted
          .waitForLoadState("domcontentloaded", { timeout: 10_000 })
          .catch(() => undefined);
        const popupHtml = await adopted.content().catch(() => "");
        notes.push(`click opened a tab — flow adopted ${popupUrl}`);
        return {
          landed: true,
          page: adopted,
          adopted_popup: true,
          classification: classifyPage({
            html: popupHtml,
            url: popupUrl,
            ...(options.confirmationMarkers
              ? { confirmationMarkers: options.confirmationMarkers }
              : {}),
          }),
          url: popupUrl,
          html: popupHtml,
          retried,
          elapsed_ms: Date.now() - started,
          notes,
        };
      }
      notes.push("click opened a tab that never left about:blank — ignored");
      await adopted.close().catch(() => undefined);
    }

    return {
      landed: changed,
      page,
      adopted_popup: false,
      classification: classifyPage({
        html,
        url: page.url(),
        ...(options.confirmationMarkers
          ? { confirmationMarkers: options.confirmationMarkers }
          : {}),
      }),
      url: page.url(),
      html,
      retried,
      elapsed_ms: Date.now() - started,
      notes,
    };
  } finally {
    if (adoptPopups) page.context().off("page", popupListener);
  }
}
