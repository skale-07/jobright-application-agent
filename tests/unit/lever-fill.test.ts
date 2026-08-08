import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { LeverAdapterV1, leverFullNameMatcher } from "../../src/ats/lever/v1.js";
import {
  annotateFullNameField,
} from "../../src/ats/shared/nameComposition.js";
import { mapDiscoveredFields } from "../../src/applications/fieldNormalization.js";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import { toApprovedFillPlan } from "../../src/applications/approvedFillPlan.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  applyFixtureFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

vi.mock("../../src/candidate/sensitiveProfileIO.js", () => ({
  tryLoadSensitiveProfile: () => null,
  getSensitiveValue: () => undefined,
  loadSensitiveProfile: () => {
    throw new Error("loadSensitiveProfile not available in lever-fill tests");
  },
}));

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ats");

const fixtureHtml = fs.readFileSync(
  path.join(FIXTURE_DIR, "lever", "dom.sanitized.html"),
  "utf8",
);

// The one PDF check:secrets allowlists — never add new PDFs.
const SAMPLE_RESUME = path.join(
  FIXTURE_DIR,
  "greenhouse",
  "sample-resume.pdf",
);

const TEST_ALIASES: Record<string, string[]> = {
  "legal_name.first": ["First name"],
  "legal_name.last": ["Last name"],
  email: ["Email"],
  phone: ["Phone"],
  linkedin_url: ["LinkedIn URL"],
  github_url: ["GitHub URL"],
  personal_website: ["Portfolio URL"],
  work_authorization: ["Are you legally authorized to work"],
};

const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
  linkedin_url: "https://linkedin.com/in/ada-example",
  github_url: "https://github.com/ada-example",
  personal_website: "https://ada.example",
  work_authorization: "Yes",
});

async function preparedAdapter() {
  const adapter = new LeverAdapterV1();
  const fields = await adapter.discoverFields({ html: fixtureHtml });
  const mapped = annotateFullNameField(
    mapDiscoveredFields(fields, TEST_ALIASES),
    leverFullNameMatcher,
  );
  const plan = buildFillPlan(mapped, PROFILE);
  const approved = toApprovedFillPlan(plan.entries);
  adapter.setFillContext(plan.entries, fields);
  adapter.setApprovedFillPlan(approved, PROFILE);
  return { adapter, composed: adapter.getApprovedFillPlan()! };
}

describe("Lever fill/upload/verify (M2)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it("refuses fill while FORM_FILL_ENABLED=false, before touching the page (UNIT_CONFIRMED)", async () => {
    const { adapter } = await preparedAdapter();
    applySafeFillEnv();
    await expect(
      adapter.fill(null as unknown as Page, {}),
    ).rejects.toThrow(/FORM_FILL_ENABLED|refusing/i);
  });

  it("refuses fill without an approved plan (UNIT_CONFIRMED)", async () => {
    const adapter = new LeverAdapterV1();
    applyFixtureFillEnv();
    try {
      await expect(
        adapter.fill(null as unknown as Page, {}),
      ).rejects.toThrow(/Approved fill plan required/);
    } finally {
      applySafeFillEnv();
    }
  });

  it(
    "fills the lever fixture from the approved plan and verifies by read-back (FIXTURE_CONFIRMED)",
    async () => {
      const { adapter, composed } = await preparedAdapter();
      applyFixtureFillEnv();
      try {
        await withFixtureHtmlPage(fixtureHtml, async (page) => {
          const result = await adapter.fill(page, {});
          expect(result.errors).toEqual([]);
          for (const canonical of [
            "legal_name.first",
            "email",
            "phone",
            "linkedin_url",
            "github_url",
            "personal_website",
            "work_authorization",
          ]) {
            expect(result.filled).toContain(canonical);
          }

          // Composed full name landed in the single name input.
          expect(await page.locator("#name").inputValue()).toBe(
            "Ada Lovelace",
          );
          // Work-auth native select committed a real option.
          expect(await page.locator("#card-workauth").inputValue()).toBe(
            "yes",
          );
          // Demographics selects stay untouched even though present.
          for (const eeo of ["#eeo-gender", "#eeo-race", "#eeo-veteran"]) {
            expect(await page.locator(eeo).inputValue()).toBe("");
          }
          // Essay textarea untouched.
          expect(await page.locator("#comments").inputValue()).toBe("");

          const verify = await adapter.verify(page, composed.answers);
          expect(verify.warnings).toEqual([]);
          expect(verify.passed).toBe(true);
          const nameCheck = verify.fields.find(
            (f) => f.canonical_field === "legal_name.first",
          )!;
          expect(nameCheck.observed).toBe("Ada Lovelace");
        });
      } finally {
        applySafeFillEnv();
      }
    },
    30_000,
  );

  it(
    "uploads the allowlisted synthetic resume and verifies via the input file list (FIXTURE_CONFIRMED)",
    async () => {
      const { adapter } = await preparedAdapter();
      applyFixtureFillEnv();
      try {
        await withFixtureHtmlPage(fixtureHtml, async (page) => {
          const upload = await adapter.uploadResume(page, SAMPLE_RESUME);
          expect(upload.verified).toBe(true);
          expect(upload.evidence).toMatch(/sample-resume\.pdf/);

          const missing = await adapter.uploadResume(
            page,
            path.join(FIXTURE_DIR, "lever", "does-not-exist.pdf"),
          );
          expect(missing.verified).toBe(false);
          expect(missing.evidence).toBe("file missing");
        });
      } finally {
        applySafeFillEnv();
      }
    },
    30_000,
  );

  it(
    "resetForm clears filled values (FIXTURE_CONFIRMED)",
    async () => {
      const { adapter } = await preparedAdapter();
      applyFixtureFillEnv();
      try {
        await withFixtureHtmlPage(fixtureHtml, async (page) => {
          await adapter.fill(page, {});
          expect(await page.locator("#name").inputValue()).toBe(
            "Ada Lovelace",
          );
          const reset = await adapter.resetForm(page);
          expect(reset.reset).toBe(true);
          expect(await page.locator("#name").inputValue()).toBe("");
          expect(await page.locator("#card-workauth").inputValue()).toBe("");
        });
      } finally {
        applySafeFillEnv();
      }
    },
    30_000,
  );
});
