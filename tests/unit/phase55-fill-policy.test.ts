import { describe, expect, it } from "vitest";
import { GreenhouseAdapterV1 } from "../../src/ats/greenhouse/v1.js";
import {
  toApprovedFillPlan,
  assertExecutableApprovedEntry,
  type ApprovedFillPlanEntry,
} from "../../src/applications/approvedFillPlan.js";
import {
  buildFillPlan,
  isWorkAuthorizationField,
  type FillPlanEntry,
} from "../../src/applications/resolveAnswers.js";
import { mapDiscoveredFields } from "../../src/applications/fieldNormalization.js";
import { loadAnswerAliases } from "../../src/candidate/answerAliases.js";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import { loadPublicProfile } from "../../src/candidate/publicProfileIO.js";
import { loadAtsFixture } from "../../src/applications/atsFixtureInspect.js";
import { greenhouseFillFromPlan } from "../../src/ats/greenhouse/fill.js";
import { redactFillReportForArtifact } from "../../src/applications/fillReportRedaction.js";
import {
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const baseProfile = parsePublicProfile({
  ...loadPublicProfile(),
  legal_name: { first: "Ada", middle: "", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
  school: "Johns Hopkins University",
  graduation_year: 2029,
  requires_sponsorship: "No",
});

function factualFillEntry(
  overrides: Partial<ApprovedFillPlanEntry> = {},
): ApprovedFillPlanEntry {
  return {
    field_id: "first_name",
    label: "First name",
    type: "text",
    canonical_field: "legal_name.first",
    action: "FILL",
    approved: true,
    value: "Ada",
    reason: "test",
    ...overrides,
  };
}

describe("Phase 5.5 fill policy", () => {
  useIsolatedFillEnv("fixture_fill");

  it("rejects direct fill without an approved plan", async () => {
    const adapter = new GreenhouseAdapterV1();
    await expect(
      adapter.fill({} as never, { email: "x@y.com" }),
    ).rejects.toThrow(/Approved fill plan required/);
  });

  it("rejects essay/textarea entries without a generated canonical", async () => {
    const essay: ApprovedFillPlanEntry = factualFillEntry({
      field_id: "cover",
      label: "Why do you want this job?",
      type: "textarea",
      canonical_field: null,
      action: "FILL",
      approved: true,
      value: "I love coding",
    });
    expect(() => assertExecutableApprovedEntry(essay)).toThrow(/textarea|essay/i);

    const result = await greenhouseFillFromPlan(
      {} as never,
      [essay],
      new Map(),
    );
    expect(result.filled).toEqual([]);
    expect(result.errors.some((e) => /textarea|essay|not approved|Refusing/i.test(e))).toBe(
      true,
    );
  });

  it("allows a generated essay through the executor gate", () => {
    const essay: ApprovedFillPlanEntry = factualFillEntry({
      field_id: "cover",
      label: "Tell us something about yourself",
      type: "textarea",
      canonical_field: "essay:generated:cover",
      action: "FILL",
      approved: true,
      value: "I knocked on Garland Hall until someone let us pitch.",
    });
    expect(() => assertExecutableApprovedEntry(essay)).not.toThrow();
  });

  it("rejects unapproved entries even when action pretends to fill", async () => {
    const unapproved: FillPlanEntry = {
      field_id: "email",
      label: "Email",
      type: "text",
      canonical_field: "email",
      action: "fill",
      value: "ada@example.com",
      reason: "sneaky direct entry without approved:true",
    };
    const result = await greenhouseFillFromPlan(
      {} as never,
      [unapproved],
      new Map(),
    );
    expect(result.filled).toEqual([]);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("does not invent No when sponsorship is missing", () => {
    const fixture = loadAtsFixture("greenhouse");
    const fields = discoverFieldsFromHtml(fixture.html, {
      preferGreenhouse: true,
    });
    const mapped = mapDiscoveredFields(fields, loadAnswerAliases());
    const profile = parsePublicProfile({
      ...baseProfile,
      requires_sponsorship: "",
    });
    const plan = buildFillPlan(mapped, profile);

    expect(plan.answers["requires_sponsorship"]).toBeUndefined();
    expect(
      plan.entries.some(
        (e) =>
          e.canonical_field === "requires_sponsorship" &&
          e.action === "fill" &&
          (e.value === "No" || e.value === "Yes"),
      ),
    ).toBe(false);

    const sponsorship = plan.entries.find(
      (e) => e.canonical_field === "requires_sponsorship",
    );
    expect(sponsorship).toBeDefined();
    expect(sponsorship?.action).toBe("review_required");
    expect(sponsorship?.value).toBeNull();

    const approved = toApprovedFillPlan(plan.entries);
    expect(approved.answers["requires_sponsorship"]).toBeUndefined();
    expect(
      approved.entries.some(
        (e) =>
          e.canonical_field === "requires_sponsorship" && e.approved === true,
      ),
    ).toBe(false);
    expect(approved.review_required_count).toBeGreaterThanOrEqual(1);
  });

  it("isWorkAuthorizationField matches canonical and label forms", () => {
    expect(isWorkAuthorizationField("requires_sponsorship")).toBe(true);
    expect(isWorkAuthorizationField("work_authorization")).toBe(true);
    expect(
      isWorkAuthorizationField(
        "Will you now or in the future require sponsorship?",
      ),
    ).toBe(true);
    expect(isWorkAuthorizationField("email")).toBe(false);
    expect(isWorkAuthorizationField(null)).toBe(false);
  });

  it("approves valid factual fills from public profile", () => {
    const fixture = loadAtsFixture("greenhouse");
    const fields = discoverFieldsFromHtml(fixture.html, {
      preferGreenhouse: true,
    });
    const mapped = mapDiscoveredFields(fields, loadAnswerAliases());
    const plan = buildFillPlan(mapped, baseProfile);
    const approved = toApprovedFillPlan(plan.entries);

    expect(approved.fillable_count).toBeGreaterThanOrEqual(3);
    expect(approved.answers["legal_name.first"]).toBe("Ada");
    expect(approved.answers.email).toBe("ada@example.com");
    expect(approved.answers["requires_sponsorship"]).toBe("No");

    const first = approved.entries.find(
      (e) => e.canonical_field === "legal_name.first",
    );
    expect(first?.approved).toBe(true);
    expect(first?.action).toBe("FILL");
    expect(() => assertExecutableApprovedEntry(first!)).not.toThrow();
  });

  it("never approves essay fields", () => {
    const essayHtml = loadAtsFixture("essay").html;
    const fields = discoverFieldsFromHtml(essayHtml, { preferGreenhouse: true });
    const mapped = mapDiscoveredFields(fields, loadAnswerAliases());
    const plan = buildFillPlan(mapped, baseProfile);
    const approved = toApprovedFillPlan(plan.entries);
    expect(
      approved.entries.some((e) => e.approved && e.type === "textarea"),
    ).toBe(false);
    expect(
      plan.entries.some((e) => e.action === "skip_essay"),
    ).toBe(true);
  });

  it("redacts email, phone, sponsorship, and paths in fill reports", () => {
    const redacted = redactFillReportForArtifact({
      plan: {
        answers: {
          email: "ada@example.com",
          phone: "555-0100",
          requires_sponsorship: "No",
          school: "JHU",
        },
      },
      report_path: "C:\\secrets\\fill-report.json",
      uploads: [{ path: "C:\\secrets\\resume.pdf", filename: "resume.pdf" }],
    });
    const answers = (redacted["plan"] as { answers: Record<string, unknown> })
      .answers;
    expect(String(answers["email"])).not.toBe("ada@example.com");
    expect(String(answers["phone"])).not.toBe("555-0100");
    expect(answers["requires_sponsorship"]).toBe("[REDACTED_SPONSORSHIP]");
    expect(answers["school"]).toBe("JHU");
    expect(redacted["report_path"]).toBe("[REDACTED_PATH]");
  });
});
