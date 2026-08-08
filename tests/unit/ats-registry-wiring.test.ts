import { beforeEach, describe, expect, it } from "vitest";
import {
  loadAtsFixture,
  runAtsFixtureInspection,
} from "../../src/applications/atsFixtureInspect.js";
import { inspectApplicationHtml } from "../../src/applications/applicationInspector.js";
import { detectAts, listAdapters } from "../../src/ats/registry.js";
import { LeverAdapterV1 } from "../../src/ats/lever/v1.js";
import { AshbyAdapterV1 } from "../../src/ats/ashby/v1.js";
import { SubmissionUncertainError as GreenhouseSubmissionUncertainError } from "../../src/ats/greenhouse/submission.js";
import { SubmissionUncertainError as LeverSubmissionUncertainError } from "../../src/ats/lever/submission.js";
import { SubmissionUncertainError as AshbySubmissionUncertainError } from "../../src/ats/ashby/submission.js";
import { toApprovedFillPlan } from "../../src/applications/approvedFillPlan.js";
import { GreenhouseAdapterV1 } from "../../src/ats/greenhouse/v1.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

describe("ATS registry wiring (W1, UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  it("registers all five adapters", () => {
    expect(listAdapters().map((a) => a.id)).toEqual([
      "unsupported",
      "greenhouse",
      "lever",
      "ashby",
      "generic",
    ]);
  });

  it("routes the lever fixture to the lever adapter", async () => {
    const { adapter, detection } = await detectAts(loadAtsFixture("lever"));
    expect(adapter.id).toBe("lever");
    expect(detection.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("routes the ashby fixture to the ashby adapter", async () => {
    const { adapter, detection } = await detectAts(loadAtsFixture("ashby"));
    expect(adapter.id).toBe("ashby");
    expect(detection.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("greenhouse and workday routing are unchanged", async () => {
    const g = await detectAts(loadAtsFixture("greenhouse"));
    expect(g.adapter.id).toBe("greenhouse");
    const w = await detectAts(loadAtsFixture("workday"));
    expect(w.adapter.id).toBe("unsupported");
  });

  it("inspector treats lever and ashby as supported (essay route, not unsupported)", async () => {
    // Both fixtures carry an essay textarea; with the essay gate on,
    // needs_essay wins — the point is they no longer fall to
    // skip_unsupported_ats/inspect_only.
    applyControlledFillEnv({ ESSAY_REQUIRED_GATE_ENABLED: "true" });
    for (const name of ["lever", "ashby"] as const) {
      const report = await inspectApplicationHtml(loadAtsFixture(name));
      expect(report.inspection.ats).toBe(name);
      expect(report.route).toBe("needs_essay");
    }
  });

  it("essay-free lever/ashby forms stay on supported routes, never unsupported", async () => {
    // With the textareas stripped, the unmapped custom questions route to
    // human review — the invariant under test is that lever/ashby never
    // fall to the unsupported/inspect-only buckets anymore.
    for (const name of ["lever", "ashby"] as const) {
      const fixture = loadAtsFixture(name);
      const html = fixture.html.replace(/<textarea[\s\S]*?<\/textarea>/gi, "");
      const report = await inspectApplicationHtml({ ...fixture, html });
      expect(report.inspection.ats).toBe(name);
      expect(["ready_for_fill_later", "needs_review_unmapped"]).toContain(
        report.route,
      );
      expect(report.route).not.toBe("skip_unsupported_ats");
      expect(report.route).not.toBe("inspect_only");
    }
  });

  it("fixture inspection runs cleanly for the new names", async () => {
    for (const name of ["lever", "ashby"] as const) {
      const { report } = await runAtsFixtureInspection(name);
      expect(report.inspection.ats).toBe(name);
      expect(report.form_fill_enabled).toBe(false);
    }
  });

  it("setApprovedFillPlan without a profile fails closed on lever/ashby, not greenhouse", () => {
    const plan = toApprovedFillPlan([]);
    expect(() => new LeverAdapterV1().setApprovedFillPlan(plan)).toThrow(
      /requires the public profile/,
    );
    expect(() => new AshbyAdapterV1().setApprovedFillPlan(plan)).toThrow(
      /requires the public profile/,
    );
    expect(() =>
      new GreenhouseAdapterV1().setApprovedFillPlan(plan),
    ).not.toThrow();
  });

  it("SubmissionUncertainError is one class across all three ATSes", () => {
    expect(LeverSubmissionUncertainError).toBe(
      GreenhouseSubmissionUncertainError,
    );
    expect(AshbySubmissionUncertainError).toBe(
      GreenhouseSubmissionUncertainError,
    );
    const thrown = new LeverSubmissionUncertainError("x", { a: 1 });
    expect(thrown instanceof GreenhouseSubmissionUncertainError).toBe(true);
  });
});
