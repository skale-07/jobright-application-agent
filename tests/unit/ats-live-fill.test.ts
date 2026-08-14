import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runAtsLiveFill } from "../../src/applications/atsLiveFill.js";
import { ATS_BINDINGS } from "../../src/applications/atsBindings.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import {
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ats");

function fixtureHtml(name: string): string {
  return fs.readFileSync(
    path.join(FIXTURE_DIR, name, "dom.sanitized.html"),
    "utf8",
  );
}

const LEVER_URL =
  "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply";
const ASHBY_URL =
  "https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab/application";

const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
});

describe("runAtsLiveFill (W5)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it("refuses a URL its binding does not own, before any page (UNIT_CONFIRMED)", async () => {
    const report = await runAtsLiveFill({
      binding: ATS_BINDINGS.lever,
      url: ASHBY_URL,
      execute: false,
    });
    expect(report.mode).toBe("refused");
    expect(report.gate.failure_code).toBe("ATS_MISMATCH");
  });

  it("refuses a URL another adapter claims — binding mismatch, not silence (UNIT_CONFIRMED)", async () => {
    // careers.example.com is now claimed by the generic adapter (no flag),
    // so running it under the LEVER binding is a mismatch, still refused
    // before any mutation.
    const report = await runAtsLiveFill({
      binding: ATS_BINDINGS.lever,
      url: "https://careers.example.com/apply/1",
      execute: false,
    });
    expect(report.mode).toBe("refused");
    expect(report.gate.failure_code).toBe("ATS_MISMATCH");
  });

  it(
    "refuses without mutation when no application form is on the page (FIXTURE_CONFIRMED)",
    async () => {
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.lever,
        url: LEVER_URL,
        execute: true,
        fixtureHtml: "<html><body><h1>Position closed</h1></body></html>",
      });
      expect(report.mode).toBe("refused");
      expect(report.gate.failure_code).toBe("NO_APPLICATION_FORM");
      expect(report.fill).toBeNull();
      expect(report.validation_level).toBe("UNVERIFIED");
    },
    45_000,
  );

  it(
    "plan_only run builds the composed plan without mutating (FIXTURE_CONFIRMED)",
    async () => {
      const report = await runAtsLiveFill({
        binding: ATS_BINDINGS.lever,
        url: LEVER_URL,
        execute: false,
        profile: PROFILE,
        fixtureHtml: fixtureHtml("lever"),
      });
      expect(report.mode).toBe("plan_only");
      expect(report.gate.ok).toBe(true);
      expect(report.plan_summary!.fillable_count).toBeGreaterThanOrEqual(3);
      expect(report.fill).toBeNull();
      expect(report.submit_attempted).toBe(false);
      // Fixture-served page: the level must be demoted, never a live claim.
      expect(report.validation_level).toBe("UNVERIFIED");
      expect(report.notes.join(" ")).toMatch(/not live evidence/);
      expect(report.report_path && fs.existsSync(report.report_path)).toBe(true);
    },
    45_000,
  );

  it(
    "execute refuses under safe flags before any field mutation (FIXTURE_CONFIRMED)",
    async () => {
      await expect(
        runAtsLiveFill({
          binding: ATS_BINDINGS.ashby,
          url: ASHBY_URL,
          execute: true,
          profile: PROFILE,
          fixtureHtml: fixtureHtml("ashby"),
        }),
      ).rejects.toThrow(/FORM_FILL_ENABLED|DRY_RUN/);
    },
    45_000,
  );
});
