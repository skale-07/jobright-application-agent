import { chromium } from "playwright";

const url =
  "https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);

  // Degree first (may cascade)
  const deg = page.locator("#degree--0");
  await deg
    .locator('xpath=ancestor::*[contains(@class,"select__control")][1]')
    .click({ force: true })
    .catch(async () => deg.click({ force: true }));
  await page.waitForTimeout(400);
  await page.keyboard.type("Bachelor", { delay: 30 });
  await page.waitForTimeout(600);
  await page.getByRole("option", { name: /Bachelor/i }).first().click();
  await page.waitForTimeout(500);

  const disc = page.locator("#discipline--0");
  const control = disc.locator(
    'xpath=ancestor::*[contains(@class,"select__control")][1]',
  );
  await control.click({ force: true });
  await page.waitForTimeout(500);
  console.log(
    "after open options",
    (
      await page.locator('[role=option]').filter({ visible: true }).allTextContents()
    ).slice(0, 8),
  );

  // Focus input and type
  await disc.click({ force: true });
  await page.keyboard.type("Applied Math", { delay: 40 });
  await page.waitForTimeout(1500);
  console.log(
    "after Applied Math",
    await page.locator('[role=option]').filter({ visible: true }).allTextContents(),
  );
  console.log("input value", await disc.inputValue().catch(() => "n/a"));
  console.log(
    "listbox html",
    await page
      .locator('[role=listbox]')
      .filter({ visible: true })
      .first()
      .evaluate((el) => el.outerHTML.slice(0, 800))
      .catch(() => "none"),
  );

  // Try Mathematics alone
  await disc.fill("");
  await page.keyboard.type("Mathematics", { delay: 40 });
  await page.waitForTimeout(1500);
  console.log(
    "after Mathematics",
    await page.locator('[role=option]').filter({ visible: true }).allTextContents(),
  );

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
