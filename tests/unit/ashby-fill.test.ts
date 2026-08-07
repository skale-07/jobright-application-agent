import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { AshbyAdapterV1, ashbyFullNameMatcher } from "../../src/ats/ashby/v1.js";
import {
  ashbyFillFromPlan,
} from "../../src/ats/ashby/fill.js";
import {
  detectButtonGroup,
  fillButtonGroup,
  readButtonGroupValue,
} from "../../src/ats/ashby/buttonGroupFill.js";
import { readAshbyComboboxValue } from "../../src/ats/ashby/comboboxFill.js";
import { annotateFullNameField } from "../../src/ats/shared/nameComposition.js";
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

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ats");

const fixtureHtml = fs.readFileSync(
  path.join(FIXTURE_DIR, "ashby", "dom.sanitized.html"),
  "utf8",
);

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
  "address.country": ["Country"],
  work_authorization: ["Are you legally authorized to work"],
};

const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
  address: { country: "United States" },
  work_authorization: "Yes",
});

const WORKAUTH_GROUP = '[role="radiogroup"][data-field-id="c0ffee00-1111-2222-3333-444455556666"]';
const GENDER_GROUP = '[role="radiogroup"][data-field-id="eeee5555-6666-7777-8888-99990000aaaa"]';
const COUNTRY_INPUT = "#dddd4444-eeee-ffff-0000-111122223333";
const COUNTRY_SELECTED = "#country-select .ashby-select__selected";

async function preparedAdapter() {
  const adapter = new AshbyAdapterV1();
  const fields = await adapter.discoverFields({ html: fixtureHtml });
  const mapped = annotateFullNameField(
    mapDiscoveredFields(fields, TEST_ALIASES),
    ashbyFullNameMatcher,
  );
  const plan = buildFillPlan(mapped, PROFILE);
  const approved = toApprovedFillPlan(plan.entries);
  adapter.setFillContext(plan.entries, fields);
  adapter.setApprovedFillPlan(approved, PROFILE);
  return { adapter, composed: adapter.getApprovedFillPlan()! };
}

