import type { Page } from "playwright";
import type { ServiceName } from "./types.js";
import { getServiceAuthConfig } from "./serviceRegistry.js";

/**
 * Heuristic auth-loss detection for mid-run checks.
 */
export async function detectAuthLossOnPage(
  page: Page,
  service: ServiceName,
): Promise<boolean> {
  const cfg = getServiceAuthConfig(service);
  const url = page.url();
  for (const re of cfg.unauthenticatedUrlPatterns) {
    if (re.test(url)) return true;
  }
  for (const re of cfg.checkpointUrlPatterns) {
    if (re.test(url)) return true;
  }
  const body = await page.locator("body").innerText().catch(() => "");
  if (
    body.length > 0 &&
    body.length < 2500 &&
    /sign in|log in|session expired|please log in/i.test(body)
  ) {
    return true;
  }
  return false;
}
