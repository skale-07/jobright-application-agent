import type { Page } from "playwright";
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
 * (previously only counted by controlVisibility). Known-ATS URLs first.
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
 * Close JobRight's own modals ("Did you apply?"). Only the CLOSE control is
 * ever clicked — the modal's buttons are answers about the operator's
 * application state, which this system must never assert on their behalf.
 */
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

/**
 * Phase B — mutation (guard first): click the standard Apply control and
 * capture where it leads, via popup (listener registered BEFORE the click,
 * recorder precedent) or same-tab navigation off jobright.ai. Cap: 2 click
 * attempts, 10s waits. The captured popup is closed after its URL is read;
 * the JobRight tab is left where it is.
 */
export async function clickApplyAndCaptureExternalUrl(
  session: PlaywrightServiceSession,
  page: Page,
): Promise<ApplyClickCapture> {
  assertNavigationAllowed("clickApplyAndCaptureExternalUrl");
  const notes: string[] = [];
  const context = session.getContext();

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
    const target = found.target;
    if (found.tier === 0) {
      notes.push("Apply control: autofill CTA (tier 0)");
    } else if (found.tier === 2 && attempt === 1) {
      notes.push("Apply control matched via broad name tier");
    }

    const popupPromise = context
      .waitForEvent("page", { timeout: 10_000 })
      .catch(() => null);
    const sameTabPromise = page
      .waitForURL((u) => !/(^|\.)jobright\.ai$/i.test(new URL(u).hostname), {
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);

    await target.click({ timeout: 10_000 }).catch((e: Error) => {
      notes.push(`click attempt ${attempt} failed: ${e.message.slice(0, 120)}`);
    });

    const popup = await popupPromise;
    if (popup) {
      await popup
        .waitForLoadState("domcontentloaded", { timeout: 10_000 })
        .catch(() => notes.push("popup did not reach domcontentloaded"));
      const url = popup.url();
      const landingHtml = await popup.content().catch(() => null);
      const landingTitle = await popup.title().catch(() => null);
      await popup.close().catch(() => undefined);
      if (url && url !== "about:blank") {
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
      notes.push("popup opened but carried no usable URL");
    } else if (await sameTabPromise) {
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
