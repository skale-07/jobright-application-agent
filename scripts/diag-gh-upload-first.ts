import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  greenhouseUploadFile,
  resolveGreenhouseFileInput,
} from "../src/ats/greenhouse/fill.js";
import { fillComboboxControl } from "../src/ats/greenhouse/comboboxFill.js";

const url =
  "https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003";
const resume = path.resolve(
  "private/candidate/resumes/Shubham_Kale_Citadel_NeurIPS_Resume.pdf",
);

async function inv(page: import("playwright").Page): Promise<unknown> {
  return page.evaluate(`(() => [...document.querySelectorAll('input[type=file]')].map(e => e.id))()`);
}

async function main(): Promise<void> {
  process.env.FORM_FILL_ENABLED = "true";
  process.env.DRY_RUN = "false";
  if (!fs.existsSync(resume)) throw new Error("missing resume");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);

  console.log("cold files", await inv(page));
  const r0 = await resolveGreenhouseFileInput(page, "resume");
  console.log("resolved", await r0.getAttribute("id"));
  const up = await greenhouseUploadFile(page, "resume", resume);
  console.log("upload cold", up);
  console.log("after cold upload files", await inv(page));

  // Try discipline alone after degree
  for (const [id, v] of [
    ["degree--0", "Bachelor of Science"],
    ["discipline--0", "Applied Math & Stats"],
  ] as const) {
    const res = await fillComboboxControl(page, page.locator(`#${id}`), v);
    console.log(id, res);
  }
  console.log("after degrees files", await inv(page));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
