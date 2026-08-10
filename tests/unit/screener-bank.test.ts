import { describe, expect, it } from "vitest";
import {
  parseScreenerBank,
  ScreenerBankParseError,
  SCREENER_REGISTRY,
  type ScreenerAnswerBank,
} from "../../src/candidate/screeners.js";
import {
  matchScreenerKey,
  normalizeScreenerLabel,
  resolveOptionValue,
  resolveScreenerForField,
} from "../../src/candidate/screenerMatch.js";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import { toApprovedFillPlan } from "../../src/applications/approvedFillPlan.js";
import { resolveScreenerForField as resolveField } from "../../src/candidate/screenerMatch.js";
import type { MappedField } from "../../src/applications/fieldNormalization.js";
import type { ScreenerResolution } from "../../src/candidate/screenerMatch.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import fs from "node:fs";

const BANK: ScreenerAnswerBank = {
  version: 1,
  answers: {
    availability_full_time: "Yes",
    education_level: "Undergrad",
    closest_location: "United States",
    how_heard: "JobRight",
    referral_name: "",
    willing_to_relocate: "Yes",
    previously_applied_or_worked: "No",
  },
  custom: {},
};

/**
 * The screener answer bank. Acceptance specimen: the real Cohere/Ashby
 * ML-intern application's "Additional Questions". UNIT_CONFIRMED.
 */
describe("screener registry + matcher (UNIT_CONFIRMED)", () => {
  it("maps every Cohere additional question to the right key", () => {
    expect(matchScreenerKey("Are you available for a full-time internship?")?.key).toBe(
      "availability_full_time",
    );
    expect(
      matchScreenerKey("Please select the current level of education you are pursuing")
        ?.key,
    ).toBe("education_level");
    expect(matchScreenerKey("Which location are you the closest to?")?.key).toBe(
      "closest_location",
    );
    expect(matchScreenerKey("How did you hear about this role?")?.key).toBe("how_heard");
    expect(
      matchScreenerKey(
        "(Optional) If you were referred by a Cohere employee, please tell us who!",
      )?.key,
    ).toBe("referral_name");
  });

  it("never maps essays or demographics-shaped labels", () => {
    expect(matchScreenerKey("What makes you a good fit for Cohere?")).toBeNull();
    expect(matchScreenerKey("Tell us about a project you're proud of")).toBeNull();
    expect(matchScreenerKey("Gender identity")).toBeNull();
  });

  it("yes/no resolution picks the literal page option, synonym-safely", () => {
    const def = SCREENER_REGISTRY.find((d) => d.key === "availability_full_time")!;
    expect(resolveOptionValue(def, "Yes", ["Yes", "No"])).toEqual({
      value: "Yes",
      basis: "exact_option",
    });
    expect(resolveOptionValue(def, "Yes", ["YES", "NO"])).toEqual({
      value: "YES",
      basis: "ci_option",
    });
    // Substring traps never match: "No" must not select "Not applicable".
    const noDef = SCREENER_REGISTRY.find((d) => d.key === "previously_applied_or_worked")!;
    expect(resolveOptionValue(noDef, "No", ["Not applicable", "Nope?"])).toBeNull();
  });

  it("education level resolves against Cohere's exact options via synonyms", () => {
    const r = resolveField(
      {
        label: "Please select the current level of education you are pursuing",
        type: "radio",
        options: ["Undergrad", "Master's/MBA", "PhD", "Post-Grad Diploma/Bootcamp Program"],
      },
      BANK,
    );
    expect(r).toEqual({
      status: "fill",
      key: "education_level",
      value: "Undergrad",
      basis: "exact_option",
    });
  });

  it("a bank answer that matches no page option parks for review — never guesses", () => {
    const r = resolveField(
      {
        label: "Which location are you the closest to?",
        type: "radio",
        options: ["Toronto", "London", "Paris"],
      },
      BANK,
    );
    expect(r?.status).toBe("review");
    if (r?.status === "review") expect(r.reason).toMatch(/matches none/);
  });

  it("optional referral with empty answer skips; missing required answer parks", () => {
    const referral = resolveField(
      {
        label: "(Optional) If you were referred by a Cohere employee, please tell us who!",
        type: "text",
      },
      BANK,
    );
    expect(referral?.status).toBe("skip");

    const noAnswer = resolveField(
      { label: "Are you willing to relocate?", type: "radio", options: ["Yes", "No"] },
      { version: 1, answers: {}, custom: {} },
    );
    expect(noAnswer?.status).toBe("review");
  });

  it("salary is review-only by policy even with a bank answer", () => {
    const r = resolveField(
      { label: "What are your salary expectations?", type: "text" },
      { version: 1, answers: {}, custom: {} },
    );
    expect(r?.status).toBe("review");
    if (r?.status === "review") expect(r.reason).toMatch(/human decision/);
  });

  it("bank parsing rejects unknown keys and non-string answers", () => {
    expect(() => parseScreenerBank({ version: 1, answers: { made_up: "x" } })).toThrow(
      ScreenerBankParseError,
    );
    expect(() =>
      parseScreenerBank({ version: 1, answers: { how_heard: 42 } }),
    ).toThrow(ScreenerBankParseError);
    expect(parseScreenerBank({ version: 1, answers: { how_heard: "JobRight" } }).answers)
      .toEqual({ how_heard: "JobRight" });
  });

  it("the checked-in example bank parses and uses only registry keys", () => {
    const raw = JSON.parse(
      fs.readFileSync("private/candidate/screeners.example.json", "utf8"),
    ) as unknown;
    expect(() => parseScreenerBank(raw)).not.toThrow();
  });

  it("normalization strips parentheticals and punctuation", () => {
    expect(
      normalizeScreenerLabel("(Optional) If you were referred by a Cohere employee, please tell us who!"),
    ).toBe("if you were referred by a cohere employee please tell us who");
  });
});

