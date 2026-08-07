/**
 * After education combobox fills, does #resume disappear?
 */
import { withPublicUrlPage } from "../src/browser/fixtureSession.js";
import { fillComboboxControl } from "../src/ats/greenhouse/comboboxFill.js";

const url =
  "https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003";

async function inventory(page: import("playwright").Page): Promise<string> {
  return page.evaluate(`(() => {
    const files = [...document.querySelectorAll('input[type=file]')].map(el => ({
      id: el.id, name: el.getAttribute('name'),
      parent: el.parentElement ? el.parentElement.outerHTML.slice(0, 200) : null
    }));
    const attach = [...document.querySelectorAll('button, label')].filter(el =>
      /attach|resume|cover/i.test(el.textContent || '')
    ).map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60));
    return JSON.stringify({ files, attach }, null, 2);
  })()`);
}

async function main(): Promise<void> {
  await withPublicUrlPage(url, async (page) => {
  await page.waitForTimeout(2500);
  console.log("BEFORE\n", await inventory(page));

  const steps = [
    ["country", "United States"],
    ["school--0", "Johns Hopkins University"],
    ["degree--0", "Bachelor of Science"],
    ["discipline--0", "Applied Mathematics"],
  ] as const;

  for (const [id, val] of steps) {
    const loc = page.locator(`#${id}`);
    if ((await loc.count()) === 0) {
      console.log("missing", id);
      continue;
    }
    const r = await fillComboboxControl(page, loc, val);
    console.log("\nAFTER", id, JSON.stringify(r));
    console.log(await inventory(page));
  }

  // Discipline with short filter string variants
  await page.keyboard.press("Escape").catch(() => undefined);
  const dloc = page.locator("#discipline--0");
  await dloc.click({ force: true });
  await page.waitForTimeout(300);
  await dloc.fill("");
  await dloc.pressSequentially("Applied Math", { delay: 30 });
  await page.waitForTimeout(800);
  const opts = await page.locator('[role="option"]').filter({ visible: true }).allTextContents();
  console.log("\nDiscipline filter 'Applied Math' options:", opts.slice(0, 15));

  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
