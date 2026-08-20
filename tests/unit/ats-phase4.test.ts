import { beforeEach, describe, expect, it } from "vitest";
import {
  loadAtsFixture,
  runAtsFixtureInspection,
} from "../../src/applications/atsFixtureInspect.js";
import { inspectApplicationHtml } from "../../src/applications/applicationInspector.js";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import { classifyEssayFields } from "../../src/applications/essayDetector.js";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import { mapDiscoveredFields } from "../../src/applications/fieldNormalization.js";
import { loadAnswerAliases } from "../../src/candidate/answerAliases.js";
import {
  assertFormFillAllowed,
  assertSubmitAllowed,
} from "../../src/applications/formFillGuards.js";
import { detectAts } from "../../src/ats/registry.js";
import { GREENHOUSE_ADAPTER_VERSION } from "../../src/ats/greenhouse/v1.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

describe("Phase 4 ATS inspection", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    // Explicit — do not rely on .env, shell, or prior files
    applySafeFillEnv();
  });

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
    const keys = mapped.map((m) => m.canonical_field).filter(Boolean);
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

  it("flags essay fields and routes needs_essay when gate is on", async () => {
    applyControlledFillEnv({ ESSAY_REQUIRED_GATE_ENABLED: "true" });
    const f = loadAtsFixture("essay");
    const fields = discoverFieldsFromHtml(f.html);
    const essays = classifyEssayFields(fields).filter((e) => e.is_essay);
    expect(essays.length).toBeGreaterThanOrEqual(1);
    const report = await inspectApplicationHtml(f);
    expect(report.route).toBe("needs_essay");
  });

  it("does not hard-stop on essays when ESSAY_REQUIRED_GATE_ENABLED is off (default)", async () => {
    const f = loadAtsFixture("essay");
    const report = await inspectApplicationHtml(f);
    expect(report.route).not.toBe("needs_essay");
    // Heuristic classification still reported for observability;
    // only routing is gated off.
    expect(report.essays.length).toBeGreaterThanOrEqual(1);
  });

  it("a one-line 'describe … in one word' input is not an essay", () => {
    const essays = classifyEssayFields([
      {
        id: "q_spirit",
        label: "Describe your debugging spirit animal in one word.",
        type: "text",
        required: false,
      },
      {
        id: "w_about",
        label: "Tell us something about yourself that we can't find on your resume.",
        type: "textarea",
        required: false,
      },
    ]);
    expect(essays.find((e) => e.field_id === "q_spirit")?.is_essay).toBe(false);
    expect(essays.find((e) => e.field_id === "w_about")?.is_essay).toBe(true);
  });

  it("a 'if you said yes above' follow-up is not an essay, and is skipped when the parent is No", () => {
    const followUp = {
      id: "offers_detail",
      label: "If you said yes above, please tell us about your offers and deadlines.",
      type: "text" as const,
      required: false,
      maxLength: 500,
    };
    const classified = classifyEssayFields([followUp]);
    expect(classified[0]?.is_essay).toBe(false);

    const profile = parsePublicProfile({
      legal_name: { first: "Ada", last: "Lovelace" },
      email: "ada@example.com",
    });
    const plan = buildFillPlan(
      [
        {
          id: "offers_yn",
          label: "Do you currently have any offers from other firms?",
          type: "select",
          required: true,
          canonical_field: null,
          mapping_confidence: "none",
        },
        {
          ...followUp,
          canonical_field: null,
          mapping_confidence: "none",
        },
      ],
      profile,
      {
        screenerResolutions: new Map([
          [
            "offers_yn",
            {
              key: "competing_offers",
              status: "fill",
              value: "No",
              basis: "exact_option",
            },
          ],
        ]),
      },
    );
    expect(plan.entries.find((e) => e.field_id === "offers_detail")?.action).toBe(
      "skip_empty",
    );
    expect(plan.entries.find((e) => e.field_id === "offers_detail")?.reason).toMatch(
      /parent answer is No/,
    );
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

  it("recognizes Workday and routes its account wall to needs_login", async () => {
    // Inspector still reports needs_login (the page is an account wall).
    // The pipeline sends Workday to fill when NAVIGATION_ENABLED so
    // portalAuth can run — that is not a human AUTH_REQUIRED park.
    const { report } = await runAtsFixtureInspection("workday");
    expect(report.inspection.ats).toBe("workday");
    expect(report.route).toBe("needs_login");
  });

  it("refuses form fill and submit while flags are off", () => {
    applySafeFillEnv();
    resetConfigCache();
    expect(() => assertFormFillAllowed("test")).toThrow(/FORM_FILL_ENABLED/);
    expect(() => assertSubmitAllowed("test")).toThrow(
      /FORM_FILL_ENABLED|SUBMIT_ENABLED/,
    );
  });
});

describe("consent-manager DOM exclusion (UNIT_CONFIRMED)", () => {
  // Live Paylocity 2026-08-19: OneTrust's banner contributed 6 "fields"
  // (cookie toggles + hidden template placeholders "checkbox label" /
  // "Switch Label"), inflating the count that decides posting-vs-form and
  // polluting the operator brief. The subtree is furniture, not the form.
  const CONSENT_HTML = `<html><body>
    <div id="onetrust-consent-sdk">
      <div id="onetrust-pc-sdk" class="otPcCenter">
        <input type="checkbox" id="ot-group-id-C0004" aria-label="Targeting Cookies" />
        <input type="checkbox" id="ot-group-id-C0002" aria-label="Performance Cookies" />
        <input type="checkbox" id="chkbox-id" aria-label="checkbox label" />
        <input type="checkbox" id="select-all-vendor-groups-handler" aria-label="Switch Label" />
        <input type="text" id="vendor-search-handler" placeholder="Search…" />
      </div>
    </div>
    <label for="info.firstName">First Name</label>
    <input type="text" id="info.firstName" name="firstName" />
    <label for="info.email">Email</label>
    <input type="email" id="info.email" name="email" />
  </body></html>`;

  it("cookie-banner controls are never discovered as application fields", () => {
    const fields = discoverFieldsFromHtml(CONSENT_HTML);
    const ids = fields.map((f) => f.id);
    expect(ids).toContain("info.firstName");
    expect(ids).toContain("info.email");
    expect(ids.join(" ")).not.toMatch(/ot-group|chkbox-id|vendor|handler/);
    expect(fields).toHaveLength(2);
  });

  it("optanon-classed and data-optanongroupid subtrees are dropped too", () => {
    const html = `<html><body>
      <div class="optanon-alert-box-wrapper"><input type="checkbox" id="opt-1" /></div>
      <div data-optanongroupid="C0003"><input type="checkbox" id="opt-2" /></div>
      <input type="text" id="real" name="city" aria-label="City" />
    </body></html>`;
    const ids = discoverFieldsFromHtml(html).map((f) => f.id);
    expect(ids).toEqual(["real"]);
  });
});
