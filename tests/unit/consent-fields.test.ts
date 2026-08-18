import { describe, expect, it } from "vitest";
import {
  buildFillPlan,
  type FillPlanEntry,
} from "../../src/applications/resolveAnswers.js";
import {
  toApprovedFillPlan,
  assertExecutableApprovedEntry,
} from "../../src/applications/approvedFillPlan.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import type { MappedField } from "../../src/applications/fieldNormalization.js";
import { isApplicationConsentField } from "../../src/applications/consentFields.js";

const profile = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
});

function mapped(
  partial: Partial<MappedField> & Pick<MappedField, "id" | "label" | "type">,
): MappedField {
  return {
    required: false,
    canonical_field: null,
    mapping_confidence: "none",
    ...partial,
  };
}

function entry(
  fields: MappedField[],
  id: string,
): FillPlanEntry | undefined {
  return buildFillPlan(fields, profile).entries.find((e) => e.field_id === id);
}

describe("application consent checkboxes (UNIT_CONFIRMED)", () => {
  it("auto-fills terms / privacy / certify; skips marketing and unlabeled cards", () => {
    expect(
      isApplicationConsentField({
        type: "checkbox",
        label: "I agree to the privacy policy",
      }),
    ).toBe(true);
    expect(
      isApplicationConsentField({
        type: "checkbox",
        label: "I certify the information is true and complete",
      }),
    ).toBe(true);
    expect(
      isApplicationConsentField({
        type: "checkbox",
        label: "Acknowledge/Confirm",
      }),
    ).toBe(true);
    expect(
      isApplicationConsentField({
        type: "checkbox",
        label:
          "Review our Notice at Collection to learn how we will process your personal data.",
      }),
    ).toBe(true);
    expect(
      isApplicationConsentField({
        type: "checkbox",
        label: "consent[marketing]",
        name: "consent[marketing]",
      }),
    ).toBe(false);
    expect(
      isApplicationConsentField({
        type: "checkbox",
        label: "cards[59debaa2-5176-4710-939f-293b52c27284][field0]",
      }),
    ).toBe(false);

    const fields = [
      mapped({
        id: "tos",
        label: "I agree to the Terms and Conditions",
        type: "checkbox",
      }),
      mapped({
        id: "mkt",
        label: "consent[marketing]",
        name: "consent[marketing]",
        type: "checkbox",
      }),
      mapped({
        id: "card",
        label: "cards[59debaa2-5176-4710-939f-293b52c27284][field0]",
        type: "checkbox",
      }),
    ];
    const tos = entry(fields, "tos")!;
    expect(tos.action).toBe("fill");
    expect(tos.value).toBe(true);
    const approved = toApprovedFillPlan([tos]);
    expect(approved.fillable_count).toBe(1);
    expect(() => assertExecutableApprovedEntry(approved.entries[0]!)).not.toThrow();

    expect(entry(fields, "mkt")?.action).toBe("skip_unmapped");
    expect(entry(fields, "card")?.action).toBe("skip_unmapped");
  });

  it("checks Acknowledge/Confirm as application consent", () => {
    const ack = entry(
      [
        mapped({
          id: "ack",
          label: "Acknowledge/Confirm",
          type: "checkbox",
          required: true,
        }),
      ],
      "ack",
    );
    expect(ack?.action).toBe("fill");
    expect(ack?.value).toBe(true);
  });

  it("decodes HTML entities so Terms &amp; Conditions auto-check", () => {
    expect(
      isApplicationConsentField({
        type: "checkbox",
        label: "I agree to the Terms &amp; Conditions",
      }),
    ).toBe(true);
    const tos = entry(
      [
        mapped({
          id: "tos_ent",
          label: "I agree to the Terms &amp; Conditions",
          type: "checkbox",
        }),
      ],
      "tos_ent",
    );
    expect(tos?.action).toBe("fill");
    expect(tos?.value).toBe(true);
  });

  it("checks a major checkbox that matches the public profile", () => {
    const withMajor = parsePublicProfile({
      legal_name: { first: "Ada", last: "Lovelace" },
      email: "ada@example.com",
      major: "Applied Mathematics & Statistics",
    });
    const plan = buildFillPlan(
      [
        mapped({
          id: "maj",
          label: "Applied Mathematics & Statistics",
          type: "checkbox",
        }),
        mapped({
          id: "other",
          label: "Electrical Engineering",
          type: "checkbox",
        }),
      ],
      withMajor,
    );
    const maj = plan.entries.find((e) => e.field_id === "maj");
    const other = plan.entries.find((e) => e.field_id === "other");
    expect(maj?.action).toBe("fill");
    expect(maj?.value).toBe(true);
    expect(other?.action).toBe("skip_unmapped");
  });
});
