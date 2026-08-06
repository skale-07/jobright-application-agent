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

/**
 * Ephemeral Chromium context for public ATS pages (no JobRight/LinkedIn storage).
 * Used for Greenhouse read-only live inspection.
 */
export async function withPublicUrlPage<T>(
  url: string,
  fn: (page: Page) => Promise<T>,
  options?: { headless?: boolean },
): Promise<T> {
  const browser = await chromium.launch(
    browserLaunchOptions({
      headless: options?.headless ?? true,
      channel: "chromium",
      slowMoMs: 0,
    }),
  );
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
    });
    const page = await context.newPage();
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close();
  }
}
