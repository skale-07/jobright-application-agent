import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectControlKind,
  fillComboboxControl,
  pickOptionLabel,
  readComboboxValue,
} from "../../src/ats/greenhouse/comboboxFill.js";
import {
  greenhouseFillFromPlan,
  greenhouseVerifyFromPlan,
  type FieldMeta,
} from "../../src/ats/greenhouse/fill.js";
import { healFailedFillEntries } from "../../src/ats/greenhouse/fillHealer.js";
import type { ApprovedFillPlanEntry } from "../../src/applications/approvedFillPlan.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

const fixtureHtml = fs.readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "greenhouse-combobox",
    "dom.sanitized.html",
  ),
  "utf8",
);

function entry(
  overrides: Partial<ApprovedFillPlanEntry> = {},
): ApprovedFillPlanEntry {
  return {
    field_id: "country",
    label: "Country",
    type: "select",
    canonical_field: "address.country",
    action: "FILL",
    approved: true,
    value: "United States",
    reason: "Mapped from public profile",
    ...overrides,
  };
}

describe("pickOptionLabel (UNIT_CONFIRMED)", () => {
  const options = [
    "Canada",
    "United Kingdom",
    "United States",
    "Bachelor of Science",
    "Applied Mathematics & Statistics",
  ];

  it("exact, then case-insensitive, then unique substring", () => {
    expect(pickOptionLabel(options, "United States")).toMatchObject({
      ok: true,
      via: "exact",
    });
    expect(pickOptionLabel(options, "united states")).toMatchObject({
      ok: true,
      label: "United States",
      via: "ci_exact",
    });
    expect(pickOptionLabel(options, "Applied Math")).toMatchObject({
      ok: true,
      label: "Applied Mathematics & Statistics",
      via: "unique_substring",
    });
  });

  it("yes/no normalization picks the right binary option", () => {
    expect(pickOptionLabel(["Yes", "No"], "true")).toMatchObject({
      ok: true,
      label: "Yes",
    });
    expect(pickOptionLabel(["Yes", "No"], "0")).toMatchObject({
      ok: true,
      label: "No",
    });
  });

  it("ambiguous and missing both refuse with evidence", () => {
    const ambiguous = pickOptionLabel(options, "United");
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.reason).toMatch(/ambiguous/);

    const missing = pickOptionLabel(options, "Atlantis");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/no option matches/);
    expect(pickOptionLabel(options, " ").ok).toBe(false);
  });
});

describe("combobox interaction on fixture (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  it("detects control kinds on the live DOM", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      expect(await detectControlKind(page.locator("#country"))).toBe(
        "combobox",
      );
      expect(await detectControlKind(page.locator("#degree_native"))).toBe(
        "native_select",
      );
      expect(await detectControlKind(page.locator("#first_name"))).toBe(
        "text",
      );
    });
  }, 30_000);

  it("fills and commits a combobox; read-back sees the committed label", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const loc = page.locator("#country");
      expect(await readComboboxValue(loc)).toBeNull();
      const result = await fillComboboxControl(page, loc, "United States");
      expect(result.committed).toBe(true);
      expect(result.selectedLabel).toBe("United States");
      expect(await readComboboxValue(loc)).toBe("United States");
      // The filter input carries no residue.
      expect(await loc.inputValue()).toBe("");
    });
  }, 30_000);

  it("no matching option → uncommitted, no residue, loud notes", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const loc = page.locator("#country");
      const result = await fillComboboxControl(page, loc, "Atlantis");
      expect(result.committed).toBe(false);
      expect(result.notes.join(" ")).toMatch(/no option matches/);
      expect(await readComboboxValue(loc)).toBeNull();
      expect(await loc.inputValue()).toBe("");
    });
  }, 30_000);

  it("greenhouseFillFromPlan routes comboboxes and native selects correctly", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const meta = new Map<string, FieldMeta>([
        ["country", { type: "select", inputId: "country" }],
        ["work_auth", { type: "text", inputId: "work_auth" }],
        ["degree_native", { type: "select", inputId: "degree_native" }],
      ]);
      const entries = [
        entry(),
        entry({
          field_id: "work_auth",
          label: "Are you legally authorized to work?",
          type: "text",
          canonical_field: "work_authorization",
          value: "Yes",
        }),
        entry({
          field_id: "degree_native",
          label: "Degree",
          canonical_field: "degree",
          value: "Bachelor of Science",
        }),
      ];
      const fill = await greenhouseFillFromPlan(page, entries, meta);
      expect(fill.errors).toEqual([]);
      expect(fill.filled).toHaveLength(3);

      const verify = await greenhouseVerifyFromPlan(page, entries, meta);
      expect(verify.passed).toBe(true);
      // UI truth: committed labels, not filter text.
      expect(await readComboboxValue(page.locator("#work_auth"))).toBe("Yes");
    });
  }, 30_000);

  it("verify is FALSE for a half-open combobox with filter text (the live bug)", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const loc = page.locator("#work_auth");
      // Reproduce the old behavior: type into the filter, never commit.
      await loc.click();
      await loc.fill("Yes");
      expect(await loc.inputValue()).toBe("Yes"); // the old read would pass
      const meta = new Map<string, FieldMeta>([
        ["work_auth", { type: "text", inputId: "work_auth" }],
      ]);
      const verify = await greenhouseVerifyFromPlan(
        page,
        [
          entry({
            field_id: "work_auth",
            label: "Are you legally authorized to work?",
            type: "text",
            canonical_field: "work_authorization",
            value: "Yes",
          }),
        ],
        meta,
      );
      expect(verify.passed).toBe(false); // committed display still placeholder
    });
  }, 30_000);

  it("healer honesty: un-committable combobox ends still_failing with truthful notes", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const report = await healFailedFillEntries({
        page,
        failedEntries: [
          entry({
            field_id: "country",
            label: "Country",
            value: "Atlantis", // not an option — must never appear anywhere
          }),
        ],
      });
      expect(report.healed).toEqual([]);
      expect(report.still_failing).toEqual(["country"]);
      expect(await readComboboxValue(page.locator("#country"))).toBeNull();
    });
  }, 30_000);

  it("healer heals a combobox with a REAL option after relocation", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      // Meta drift: entry points at a dead id; healer relocates by label,
      // then the combobox-aware retry commits a genuine option.
      const report = await healFailedFillEntries({
        page,
        failedEntries: [
          entry({
            field_id: "country_old",
            label: "Country",
            value: "United States",
          }),
        ],
      });
      expect(report.healed).toEqual(["country_old"]);
      expect(await readComboboxValue(page.locator("#country"))).toBe(
        "United States",
      );
    });
  }, 30_000);
});
