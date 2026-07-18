import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { loadAtsFixture } from "../../src/applications/atsFixtureInspect.js";
import {
  planApplicationFill,
  runAtsFixtureFill,
} from "../../src/applications/applicationFiller.js";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import { mapDiscoveredFields } from "../../src/applications/fieldNormalization.js";
import { loadAnswerAliases } from "../../src/candidate/answerAliases.js";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import { loadPublicProfile } from "../../src/candidate/publicProfileIO.js";
import {
  assertFormFillAllowed,
  assertSubmitAllowed,
} from "../../src/applications/formFillGuards.js";
import { GreenhouseAdapterV1 } from "../../src/ats/greenhouse/v1.js";
import { resetConfigCache, loadConfig } from "../../src/config/index.js";
import { browserLaunchOptions } from "../../src/browser/launchOptions.js";

const testProfile = parsePublicProfile({
  ...loadPublicProfile(),
  legal_name: { first: "Ada", middle: "", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
  school: "Johns Hopkins University",
  graduation_year: 2029,
  requires_sponsorship: "No",
});

describe("Phase 5 Greenhouse fill", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch(
      browserLaunchOptions({ headless: true, channel: "chromium", slowMoMs: 0 }),
    );
  });

  afterAll(async () => {
    await browser.close();
  });

  it("builds a fill plan from public profile without executing", async () => {
    const fixture = loadAtsFixture("greenhouse");
    const { plan } = await planApplicationFill({
      ...fixture,
      profile: testProfile,
    });
    expect(plan.fillable_count).toBeGreaterThanOrEqual(4);
    expect(plan.answers["legal_name.first"]).toBe("Ada");
    expect(plan.answers.email).toBe("ada@example.com");
    expect(plan.entries.some((e) => e.action === "skip_file")).toBe(true);
  });

  it("plan_only mode does not require FORM_FILL_ENABLED", async () => {
    resetConfigCache();
    process.env.FORM_FILL_ENABLED = "false";
    process.env.DRY_RUN = "true";
    resetConfigCache();
    const report = await runAtsFixtureFill("greenhouse", {
      execute: false,
      profile: testProfile,
    });
    expect(report.mode).toBe("plan_only");
    expect(report.submit_attempted).toBe(false);
  });

  it("fills and verifies Greenhouse fixture when flags allow", async () => {
    process.env.FORM_FILL_ENABLED = "true";
    process.env.DRY_RUN = "false";
    process.env.SUBMIT_ENABLED = "false";
    resetConfigCache();
    loadConfig();

    const fixture = loadAtsFixture("greenhouse");
    const adapter = new GreenhouseAdapterV1();
    const fields = await adapter.discoverFields({ html: fixture.html });
    const mapped = mapDiscoveredFields(fields, loadAnswerAliases());
    const plan = buildFillPlan(mapped, testProfile);
    adapter.setFillContext(plan.entries, fields);

    const page = await browser.newPage();
    try {
      await page.setContent(fixture.html, { waitUntil: "domcontentloaded" });
      const fill = await adapter.fill(page, plan.answers);
      expect(fill.errors).toEqual([]);
      expect(fill.filled).toContain("legal_name.first");
      expect(fill.filled).toContain("email");

      const first = await page.locator("#first_name").inputValue();
      expect(first).toBe("Ada");
      const email = await page.locator("#email").inputValue();
      expect(email).toBe("ada@example.com");

      const verify = await adapter.verify(page, plan.answers);
      expect(verify.passed).toBe(true);

      const sampleResume = path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "ats",
        "greenhouse",
        "sample-resume.pdf",
      );
      if (!fs.existsSync(sampleResume)) {
        fs.writeFileSync(
          sampleResume,
          "%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
        );
      }
      const upload = await adapter.uploadResume(page, sampleResume);
      expect(upload.verified).toBe(true);

      const reset = await adapter.resetForm(page);
      expect(reset.reset).toBe(true);
      const afterReset = await page.locator("#first_name").inputValue();
      expect(afterReset).toBe("");

      await expect(adapter.submit(page)).rejects.toThrow(
        /FORM_FILL_ENABLED|SUBMIT_ENABLED|not implemented|refusing/,
      );
    } finally {
      await page.close();
      process.env.FORM_FILL_ENABLED = "false";
      process.env.DRY_RUN = "true";
      resetConfigCache();
    }
  });

  it("refuses execute when FORM_FILL_ENABLED is false", async () => {
    process.env.FORM_FILL_ENABLED = "false";
    process.env.DRY_RUN = "true";
    resetConfigCache();
    expect(() => assertFormFillAllowed("test")).toThrow(/FORM_FILL_ENABLED/);
    expect(() => assertSubmitAllowed("test")).toThrow(/FORM_FILL_ENABLED|SUBMIT_ENABLED/);
  });

  it("never plans essay autofill", () => {
    const essayHtml = loadAtsFixture("essay").html;
    const fields = discoverFieldsFromHtml(essayHtml, { preferGreenhouse: true });
    const mapped = mapDiscoveredFields(fields, loadAnswerAliases());
    const plan = buildFillPlan(mapped, testProfile);
    expect(plan.entries.filter((e) => e.action === "skip_essay").length).toBeGreaterThanOrEqual(1);
    expect(
      plan.entries.some(
        (e) => e.action === "fill" && e.type === "textarea",
      ),
    ).toBe(false);
  });
});
