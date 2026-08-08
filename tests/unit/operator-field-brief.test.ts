import { describe, expect, it } from "vitest";
import {
  buildOperatorFieldBrief,
  formatOperatorFieldBriefPlain,
} from "../../src/applications/operatorFieldBrief.js";

describe("operatorFieldBrief", () => {
  it("surfaces location vs relocation mis-map with how-to-answer steps", () => {
    const brief = buildOperatorFieldBrief({
      context: "test",
      verify: {
        passed: false,
        fields: [
          {
            canonical_field: "relocation",
            expected: "Yes",
            observed: "",
            match: false,
          },
          {
            canonical_field: "email",
            expected: "a@b.com",
            observed: "a@b.com",
            match: true,
          },
        ],
        uploads: [],
        warnings: [],
      },
      fill: {
        filled: ["relocation"],
        skipped: [],
        errors: [],
        field_meta: [
          {
            field_id: "location-input",
            canonical_field: "relocation",
            control_kind: "text",
          },
        ],
      },
      planEntries: [
        {
          field_id: "location-input",
          label: "Current location",
          type: "text",
          canonical_field: "relocation",
          action: "fill",
          value: "Yes",
          reason: "from profile",
        },
      ],
    });

    expect(brief.fail_count).toBe(1);
    expect(brief.items[0]?.question).toBe("Current location");
    expect(brief.items[0]?.how_to_answer[0]).toMatch(/MISMAPPED/i);

    const plain = formatOperatorFieldBriefPlain(brief);
    expect(plain).toContain("OPERATOR FIELD BRIEF");
    expect(plain).toContain("HOW TO ANSWER:");
    expect(plain).toContain("Current location");
    expect(plain).toContain("address.city");
  });

  it("lists essay skips as human-authored actions when includePlanGaps", () => {
    const brief = buildOperatorFieldBrief({
      context: "plan",
      includePlanGaps: true,
      planEntries: [
        {
          field_id: "comments",
          label: "Additional information",
          type: "textarea",
          canonical_field: null,
          action: "skip_essay",
          value: null,
          reason: "essay",
        },
      ],
    });
    expect(brief.items[0]?.kind).toBe("plan_essay");
    expect(brief.items[0]?.how_to_answer.join(" ")).toMatch(/resume:essay/);
  });

  it("does not blame the operator for resume skip_file by default", () => {
    const brief = buildOperatorFieldBrief({
      context: "plan",
      planEntries: [
        {
          field_id: "resume-upload-input",
          label: "resume",
          type: "file",
          canonical_field: null,
          action: "skip_file",
          value: null,
          reason: "File uploads handled via uploadResume/uploadCoverLetter",
        },
      ],
    });
    expect(brief.fail_count).toBe(0);
  });
});
