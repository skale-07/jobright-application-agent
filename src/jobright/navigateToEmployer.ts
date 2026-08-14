import type { Locator, Page } from "playwright";
import type { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { jobrightSelectorsV1 } from "./selectors/v1.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { assertNavigationAllowed } from "../navigation/navigationGuards.js";
import { dismissPageObstructions } from "../browser/obstructions.js";

/**
 * Page-level primitives for resolving the employer application URL from a
 * JobRight job-detail page. Orchestration (session, phases, walls,
 * artifacts) lives in src/navigation/runNavigation.ts.
 */

/**
 * Phase A — zero mutation: read the hrefs of external apply anchors
 * (previously only counted by controlVisibility). ATS-shaped URLs first
 * for ordering only — acceptance is congruence, not a host allowlist.
 */
export async function readExternalApplyHrefs(page: Page): Promise<string[]> {
  const collect = async (selector: string): Promise<string[]> =>
    (await page
      .locator(selector)
      .evaluateAll((els: Array<{ getAttribute: (n: string) => string | null }>) =>
        els.map((el) => el.getAttribute("href") ?? ""),
      )
      .catch(() => [] as string[])) as string[];

  const cta = await readAutofillCtaHref(page);
  const ats = await collect(jobrightSelectorsV1.navigation.externalAtsAnchors);
  const any = await collect(jobrightSelectorsV1.navigation.externalAnyAnchor);

  const seen = new Set<string>();
  const wellFormed: string[] = [];
  for (const href of [...(cta ? [cta] : []), ...ats, ...any]) {
    const trimmed = href.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "https:") continue;
      if (/(^|\.)jobright\.ai$/i.test(u.hostname)) continue;
      wellFormed.push(trimmed);
    } catch {
      // relative or malformed — not an external apply link
    }
  }
  return wellFormed.sort((a, b) => {
    const aKnown = detectAtsFromUrl(a).ats !== null ? 0 : 1;
    const bKnown = detectAtsFromUrl(b).ats !== null ? 0 : 1;
    return aKnown - bKnown;
  });
}

/**
 * Zero-mutation read of the primary "APPLY WITH AUTOFILL ↗" CTA's link.
 * Operator finding (2026-08-11): this CTA carries the external application
 * URL — it had been excluded as "JobRight's own flow" while phases A/B
 * hunted the rest of the page. Checks the control itself and its closest
 * anchor; returns an https non-jobright URL or null.
 */
export async function readAutofillCtaHref(page: Page): Promise<string | null> {
  const namePattern = jobrightSelectorsV1.navigation.autofillApplyCta;
  for (const role of ["link", "button"] as const) {
    const cta = page.getByRole(role, { name: namePattern }).first();
    if ((await cta.count().catch(() => 0)) === 0) continue;
    const href = await cta
      .evaluate((el: { closest: (s: string) => { getAttribute: (n: string) => string | null } | null }) =>
        el.closest("a")?.getAttribute("href") ?? null,
      )
      .catch(() => null);
    if (!href) continue;
    try {
      const u = new URL(href, "https://jobright.ai");
      if (u.protocol === "https:" && !/(^|\.)jobright\.ai$/i.test(u.hostname)) {
        return u.href;
      }
    } catch {
      // malformed — fall through
    }
  }
  return null;
}

/**
 * Zero-mutation check: does the JobRight page say the posting is closed?
 * Operator finding (2026-08-12) — a closed posting burned the full phase
 * B + agent budget (minutes) before parking. Reading the banner ends it in
 * one DOM read. Scoped to the page's own text (not link titles) and
 * anchored on JobRight's own wording.
 */
export async function detectClosedJobBanner(page: Page): Promise<boolean> {
  const text = await page
    .innerText("body", { timeout: 5_000 })
    .then((t) => t.slice(0, 4_000))
    .catch(() => "");
  return jobrightSelectorsV1.navigation.closedJobMarkers.test(text);
}

