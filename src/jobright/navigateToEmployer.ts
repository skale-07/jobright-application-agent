import type { Page } from "playwright";
import type { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { jobrightSelectorsV1 } from "./selectors/v1.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { assertNavigationAllowed } from "../navigation/navigationGuards.js";

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

  const ats = await collect(jobrightSelectorsV1.navigation.externalAtsAnchors);
  const any = await collect(jobrightSelectorsV1.navigation.externalAnyAnchor);

  const seen = new Set<string>();
  const wellFormed: string[] = [];
  for (const href of [...ats, ...any]) {
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
): Promise<{ target: ReturnType<Page["locator"]>; tier: 1 | 2 } | null> {
  const { standardApplyRole, broadApplyRole, applyNameExclusions } =
    jobrightSelectorsV1.navigation;

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

  for (let attempt = 1; attempt <= 2; attempt++) {
    const found = await findApplyControl(page);
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
    if (found.tier === 2 && attempt === 1) {
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
