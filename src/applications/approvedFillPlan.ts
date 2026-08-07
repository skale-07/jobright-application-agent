import type { DiscoveredField, ResolvedApplicationAnswers } from "../ats/adapter.js";
import { isDemographicsField } from "./essayDetector.js";
import type { FillPlanEntry } from "./resolveAnswers.js";
import { isWorkAuthorizationField } from "./resolveAnswers.js";

/** Canonical keys safe to auto-fill from the public profile (factual only). */
export const SAFE_FACTUAL_CANONICALS = new Set([
  "legal_name.first",
  "legal_name.middle",
  "legal_name.last",
  "preferred_name",
  "email",
  "phone",
  "school",
  "degree",
  "major",
  "graduation_year",
  "graduation_month",
  "start_year",
  "start_month",
  "gpa",
  "linkedin_url",
  "github_url",
  "personal_website",
  "relocation",
  "work_authorization",
  "requires_sponsorship",
  "address.line1",
  "address.line2",
  "address.city",
  "address.state",
  "address.postal_code",
  "address.country",
  "how_heard",
  "restrictive_covenants",
]);

/** Operator-supplied EEO / self-ID values (sensitive profile), never invented. */
export const SENSITIVE_FILL_CANONICALS = new Set([
  "gender_identity",
  "gender",
  "race_ethnicity",
  "sexual_orientation",
  "hispanic_latino",
  "transgender",
  "veteran_status",
  "disability_status",
]);

export function isAllowlistedCanonical(canonical: string | null | undefined): boolean {
  if (!canonical) return false;
  return (
    SAFE_FACTUAL_CANONICALS.has(canonical) ||
    SENSITIVE_FILL_CANONICALS.has(canonical)
  );
}

export type ApprovedFillAction = "FILL" | "SKIP" | "REVIEW_REQUIRED";

export type ApprovedFillPlanEntry = {
  field_id: string;
  label: string;
  type: DiscoveredField["type"];
  canonical_field: string | null;
  action: ApprovedFillAction;
  /** True only when action is FILL and the entry passed policy checks. */
  approved: boolean;
  value: unknown;
  reason: string;
};

export type ApprovedFillPlan = {
  entries: ApprovedFillPlanEntry[];
  answers: ResolvedApplicationAnswers;
  fillable_count: number;
  skipped_count: number;
  review_required_count: number;
};

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

/**
 * Promote resolveAnswers plan entries into an approved fill plan.
 * Only safe factual public-profile values get action FILL + approved:true.
 * Essays, demographics, empty sponsorship/work-auth, and unmapped fields are not approved.
 */
export function toApprovedFillPlan(entries: FillPlanEntry[]): ApprovedFillPlan {
  const approvedEntries: ApprovedFillPlanEntry[] = [];
  const answers: ResolvedApplicationAnswers = {};

  for (const entry of entries) {
    if (entry.action === "review_required") {
      approvedEntries.push({
        field_id: entry.field_id,
        label: entry.label,
        type: entry.type,
        canonical_field: entry.canonical_field,
        action: "REVIEW_REQUIRED",
        approved: false,
        value: null,
        reason: entry.reason,
      });
      continue;
    }

    if (entry.action !== "fill") {
      approvedEntries.push({
        field_id: entry.field_id,
        label: entry.label,
        type: entry.type,
        canonical_field: entry.canonical_field,
        action: "SKIP",
        approved: false,
        value: null,
        reason: entry.reason,
      });
      continue;
    }

    const rejected = rejectFillCandidate(entry);
    if (rejected) {
      approvedEntries.push(rejected);
      continue;
    }

    const canonical = entry.canonical_field as string;
    answers[canonical] = entry.value;
    approvedEntries.push({
      field_id: entry.field_id,
      label: entry.label,
      type: entry.type,
      canonical_field: canonical,
      action: "FILL",
      approved: true,
      value: entry.value,
      reason: entry.reason,
    });
  }

  return {
    entries: approvedEntries,
    answers,
    fillable_count: approvedEntries.filter((e) => e.approved).length,
    skipped_count: approvedEntries.filter((e) => e.action === "SKIP").length,
    review_required_count: approvedEntries.filter(
      (e) => e.action === "REVIEW_REQUIRED",
    ).length,
  };
}