/**
 * JobRight's "Customize Your Resume in 10 seconds" modal. The skip control
 * is often a styled text link, not a role=button — role search first, then
 * exact visible text. Never returns "Fix My Resume Now".
 */
export async function findJobRightInterstitialProceed(
  page: Page,
): Promise<Locator | null> {
  for (const name of jobrightSelectorsV1.navigation.interstitialProceedNames) {
    for (const role of ["button", "link"] as const) {
      const control = page.getByRole(role, { name }).first();
      if ((await control.count().catch(() => 0)) === 0) continue;
      if (!(await control.isVisible().catch(() => false))) continue;
      return control;
    }
    const byText = page.getByText(name).first();
    if ((await byText.count().catch(() => 0)) === 0) continue;
    if (!(await byText.isVisible().catch(() => false))) continue;
    return byText;
  }
  return null;
}

/**
 * Close JobRight's own modals ("Did you apply?"). Only the CLOSE control is
 * ever clicked — the modal's buttons are answers about the operator's
 * application state, which this system must never assert on their behalf.
 * Customize-resume interstitials are PROCEEDED, never X-closed.
 */
export async function clearJobRightInterstitial(
  page: Page,
): Promise<{ cleared: "proceeded" | "closed" | null; note: string | null }> {
  // PROCEED first: an interstitial offering "Apply Without Customizing"
  // wants a decision, and continuing is the decision the operator already
  // made by queuing the application. Closing it can drop the flow back to
  // the job page with nothing accomplished.
  const proceed = await findJobRightInterstitialProceed(page);
  if (proceed) {
    await proceed.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    return {
      cleared: "proceeded",
      note: 'jobright interstitial: clicked "Apply Without Customizing"',
    };
  }
  if (await dismissJobRightModal(page)) {
    return { cleared: "closed", note: "jobright modal closed (X)" };
  }
  return { cleared: null, note: null };
}

