import type { DiscoveredField } from "../adapter.js";
import type { MappedField } from "../../applications/fieldNormalization.js";
import {
  essayFieldsOnly,
  isDemographicsField,
} from "../../applications/essayDetector.js";
import { isWorkAuthorizationField } from "../../applications/resolveAnswers.js";
import { normalizeFieldLabel } from "../../applications/fieldNormalization.js";
import { SAFE_FACTUAL_CANONICALS } from "../../applications/approvedFillPlan.js";

export type FieldClassification =
  | "DETERMINISTIC"
  | "SPONSORSHIP"
  | "ESSAY"
  | "DEMOGRAPHIC"
  | "FILE_UPLOAD"
  | "CONSENT"
  | "UNSUPPORTED"
  | "UNKNOWN";

export type ProposedAction =
  | "FILL_CANDIDATE"
  | "REVIEW_REQUIRED"
  | "SKIP_ESSAY"
  | "SKIP_DEMOGRAPHIC"
  | "UPLOAD_CANDIDATE"
  | "UNSUPPORTED";

export type ProposedFillPlanEntry = {
  field_id: string;
  label: string;
  type: DiscoveredField["type"];
  classification: FieldClassification;
  canonical_field: string | null;
  proposed_action: ProposedAction;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  warnings: string[];
  /** True when live page had a nonempty value — value itself is never included. */
  prefilled_value_present: boolean;
};

export type ProposedFillPlan = {
  entries: ProposedFillPlanEntry[];
  summary: {
    deterministic: number;
    sponsorship: number;
    essay: number;
    demographic: number;
    file_upload: number;
    consent: number;
    unsupported: number;
    unknown: number;
  };
};

const DETERMINISTIC_CANONICALS = new Set(
  [...SAFE_FACTUAL_CANONICALS].filter(
    (k) => k !== "requires_sponsorship" && k !== "work_authorization",
  ),
);

function isConsentField(field: DiscoveredField): boolean {
  const n = normalizeFieldLabel(
    `${field.label} ${field.name ?? ""} ${field.inputId ?? ""}`,
  );
  return /privacy|terms (of|and)|consent|acknowledge|agree to|data processing|gdpr/.test(
    n,
  );
}

function isUnsupportedWidget(field: DiscoveredField): boolean {
  if (field.type === "unknown" || field.type === "date") return true;
  const n = normalizeFieldLabel(`${field.label} ${field.name ?? ""}`);
  return /video|assessment|calendar|schedule interview|multi-?file/.test(n);
}

/**
 * Build a proposed (not approved) fill plan with no candidate values.
 * Does not load public or sensitive profiles.
 */
export function buildProposedFillPlan(
  mapped: MappedField[],
  options?: {
    prefilledFieldIds?: Set<string>;
  },
): ProposedFillPlan {
  const essayIds = new Set(
    essayFieldsOnly(mapped)
      .filter((e) => e.is_essay)
      .map((e) => e.field_id),
  );
  const prefilled = options?.prefilledFieldIds ?? new Set<string>();

  const entries: ProposedFillPlanEntry[] = [];
  const summary = {
    deterministic: 0,
    sponsorship: 0,
    essay: 0,
    demographic: 0,
    file_upload: 0,
    consent: 0,
    unsupported: 0,
    unknown: 0,
  };

  for (const field of mapped) {
    const warnings: string[] = [];
    const prefilled_value_present = prefilled.has(field.id);
    if (prefilled_value_present) {
      warnings.push("prefilled_value_present — value omitted from plan");
    }

    let classification: FieldClassification;
    let proposed_action: ProposedAction;
    let confidence: ProposedFillPlanEntry["confidence"] = "HIGH";
    let reason: string;

    if (essayIds.has(field.id) || field.type === "textarea") {
      classification = "ESSAY";
      proposed_action = "SKIP_ESSAY";
      reason = "Essay / free-text fields are never auto-generated";
      summary.essay += 1;
    } else if (isDemographicsField(field)) {
      classification = "DEMOGRAPHIC";
      proposed_action = "SKIP_DEMOGRAPHIC";
      reason = "Demographic self-ID deferred to human / sensitive-profile policy";
      summary.demographic += 1;
    } else if (
      isWorkAuthorizationField(field.canonical_field) ||
      isWorkAuthorizationField(field.label)
    ) {
      classification = "SPONSORSHIP";
      proposed_action = "REVIEW_REQUIRED";
      reason =
        "Sponsorship / work-authorization requires explicit candidate profile value";
      summary.sponsorship += 1;
    } else if (field.type === "file") {
      classification = "FILE_UPLOAD";
      proposed_action = "UPLOAD_CANDIDATE";
      reason = "File upload proposed only — not performed during inspection";
      summary.file_upload += 1;
    } else if (isConsentField(field)) {
      classification = "CONSENT";
      proposed_action = "REVIEW_REQUIRED";
      reason = "Consent checkboxes require human review";
      summary.consent += 1;
    } else if (isUnsupportedWidget(field)) {
      classification = "UNSUPPORTED";
      proposed_action = "UNSUPPORTED";
      reason = "Widget type not supported for automated fill";
      confidence = "MEDIUM";
      summary.unsupported += 1;
    } else if (
      field.canonical_field &&
      DETERMINISTIC_CANONICALS.has(field.canonical_field)
    ) {
      classification = "DETERMINISTIC";
      proposed_action = "FILL_CANDIDATE";
      reason = "Mapped from Greenhouse label and input name";
      confidence =
        field.mapping_confidence === "high"
          ? "HIGH"
          : field.mapping_confidence === "medium"
            ? "MEDIUM"
            : "LOW";
      summary.deterministic += 1;
    } else if (field.canonical_field) {
      classification = "UNKNOWN";
      proposed_action = "REVIEW_REQUIRED";
      reason = "Mapped but not in deterministic allowlist — human review";
      confidence = "LOW";
      summary.unknown += 1;
    } else {
      classification = "UNKNOWN";
      proposed_action = "REVIEW_REQUIRED";
      reason = "Unmapped field — do not guess";
      confidence = "LOW";
      summary.unknown += 1;
    }

    entries.push({
      field_id: field.id,
      label: field.label,
      type: field.type,
      classification,
      canonical_field: field.canonical_field,
      proposed_action,
      confidence,
      reason,
      warnings,
      prefilled_value_present,
    });
  }

  return { entries, summary };
}
