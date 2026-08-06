/**
 * One-shot live feed diagnostic (read-only). Not part of product CLI.
 * Usage: npx tsx scripts/diag-jobright-feed.ts
 */
import fs from "node:fs";
import path from "node:path";
import { PlaywrightServiceSession } from "../src/auth/serviceSession.js";
import { parseJobCardsFromFeedHtml } from "../src/jobright/jobFeed.js";
import { defaultJobRightStartUrl } from "../src/recorder/workflows.js";

async function main(): Promise<void> {
  const feedUrl = defaultJobRightStartUrl();
  const session = new PlaywrightServiceSession({
    service: "jobright",
    headless: true,
    slowMoMs: 0,
    // This script exists to discover what the live logged-in page contains.
    // Gating it behind validateExtra would make it depend on the very
    // selectors it is meant to confirm.
    skipAuthValidation: true,
  });
  await session.open();
  const page = await session.newPage({ purpose: "feed_diag" });
  try {
    await page.goto(feedUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2000);
    const urlAfter2s = page.url();
    const title2 = await page.title();
    const html2 = await page.content();
    const cards2 = parseJobCardsFromFeedHtml(html2);
    const infoHits2 = [...html2.matchAll(/\/jobs\/info\/([a-f0-9]+)/gi)].length;

    await page.waitForTimeout(5000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    const html = await page.content();
    const cards = parseJobCardsFromFeedHtml(html);
    const infoHits = [...html.matchAll(/\/jobs\/info\/([a-f0-9]+)/gi)].length;
    const locatorInfo = await page
      .locator('a[href*="/jobs/info/"]')
      .count()
      .catch(() => -1);
    const sampleHrefs = await page
      .locator('a[href*="/jobs/"]')
      .evaluateAll((els) =>
        [
          ...new Set(
            els
              .map((e) => e.getAttribute("href"))
              .filter((h): h is string => Boolean(h)),
          ),
        ].slice(0, 50),
      )
      .catch(() => [] as string[]);
    const pathSamples = [
      ...new Set(
        [...html.matchAll(/\/jobs\/[a-zA-Z0-9_\-./?=&%]+/g)].map((m) => m[0]),
      ),
    ].slice(0, 50);
    const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(
      0,
      1200,
    );

    const outDir = path.join("artifacts", "discovery");
    fs.mkdirSync(outDir, { recursive: true });
    const snap = path.join(outDir, `feed-diag-${Date.now()}.html`);
    fs.writeFileSync(snap, html, "utf8");

    const report = {
      feedUrl,
      urlAfter2s,
      urlFinal: page.url(),
      title2,
      titleFinal: await page.title(),
      cards_after_2s: cards2.length,
      info_id_matches_2s: infoHits2,
      cards_after_wait: cards.length,
      info_id_matches_wait: infoHits,
      locator_jobs_info_count: locatorInfo,
      sample_hrefs: sampleHrefs,
      path_samples: pathSamples,
      body_preview: bodyText,
      html_bytes: html.length,
      snap_path: snap,
      has_sign_in: /sign in|log in/i.test(bodyText),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await page.close().catch(() => undefined);
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
