import { describe, expect, it } from "vitest";
import { loadAtsFixture, runAtsFixtureInspection } from "../../src/applications/atsFixtureInspect.js";
import { inspectApplicationHtml } from "../../src/applications/applicationInspector.js";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import { classifyEssayFields } from "../../src/applications/essayDetector.js";
import { mapDiscoveredFields } from "../../src/applications/fieldNormalization.js";
import { loadAnswerAliases } from "../../src/candidate/answerAliases.js";
import {
  assertFormFillAllowed,
  assertSubmitAllowed,
} from "../../src/applications/formFillGuards.js";
import { detectAts } from "../../src/ats/registry.js";
import { GREENHOUSE_ADAPTER_VERSION } from "../../src/ats/greenhouse/v1.js";
import { resetConfigCache } from "../../src/config/index.js";

describe("Phase 4 ATS inspection", () => {
  it("detects Greenhouse from fixture URL + form markers", async () => {
    const f = loadAtsFixture("greenhouse");
    const { detection, adapter } = await detectAts(f);
    expect(adapter.id).toBe("greenhouse");
    expect(detection.matched).toBe(true);
    expect(adapter.version).toBe(GREENHOUSE_ADAPTER_VERSION);
  });

  it("maps Greenhouse fields via answer aliases", async () => {
    const f = loadAtsFixture("greenhouse");
    const fields = discoverFieldsFromHtml(f.html, { preferGreenhouse: true });
    expect(fields.length).toBeGreaterThanOrEqual(6);
    const aliases = loadAnswerAliases();
    const mapped = mapDiscoveredFields(fields, aliases);
    const keys = mapped
      .map((m) => m.canonical_field)
      .filter(Boolean);
    expect(keys).toContain("legal_name.first");
    expect(keys).toContain("legal_name.last");
    expect(keys).toContain("email");
    expect(keys).toContain("requires_sponsorship");
  });

  it("routes greenhouse fixture to ready_for_fill_later", async () => {
    const { report } = await runAtsFixtureInspection("greenhouse");
    expect(report.inspection.ats).toBe("greenhouse");
    expect(report.route).toBe("ready_for_fill_later");
    expect(report.inspection_only).toBe(true);
    expect(report.form_fill_enabled).toBe(false);
  });

  it("flags essay fields and routes needs_essay", async () => {
    const f = loadAtsFixture("essay");
    const fields = discoverFieldsFromHtml(f.html);
    const essays = classifyEssayFields(fields).filter((e) => e.is_essay);
    expect(essays.length).toBeGreaterThanOrEqual(1);
    const report = await inspectApplicationHtml(f);
    expect(report.route).toBe("needs_essay");
  });

  it("detects demographics fields", async () => {
    const { report } = await runAtsFixtureInspection("demographics");
    expect(report.demographics_fields.length).toBeGreaterThanOrEqual(1);
  });

  it("routes captcha fixture to needs_human_captcha", async () => {
    const { report } = await runAtsFixtureInspection("captcha");
    expect(report.inspection.captcha_detected).toBe(true);
    expect(report.route).toBe("needs_human_captcha");
  });

  it("routes login-required to needs_login", async () => {
    const { report } = await runAtsFixtureInspection("login-required");
    expect(report.route).toBe("needs_login");
  });

  it("skips Workday as unsupported", async () => {
    const { report } = await runAtsFixtureInspection("workday");
    expect(report.route).toBe("skip_unsupported_ats");
    expect(report.inspection.ats).toBe("workday");
  });

  it("refuses form fill and submit while flags are off", () => {
    resetConfigCache();
    expect(() => assertFormFillAllowed("test")).toThrow(/FORM_FILL_ENABLED/);
    expect(() => assertSubmitAllowed("test")).toThrow(/FORM_FILL_ENABLED|SUBMIT_ENABLED/);
  });
});