export async function dismissJobRightModal(page: Page): Promise<boolean> {
  const closer = page
    .locator(jobrightSelectorsV1.navigation.modalCloseControl)
    .first();
  if ((await closer.count().catch(() => 0)) === 0) return false;
  if (!(await closer.isVisible().catch(() => false))) return false;
  await closer.click({ timeout: 3_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  return true;
}

export type ApplyClickCapture = {
  url: string | null;
  via: "popup" | "same_tab" | null;
  clicks: number;
  notes: string[];
  /** Landing-page HTML/title so the caller can classify walls before trusting the URL. */
  landingHtml: string | null;
  landingTitle: string | null;
};

/**
 * Tiered Apply-control lookup. Tier 1: exact-ish name ("Apply", "Apply
 * now"). Tier 2: any button/link whose accessible name contains "apply",
 * minus the exclusions (JobRight's own "Apply with Autofill", past-tense
 * "Applied", "Easy Apply"). Live runs proved tier 1 alone misses real
 * controls — the agent phase then thrashed on a page a click could solve.
 */
async function findApplyControl(
  page: Page,
  options: { includeAutofillCta: boolean } = { includeAutofillCta: true },
): Promise<{ target: ReturnType<Page["locator"]>; tier: 0 | 1 | 2 } | null> {
  const { standardApplyRole, broadApplyRole, applyNameExclusions, autofillApplyCta } =
    jobrightSelectorsV1.navigation;

  // Tier 0 — the page's primary CTA. Its href is read zero-mutation in
  // phase A; here it is the FIRST click target because it is the one
  // control JobRight guarantees leads toward the application.
  if (options.includeAutofillCta) {
    for (const role of ["button", "link"] as const) {
      const cta = page.getByRole(role, { name: autofillApplyCta }).first();
      if (
        (await cta.count().catch(() => 0)) > 0 &&
        (await cta.isVisible().catch(() => false))
      ) {
        return { target: cta, tier: 0 };
      }
    }
  }

  for (const role of ["button", "link"] as const) {
    const exact = page.getByRole(role, { name: standardApplyRole }).first();
    if ((await exact.count().catch(() => 0)) > 0) return { target: exact, tier: 1 };
  }
  for (const role of ["button", "link"] as const) {
    const candidates = await page
      .getByRole(role, { name: broadApplyRole })
      .all()
      .catch(() => []);
    for (const candidate of candidates.slice(0, 10)) {
      let name = ((await candidate.textContent().catch(() => null)) ?? "").trim();
      if (!name) {
        name = (
          (await candidate.getAttribute("aria-label").catch(() => null)) ?? ""
        ).trim();
      }
      if (!name || applyNameExclusions.test(name)) continue;
      return { target: candidate, tier: 2 };
    }
  }
  return null;
}

/** How long a freshly-opened tab may sit on about:blank before we give up. */
export const POPUP_SETTLE_TIMEOUT_MS = 15_000;

/**
 * Read a popup's URL once it has left about:blank. A tab opened by
 * `window.open()` reports about:blank until the opener assigns its location,
 * which JobRight does asynchronously — often only after the interstitial is
 * answered. Returns the settled URL, or "about:blank" if it never navigated.
 */
export async function settledPopupUrl(
  popup: Page,
  notes: string[],
  timeoutMs: number = POPUP_SETTLE_TIMEOUT_MS,
): Promise<string> {
  const immediate = popup.url();
  if (immediate && immediate !== "about:blank") return immediate;
  await popup
    .waitForURL((u) => u.toString() !== "about:blank", { timeout: timeoutMs })
    .catch(() => undefined);
  const settled = popup.url();
  if (settled && settled !== "about:blank") {
    notes.push("popup settled off about:blank after the interstitial");
  }
  return settled;
}

async function resolveExternalCapture(
  page: Page,
  armed: {
    popupPromise: Promise<Page | null>;
    sameTabPromise: Promise<boolean>;
  },
  attempt: number,
  notes: string[],
): Promise<ApplyClickCapture | null> {
  const popup = await armed.popupPromise;
  if (popup) {
    await popup
      .waitForLoadState("domcontentloaded", { timeout: 10_000 })
      .catch(() => notes.push("popup did not reach domcontentloaded"));
    // JobRight's autofill CTA opens a BLANK tab first and sets its location
    // afterwards — sometimes only after the customize-resume interstitial is
    // answered. Live 2026-08-14 (IBM 6a7ce435…): the tab was read at
    // about:blank, closed, and the run reported "popup opened but carried no
    // usable URL" → wall budget, with the operator watching their only link
    // to the posting disappear. Wait for the real location before reading,
    // and never close a tab whose URL was never captured.
    const url = await settledPopupUrl(popup, notes);
    const landingHtml = await popup.content().catch(() => null);
    const landingTitle = await popup.title().catch(() => null);
    if (url && url !== "about:blank") {
      await popup.close().catch(() => undefined);
      notes.push(`popup captured on attempt ${attempt}`);
      return {
        url,
        via: "popup",
        clicks: attempt,
        notes,
        landingHtml,
        landingTitle,
      };
    }
    // Left OPEN on purpose: the operator can still see (and use) the tab the
    // Apply click produced, and a later attempt can read it once it settles.
    notes.push(
      "popup opened but stayed on about:blank — tab left open for the operator",
    );
    return null;
  }
  if (await armed.sameTabPromise) {
    notes.push(`same-tab navigation on attempt ${attempt}`);
    return {
      url: page.url(),
      via: "same_tab",
      clicks: attempt,
      notes,
      landingHtml: await page.content().catch(() => null),
      landingTitle: await page.title().catch(() => null),
    };
  }
  return null;
}

/**
 * Phase B — mutation (guard first): click the standard Apply control and
 * capture where it leads, via popup (listener registered BEFORE the click,
 * recorder precedent) or same-tab navigation off jobright.ai. Cap: 2 click
 * attempts, 10s waits. The captured popup is closed after its URL is read;
 * the JobRight tab is left where it is.
 *
 * JobRight's "Customize Your Resume" modal (operator screenshot 2026-08-13)
 * is the Apply click's usual next page — click "Apply Without Customizing"
 * immediately, never "Fix My Resume Now", never the X (that aborts apply).
 */
export async function clickApplyAndCaptureExternalUrl(
  session: PlaywrightServiceSession,
  page: Page,
): Promise<ApplyClickCapture> {
  assertNavigationAllowed("clickApplyAndCaptureExternalUrl");
  const notes: string[] = [];
  const context = session.getContext();

  const clickAndCapture = async (
    target: Locator,
    attempt: number,
    pollCustomizeModal: boolean,
  ): Promise<ApplyClickCapture | null> => {
    let popupPage: Page | null | undefined;
    const popupPromise = context
      .waitForEvent("page", { timeout: 10_000 })
      .then((p) => {
        popupPage = p;
        return p;
      })
      .catch(() => {
        popupPage = null;
        return null;
      });
    const sameTabPromise = page
      .waitForURL((u) => !/(^|\.)jobright\.ai$/i.test(new URL(u).hostname), {
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);

    await target.click({ timeout: 10_000 }).catch((e: Error) => {
      notes.push(`click attempt ${attempt} failed: ${e.message.slice(0, 120)}`);
    });

    if (pollCustomizeModal) {
      // Keep polling while the only popup so far is a BLANK tab: JobRight
      // opens that tab immediately and only navigates it once the
      // customize-resume interstitial is answered. Bailing on the popup
      // event alone left the interstitial unanswered and the tab blank.
      const stillWaiting = (): boolean =>
        popupPage === undefined ||
        (popupPage !== null && popupPage.url() === "about:blank");
      for (let i = 0; i < 10 && stillWaiting(); i++) {
        const proceed = await findJobRightInterstitialProceed(page);
        if (proceed) {
          await proceed.click({ timeout: 5_000 }).catch(() => undefined);
          notes.push(
            'jobright interstitial: clicked "Apply Without Customizing"',
          );
          break;
        }
        await page.waitForTimeout(150);
      }
    }

    return resolveExternalCapture(
      page,
      { popupPromise, sameTabPromise },
      attempt,
      notes,
    );
  };

  // If the customize modal is already up (prior Apply click), proceed
  // BEFORE the generic dismisser X-closes it.
  const already = await findJobRightInterstitialProceed(page);
  if (already) {
    notes.push(
      'jobright interstitial already showing — Apply Without Customizing first',
    );
    const captured = await clickAndCapture(already, 1, false);
    if (captured) return captured;
  }

  // JobRight interleaves upsell/promo modals over the job page — clear
  // them first so the Apply control is reachable. Bounded, never-click
  // screened (see obstructions.ts); already inside the NAVIGATION gate.
  const obstructions = await dismissPageObstructions(page);
  if (obstructions.dismissed.length > 0) {
    notes.push(`popups dismissed: ${obstructions.dismissed.join(", ")}`);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    // Attempt 1 leads with the autofill CTA; if that click produced no
    // external URL (it opened JobRight's own modal instead), attempt 2
    // falls back to the standard Apply tiers.
    const found = await findApplyControl(page, {
      includeAutofillCta: attempt === 1,
    });
    if (found === null) {
      notes.push(
        "no standard Apply control found (exact and broad name tiers both empty)",
      );
      return {
        url: null,
        via: null,
        clicks: attempt - 1,
        notes,
        landingHtml: null,
        landingTitle: null,
      };
    }
    if (found.tier === 0) {
      notes.push("Apply control: autofill CTA (tier 0)");
    } else if (found.tier === 2 && attempt === 1) {
      notes.push("Apply control matched via broad name tier");
    }

    const captured = await clickAndCapture(found.target, attempt, true);
    if (captured) return captured;
  }
  notes.push("no external URL captured after 2 attempts");
  return {
    url: null,
    via: null,
    clicks: 2,
    notes,
    landingHtml: null,
    landingTitle: null,
  };
}