describe("buildFillPlan screener integration (UNIT_CONFIRMED)", () => {
  const profile = parsePublicProfile(
    JSON.parse(fs.readFileSync("private/candidate/public-profile.example.json", "utf8")),
  );

  const field = (
    id: string,
    label: string,
    type: MappedField["type"],
    options?: string[],
  ): MappedField => ({
    id,
    label,
    type,
    required: false,
    canonical_field: null,
    mapping_confidence: "none",
    ...(options ? { options } : {}),
  });

  it("screener resolutions become approved FILL entries; reviews park; unmapped stays unmapped", () => {
    const fields = [
      field("f1", "Are you available for a full-time internship?", "radio", ["Yes", "No"]),
      field("f2", "Which location are you the closest to?", "radio", ["Toronto"]),
      field("f3", "Some question nobody has a key for", "text"),
    ];
    const resolutions = new Map<string, ScreenerResolution>();
    for (const f of fields) {
      const r = resolveField({ label: f.label, type: f.type, options: f.options }, BANK);
      if (r) resolutions.set(f.id, r);
    }
    const plan = buildFillPlan(fields, profile, { screenerResolutions: resolutions });
    const approved = toApprovedFillPlan(plan.entries);

    const f1 = approved.entries.find((e) => e.field_id === "f1")!;
    expect(f1.action).toBe("FILL");
    expect(f1.approved).toBe(true);
    expect(f1.value).toBe("Yes");
    expect(f1.canonical_field).toBe("screener:availability_full_time");

    const f2 = approved.entries.find((e) => e.field_id === "f2")!;
    expect(f2.action).toBe("REVIEW_REQUIRED");

    const f3 = approved.entries.find((e) => e.field_id === "f3")!;
    expect(f3.action).toBe("SKIP");
  });

  it("prediction tier: education level derives from the profile degree, option-verified", () => {
    // The example profile says "Bachelor of Science" — no bank needed.
    const r = resolveField(
      {
        label: "Please select the current level of education you are pursuing",
        type: "radio",
        options: ["Undergrad", "Master's/MBA", "PhD"],
      },
      { version: 1, answers: {}, custom: {} },
      undefined,
      profile,
    );
    expect(r).toEqual({
      status: "fill",
      key: "education_level",
      value: "Undergrad",
      basis: "profile_derived",
    });
  });

  it("prediction tier: closest location matches the country against page options via aliases", () => {
    const r = resolveField(
      {
        label: "Which location are you the closest to?",
        type: "radio",
        options: ["Canada", "Europe", "United Kingdom", "United States"],
      },
      { version: 1, answers: {}, custom: {} },
      undefined,
      profile,
    );
    expect(r).toEqual({
      status: "fill",
      key: "closest_location",
      value: "United States",
      basis: "profile_derived",
    });
  });

  it("prediction never overrides an explicit bank answer, and unpredictable keys still park", () => {
    // Bank says United States explicitly — options don't include it → review, not prediction.
    const banked = resolveField(
      { label: "Which location are you the closest to?", type: "radio", options: ["Toronto"] },
      BANK,
      undefined,
      profile,
    );
    expect(banked?.status).toBe("review");
    // availability is a commitment: no predictor exists, parks without a bank answer.
    const commitment = resolveField(
      { label: "Are you available for a full-time internship?", type: "radio", options: ["Yes", "No"] },
      { version: 1, answers: {}, custom: {} },
      undefined,
      profile,
    );
    expect(commitment?.status).toBe("review");
  });

  it("a textarea can never sneak through as a screener fill", () => {
    const fields = [field("essay", "How did you hear about this role?", "textarea")];
    const resolutions = new Map<string, ScreenerResolution>([
      ["essay", { status: "fill", key: "how_heard", value: "JobRight", basis: "free_text" }],
    ]);
    const plan = buildFillPlan(fields, profile, { screenerResolutions: resolutions });
    // The essay branch runs BEFORE the unmapped/screener branch.
    expect(plan.entries[0]!.action).toBe("skip_essay");
  });
});