function rejectFillCandidate(entry: FillPlanEntry): ApprovedFillPlanEntry | null {
  if (entry.type === "textarea") {
    return {
      field_id: entry.field_id,
      label: entry.label,
      type: entry.type,
      canonical_field: entry.canonical_field,
      action: "SKIP",
      approved: false,
      value: null,
      reason: "Essay/textarea never approved for auto-fill",
    };
  }

  if (
    isDemographicsField({
      id: entry.field_id,
      label: entry.label,
      type: entry.type,
      required: false,
    })
  ) {
    const demoCanon = entry.canonical_field;
    if (
      demoCanon &&
      SENSITIVE_FILL_CANONICALS.has(demoCanon) &&
      !isEmptyValue(entry.value)
    ) {
      // Value already resolved from sensitive profile — allow.
      return null;
    }
    return {
      field_id: entry.field_id,
      label: entry.label,
      type: entry.type,
      canonical_field: entry.canonical_field,
      action: "SKIP",
      approved: false,
      value: null,
      reason: "Demographics not approved without sensitive-profile mapping",
    };
  }

  const canonical = entry.canonical_field;
  if (!canonical || !isAllowlistedCanonical(canonical)) {
    return {
      field_id: entry.field_id,
      label: entry.label,
      type: entry.type,
      canonical_field: entry.canonical_field,
      action: "SKIP",
      approved: false,
      value: null,
      reason: "Canonical field not in safe factual allowlist",
    };
  }

  if (isEmptyValue(entry.value)) {
    const workAuth =
      isWorkAuthorizationField(canonical) ||
      isWorkAuthorizationField(entry.label);
    return {
      field_id: entry.field_id,
      label: entry.label,
      type: entry.type,
      canonical_field: entry.canonical_field,
      action: workAuth ? "REVIEW_REQUIRED" : "SKIP",
      approved: false,
      value: null,
      reason: workAuth
        ? "Empty sponsorship/work-authorization — not approved; human review"
        : "Empty value not approved for fill",
    };
  }

  return null;
}

export function approvedFillEntries(
  plan: ApprovedFillPlan,
): Array<ApprovedFillPlanEntry & { approved: true; action: "FILL" }> {
  return plan.entries.filter(
    (e): e is ApprovedFillPlanEntry & { approved: true; action: "FILL" } =>
      e.approved === true && e.action === "FILL",
  );
}

/**
 * Runtime guard for the Greenhouse executor — reject anything that is not an
 * approved FILL entry (essays, demographics, unapproved, review-required).
 */
export function assertExecutableApprovedEntry(
  entry: ApprovedFillPlanEntry,
): void {
  if (!entry.approved || entry.action !== "FILL") {
    throw new Error(
      `Refusing fill for ${entry.field_id}: not approved (action=${entry.action})`,
    );
  }
  if (entry.type === "textarea") {
    throw new Error(`Refusing fill for ${entry.field_id}: textarea/essay`);
  }
  if (
    isDemographicsField({
      id: entry.field_id,
      label: entry.label,
      type: entry.type,
      required: false,
    }) &&
    !(
      entry.canonical_field &&
      SENSITIVE_FILL_CANONICALS.has(entry.canonical_field) &&
      !isEmptyValue(entry.value)
    )
  ) {
    throw new Error(`Refusing fill for ${entry.field_id}: demographics`);
  }
  if (
    !entry.canonical_field ||
    !isAllowlistedCanonical(entry.canonical_field)
  ) {
    throw new Error(
      `Refusing fill for ${entry.field_id}: canonical not in safe factual allowlist`,
    );
  }
  if (isEmptyValue(entry.value)) {
    throw new Error(`Refusing fill for ${entry.field_id}: empty value`);
  }
}
