import { withPublicUrlPage } from "../src/browser/fixtureSession.js";

const url =
  "https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003";

async function main(): Promise<void> {
  await withPublicUrlPage(url, async (page) => {
  await page.waitForTimeout(2500);

  const deg = page.locator("#degree--0");
  await page
    .locator("#degree--0")
    .locator('xpath=ancestor::*[contains(@class,"select__control")][1]')
    .click({ force: true })
    .catch(async () => deg.click({ force: true }));
  await page.keyboard.type("Bachelor", { delay: 20 });
  await page.waitForTimeout(500);
  await page.getByRole("option", { name: /Bachelor/i }).first().click();
  await page.waitForTimeout(400);

  for (const q of [
    "Applied",
    "Applied Mathematics",
    "Statistics",
    "Math",
    "Computer",
    "Engineering",
  ]) {
    const disc = page.locator("#discipline--0");
    await disc
      .locator('xpath=ancestor::*[contains(@class,"select__control")][1]')
      .click({ force: true });
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(q, { delay: 25 });
    await page.waitForTimeout(900);
    const opts = await page
      .locator('[role=option]')
      .filter({ visible: true })
      .allTextContents();
    console.log(JSON.stringify({ q, n: opts.length, opts: opts.slice(0, 15) }));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }

  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
