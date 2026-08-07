import { withPublicUrlPage } from "../src/browser/fixtureSession.js";
import { resolveGreenhouseFileInput } from "../src/ats/greenhouse/fill.js";

const url =
  "https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003";

async function inv(page: import("playwright").Page): Promise<unknown> {
  return page.evaluate(
    `(() => [...document.querySelectorAll('input[type=file]')].map(e => ({id:e.id, type:e.type})))()`,
  );
}

async function main(): Promise<void> {
  await withPublicUrlPage(url, async (page) => {
  await page.waitForTimeout(2500);
  console.log("1 cold", await inv(page));

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  console.log("2 after Escape", await inv(page));

  try {
    const loc = await resolveGreenhouseFileInput(page, "resume");
    console.log("3 resolve id", await loc.getAttribute("id"));
    // setInputFiles with empty path test? don't
    console.log("3 count", await page.locator('input[type=file]').count());
  } catch (e) {
    console.log("3 resolve failed", e);
  }

  // Does attach button replace inputs?
  const attach = page.locator('button.btn--pill', { hasText: "Attach" }).first();
  console.log("attach count", await page.locator('button.btn--pill').count());
  await attach.click({ timeout: 5000 }).catch((e) => console.log("attach click", e.message));
  await page.waitForTimeout(500);
  console.log("4 after attach click", await inv(page));

  // Try setInputFiles directly on page.locator
  const resume = pathJoinResume();
  const direct = page.locator("#resume");
  console.log("5 #resume count", await direct.count());
  if ((await direct.count()) > 0) {
    await direct.setInputFiles(resume);
    console.log("5 setInputFiles ok", await inv(page));
    const files = await direct.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any) =>
        el.files ? [...el.files].map((f: { name: string }) => f.name) : [],
    );
    console.log("5 files prop", files);
  } else {
    console.log("5 still missing #resume — try re-navigation");
  }

  });
}

function pathJoinResume(): string {
  return "C:\\dev\\jobright-application-agent\\private\\candidate\\resumes\\Shubham_Kale_Citadel_NeurIPS_Resume.pdf";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
