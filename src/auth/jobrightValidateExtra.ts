import type { Page } from "playwright";
import { jobrightSelectorsV1 } from "../jobright/selectors/v1.js";
import type { AuthValidationResult } from "./types.js";

/**
 * Pure assessment of JobRight logged-in chrome markers (for unit tests + validateExtra).
 * Returns null when the shell looks authenticated (caller may treat as pass-through).
 */
export function assessJobrightAuthMarkers(input: {
  url: string;
  bodyText: string;
  hasRecommendNav: boolean;
  hasAppliedNav: boolean;
  checkedAt?: string;
}): AuthValidationResult | null {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const body = input.bodyText;
  const shortBody = body.length > 0 && body.length < 2500;
  if (
    shortBody &&
    /sign in with google|log in to jobright|(^|\n)sign in(\n|$)|(^|\n)log in(\n|$)/i.test(
      body,
    )
  ) {
    return {
      ok: false,
      status: "UNAUTHENTICATED",
      url: input.url,
      reason: "Login surface text on validate page (not app shell)",
      checkedAt,
    };
  }
  if (input.hasRecommendNav && input.hasAppliedNav) {
    return null;
  }
  return {
    ok: false,
    status: "UNAUTHENTICATED",
    url: input.url,
    reason:
      "Missing JobRight app nav (recommend + applied links) — session may not carry auth into this context",
    checkedAt,
  };
}

/**
 * validateExtra for JobRight: require app-shell nav after SPA attach, not merely URL.
 */
export async function validateJobrightAuthExtra(
  page: Page,
): Promise<AuthValidationResult | null> {
  const checkedAt = new Date().toISOString();
  const recommend = page.locator(jobrightSelectorsV1.nav.jobsRecommend);
  const applied = page.locator(jobrightSelectorsV1.nav.applied);
  await recommend
    .first()
    .waitFor({ state: "attached", timeout: 15_000 })
    .catch(() => undefined);
  const hasRecommendNav = (await recommend.count().catch(() => 0)) > 0;
  const hasAppliedNav = (await applied.count().catch(() => 0)) > 0;
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return assessJobrightAuthMarkers({
    url: page.url(),
    bodyText,
    hasRecommendNav,
    hasAppliedNav,
    checkedAt,
  });
}
