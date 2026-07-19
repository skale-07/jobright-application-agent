import { chromium, type Page } from "playwright";
import { browserLaunchOptions } from "./launchOptions.js";

/**
 * Headless Chromium for offline HTML fixtures via page.setContent.
 * Does NOT load JobRight auth, storage state, or persistent profiles.
 *
 * This is the only allowlisted fixture launcher besides PlaywrightServiceSession
 * and loginFlow (which are auth/session paths).
 */
export async function withFixtureHtmlPage<T>(
  html: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch(
    browserLaunchOptions({ headless: true, channel: "chromium", slowMoMs: 0 }),
  );
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return await fn(page);
  } finally {
    await browser.close();
  }
}
