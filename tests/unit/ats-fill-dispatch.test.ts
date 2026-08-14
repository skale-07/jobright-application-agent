import { beforeEach, describe, expect, it } from "vitest";
import {
  planApplicationFill,
  runAtsFixtureFill,
} from "../../src/applications/applicationFiller.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import {
  applyFixtureFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
});

describe("applicationFiller multi-ATS dispatch (W2)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it("plans a lever fixture fill with the composed full name (UNIT_CONFIRMED)", async () => {
    const report = await runAtsFixtureFill("lever", {
      execute: false,
      profile: PROFILE,
    });
    expect(report.ats).toBe("lever");
    expect(report.mode).toBe("plan_only");
    const nameEntry = report.approved_plan!.entries.find(
      (e) => e.field_id === "name",
    )!;
    expect(nameEntry.approved).toBe(true);
    expect(nameEntry.value).toBe("Ada Lovelace");
  });

  it("plans an ashby fixture fill with the composed full name (UNIT_CONFIRMED)", async () => {
    const report = await runAtsFixtureFill("ashby", {
      execute: false,
      profile: PROFILE,
    });
    expect(report.ats).toBe("ashby");
    const nameEntry = report.approved_plan!.entries.find(
      (e) => e.field_id === "_systemfield_name",
    )!;
    expect(nameEntry.approved).toBe(true);
    expect(nameEntry.value).toBe("Ada Lovelace");
  });

  it("a company-hosted URL plans via the generic adapter (UNIT_CONFIRMED)", async () => {
    // Formerly a refusal: the generic adapter lost its flag (operator
    // directive 2026-08-14), so the long tail plans instead of parking.
    const { adapter } = await planApplicationFill({
      url: "https://careers.example.com/apply",
      html: "<html><body><form><input name='q'></form></body></html>",
      profile: PROFILE,
    });
    expect(adapter.id).toBe("generic");
  });

  it("still refuses non-fillable fixture names", async () => {
    await expect(
      runAtsFixtureFill("workday", { execute: false, profile: PROFILE }),
    ).rejects.toThrow(/limited to greenhouse\/essay\/lever\/ashby/);
  });

  it(
    "executes a lever fixture fill end to end through the dispatcher (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      try {
        const report = await runAtsFixtureFill("lever", {
          execute: true,
          profile: PROFILE,
        });
        expect(report.ats).toBe("lever");
        expect(report.mode).toBe("executed");
        expect(report.fill!.errors).toEqual([]);
        for (const canonical of ["legal_name.first", "email", "phone"]) {
          expect(report.fill!.filled).toContain(canonical);
        }
        expect(report.verify!.passed).toBe(true);
        expect(report.notes.join(" ")).toMatch(/submit not called/);
      } finally {
        applySafeFillEnv();
      }
    },
    60_000,
  );

  it(
    "executes an ashby fixture fill end to end through the dispatcher (FIXTURE_CONFIRMED)",
    async () => {
      applyFixtureFillEnv();
      try {
        const report = await runAtsFixtureFill("ashby", {
          execute: true,
          profile: PROFILE,
        });
        expect(report.ats).toBe("ashby");
        expect(report.fill!.errors).toEqual([]);
        for (const canonical of ["legal_name.first", "email", "phone"]) {
          expect(report.fill!.filled).toContain(canonical);
        }
        expect(report.verify!.passed).toBe(true);
        // Ashby field_meta flows through for the fill-outcomes corpus.
        expect(report.fill!.field_meta).toBeDefined();
      } finally {
        applySafeFillEnv();
      }
    },
    60_000,
  );
});