describe("Ashby fill/upload/verify (M5)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it("refuses fill while FORM_FILL_ENABLED=false, before touching the page (UNIT_CONFIRMED)", async () => {
    const { adapter } = await preparedAdapter();
    applySafeFillEnv();
    await expect(adapter.fill(null as unknown as Page, {})).rejects.toThrow(
      /FORM_FILL_ENABLED|refusing/i,
    );
  });

  it("refuses fill without an approved plan (UNIT_CONFIRMED)", async () => {
    const adapter = new AshbyAdapterV1();
    applyFixtureFillEnv();
    try {
      await expect(adapter.fill(null as unknown as Page, {})).rejects.toThrow(
        /Approved fill plan required/,
      );
    } finally {
      applySafeFillEnv();
    }
  });

  it(
    "fills text, portal combobox, and button group; verifies by independent read-back (FIXTURE_CONFIRMED)",
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
            "address.country",
            "work_authorization",
          ]) {
            expect(result.filled).toContain(canonical);
          }

          expect(
            await page.locator("#_systemfield_name").inputValue(),
          ).toBe("Ada Lovelace");
          // Combobox committed to the display node; the input keeps no
          // filter residue.
          expect(await page.locator(COUNTRY_SELECTED).textContent()).toBe(
            "United States",
          );
          expect(await page.locator(COUNTRY_INPUT).inputValue()).toBe("");
          // Pin the committed-value read path itself (guards the
          // placeholder filter and shell resolution in ashby/comboboxFill).
          expect(
            await readAshbyComboboxValue(page.locator(COUNTRY_INPUT)),
          ).toBe("United States");
          // Work-auth group pressed "Yes"; demographics group untouched.
          expect(
            await page
              .locator(`${WORKAUTH_GROUP} [aria-pressed="true"]`)
              .textContent(),
          ).toBe("Yes");
          expect(
            await page
              .locator(`${GENDER_GROUP} [aria-pressed="true"]`)
              .count(),
          ).toBe(0);
          // Essay textarea untouched.
          expect(
            await page
              .locator("#bbbb2222-cccc-dddd-eeee-ffff00002222")
              .inputValue(),
          ).toBe("");

          const verify = await adapter.verify(page, composed.answers);
          expect(verify.warnings).toEqual([]);
          expect(verify.passed).toBe(true);
          const workauth = verify.fields.find(
            (f) => f.canonical_field === "work_authorization",
          )!;
          expect(workauth.observed).toBe("Yes");
          expect(workauth.match).toBe(true);
        });
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "button group refuses ambiguous/absent options without clicking (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      try {
        await withFixtureHtmlPage(fixtureHtml, async (page) => {
          const group = page.locator(WORKAUTH_GROUP);
          expect(await detectButtonGroup(group)).toBe(true);
          expect(await readButtonGroupValue(group)).toBeNull();

          const miss = await fillButtonGroup(group, "Maybe");
          expect(miss.committed).toBe(false);
          expect(await readButtonGroupValue(group)).toBeNull();

          // Yes/No synonym handling comes from pickOptionLabel.
          const hit = await fillButtonGroup(group, "true");
          expect(hit.committed).toBe(true);
          expect(hit.selectedLabel).toBe("Yes");
        });
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "combobox refuses a value with no matching option and leaves no residue (FIXTURE_CONFIRMED)",
    async () => {
      const { adapter } = await preparedAdapter();
      applyFixtureFillEnv();
      try {
        await withFixtureHtmlPage(fixtureHtml, async (page) => {
          const composed = adapter.getApprovedFillPlan()!;
          const forged = composed.entries
            .filter((e) => e.field_id === "dddd4444-eeee-ffff-0000-111122223333")
            .map((e) => ({ ...e, value: "Atlantis" }));
          const result = await ashbyFillFromPlan(
            page,
            forged,
            new Map([
              [
                "dddd4444-eeee-ffff-0000-111122223333",
                { type: "text" as const, inputId: "dddd4444-eeee-ffff-0000-111122223333" },
              ],
            ]),
          );
          expect(result.errors).toHaveLength(1);
          expect(result.errors[0]).toMatch(/not committed|no option/i);
          expect(await page.locator(COUNTRY_SELECTED).textContent()).toBe(
            "Select...",
          );
        });
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "locates a button group WITHOUT data-field-id via its accessible name (FIXTURE_CONFIRMED)",
    async () => {
      // Review finding: discovery emits synthetic ids (button_group_N) for
      // groups lacking data-field-id; the executor must fall back to the
      // group's accessible name instead of erroring on every attempt.
      const html = `<!DOCTYPE html><html><body>
        <h4 id="lbl-remote">Are you willing to work remotely?</h4>
        <div role="radiogroup" aria-labelledby="lbl-remote">
          <button type="button" aria-pressed="false">Yes</button>
          <button type="button" aria-pressed="false">No</button>
        </div>
        <script>
          document.querySelectorAll('[role="radiogroup"]').forEach(function (group) {
            group.addEventListener("click", function (ev) {
              var btn = ev.target.closest("button");
              if (!btn) return;
              group.querySelectorAll("button").forEach(function (b) {
                b.setAttribute("aria-pressed", "false");
              });
              btn.setAttribute("aria-pressed", "true");
            });
          });
        </script>
      </body></html>`;
      applyFixtureFillEnv();
      try {
        await withFixtureHtmlPage(html, async (page) => {
          const result = await ashbyFillFromPlan(
            page,
            [
              {
                field_id: "button_group_0",
                label: "Are you willing to work remotely?",
                type: "radio",
                canonical_field: "relocation",
                action: "FILL",
                approved: true,
                value: "Yes",
                reason: "test",
              },
            ],
            new Map([["button_group_0", { type: "radio" as const }]]),
          );
          expect(result.errors).toEqual([]);
          expect(result.filled).toContain("relocation");
          expect(
            await page.locator('[aria-pressed="true"]').textContent(),
          ).toBe("Yes");
        });
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "a forged demographics button-group entry is rejected before any click (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      try {
        await withFixtureHtmlPage(fixtureHtml, async (page) => {
          const result = await ashbyFillFromPlan(
            page,
            [
              {
                field_id: "eeee5555-6666-7777-8888-99990000aaaa",
                label: "Gender identity (voluntary self-identification)",
                type: "radio",
                canonical_field: "work_authorization",
                action: "FILL",
                approved: true,
                value: "Man",
                reason: "forged",
              },
            ],
            new Map([
              ["eeee5555-6666-7777-8888-99990000aaaa", { type: "radio" as const }],
            ]),
          );
          expect(result.errors).toHaveLength(1);
          expect(result.errors[0]).toMatch(/demographics/);
          expect(
            await page
              .locator(`${GENDER_GROUP} [aria-pressed="true"]`)
              .count(),
          ).toBe(0);
        });
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );

  it(
    "uploads through the CSS-hidden resume input; resetForm reports honest failure (FIXTURE_CONFIRMED)",
    async () => {
      const { adapter } = await preparedAdapter();
      applyFixtureFillEnv();
      try {
        await withFixtureHtmlPage(fixtureHtml, async (page) => {
          const upload = await adapter.uploadResume(page, SAMPLE_RESUME);
          expect(upload.verified).toBe(true);
          expect(upload.evidence).toMatch(/sample-resume\.pdf/);

          const reset = await adapter.resetForm(page);
          expect(reset.reset).toBe(false);
          expect(reset.notes[0]).toMatch(/controlled inputs/);
        });
      } finally {
        applySafeFillEnv();
      }
    },
    45_000,
  );
});
