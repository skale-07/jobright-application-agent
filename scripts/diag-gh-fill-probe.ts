/**
 * Live probe: combobox + resume upload on Greenhouse job-boards sandbox.
 * Usage: npx tsx scripts/diag-gh-fill-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { withPublicUrlPage } from "../src/browser/fixtureSession.js";
import {
  detectControlKind,
  fillComboboxControl,
  readComboboxValue,
} from "../src/ats/greenhouse/comboboxFill.js";
import {
  greenhouseUploadFile,
  resolveGreenhouseFileInput,
} from "../src/ats/greenhouse/fill.js";

const url =
  "https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003";

const resumeCandidates = [
  path.resolve(
    "private/candidate/resumes/Shubham_Kale_Citadel_NeurIPS_Resume.pdf",
  ),
  path.resolve("tests/fixtures/ats/greenhouse/sample-resume.pdf"),
];

async function main(): Promise<void> {
  process.env.FORM_FILL_ENABLED = "true";
  process.env.DRY_RUN = "false";
  process.env.SUBMIT_ENABLED = "false";

  const resume = resumeCandidates.find((p) => fs.existsSync(p));
  if (!resume) throw new Error("no resume pdf found for probe");

  await withPublicUrlPage(url, async (page) => {
  await page.waitForSelector("#application_form, form", { timeout: 30_000 });
  await page.waitForTimeout(2_000);

  const fields = [
    { id: "country", value: "United States" },
    { id: "school--0", value: "Johns Hopkins University" },
    { id: "degree--0", value: "Bachelor of Science" },
    { id: "discipline--0", value: "Applied Math & Stats" },
    { id: "end-month--0", value: "May" },
    { id: "question_11879006003", value: "Yes" },
  ];

  const results: unknown[] = [];
  for (const f of fields) {
    const loc = page.locator(`#${f.id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1")}`);
    const count = await loc.count();
    if (count === 0) {
      results.push({ id: f.id, error: "not found" });
      continue;
    }
    const kind = await detectControlKind(loc);
    const before = await readComboboxValue(loc).catch(() => null);
    let fill: unknown = null;
    try {
      fill = await fillComboboxControl(page, loc, f.value);
    } catch (e) {
      fill = { error: e instanceof Error ? e.message : String(e) };
    }
    const after = await readComboboxValue(loc).catch(() => null);
    // Sample visible options once for evidence
    let sampleOptions: string[] = [];
    try {
      await loc.click({ timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
      sampleOptions = (
        await page
          .locator('[role="option"]')
          .filter({ visible: true })
          .allTextContents()
      )
        .map((t) => t.replace(/\s+/g, " ").trim())
        .slice(0, 12);
      await page.keyboard.press("Escape").catch(() => undefined);
    } catch {
      /* ignore */
    }
    results.push({
      id: f.id,
      kind,
      expected: f.value,
      before,
      fill,
      after,
      sampleOptions,
    });
  }

  let upload: unknown;
  try {
    const input = await resolveGreenhouseFileInput(page, "resume");
    const id = await input.getAttribute("id");
    upload = {
      resolvedId: id,
      result: await greenhouseUploadFile(page, "resume", resume),
    };
  } catch (e) {
    upload = { error: e instanceof Error ? e.message : String(e) };
  }

  console.log(JSON.stringify({ results, upload, resume }, null, 2));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
