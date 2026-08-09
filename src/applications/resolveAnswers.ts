import type { DiscoveredField, ResolvedApplicationAnswers } from "../ats/adapter.js";
import type { MappedField } from "./fieldNormalization.js";
import { essayFieldsOnly } from "./essayDetector.js";
import { isDemographicsField } from "./essayDetector.js";
import {
  getProfileValue,
  type PublicProfile,
} from "../candidate/publicProfile.js";
import {
  getSensitiveValue,
  tryLoadSensitiveProfile,
} from "../candidate/sensitiveProfileIO.js";
import { locationTypeaheadQuery } from "./locationQuery.js";
import type { ScreenerResolution } from "../candidate/screenerMatch.js";

export type FillPlanAction =
  | "fill"
  | "skip_essay"
  | "skip_demographics"
  | "skip_file"
  | "skip_unmapped"
  | "skip_empty"
  | "review_required";

export type FillPlanEntry = {
  field_id: string;
  label: string;
  type: DiscoveredField["type"];
  canonical_field: string | null;
  action: FillPlanAction;
  value: unknown;
  reason: string;
};

export type ResolvedFillPlan = {
  answers: ResolvedApplicationAnswers;
  entries: FillPlanEntry[];
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
 * Normalize an explicit sponsorship value. Never invents Yes/No for empty input.
 */
function normalizeSponsorship(value: unknown): string | unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" && value.trim() === "") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "yes" || s === "y" || s === "true" || s === "1") return "Yes";
    if (s === "no" || s === "n" || s === "false" || s === "0") return "No";
  }
  return value;
}

/**
 * True when the canonical key or visible label is sponsorship / work-authorization.
 */
export function isWorkAuthorizationField(
  canonicalOrLabel: string | null | undefined,
): boolean {
  if (!canonicalOrLabel) return false;
  const s = canonicalOrLabel.trim().toLowerCase();
  if (s === "requires_sponsorship" || s === "work_authorization") return true;
  return /sponsor|work[\s_-]?auth|visa|authorized to work|legally authorized|require sponsorship/.test(
    s,
  );
}

/**
 * Build a fill plan from mapped fields + public profile.
 * Never auto-fills essays. Skips demographics and file fields (uploads are separate).
 * Never defaults empty requires_sponsorship / work_authorization to Yes/No.
 */
export function buildFillPlan(
  mapped: MappedField[],
  profile: PublicProfile,
  opts: {
    /**
     * Screener resolutions for otherwise-unmapped fields, keyed by field
     * id (built by planApplicationFill from the operator's answer bank —
     * see screenerMatch.ts for the accuracy contract). Only consulted on
     * the skip_unmapped branch: profile mappings, essay/demographic/file
     * routing, and every existing behavior are untouched.
     */
    screenerResolutions?: Map<string, ScreenerResolution>;
  } = {},
): ResolvedFillPlan {
  const essayIds = new Set(
    essayFieldsOnly(mapped)
      .filter((e) => e.is_essay)
      .map((e) => e.field_id),
  );

  const answers: ResolvedApplicationAnswers = {};
  const entries: FillPlanEntry[] = [];

  for (const field of mapped) {
    if (essayIds.has(field.id) || field.type === "textarea") {
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: field.canonical_field,
        action: "skip_essay",
        value: null,
        reason: "Essays are never auto-filled",
      });
      continue;
    }

    if (isDemographicsField(field)) {
      const sensitive = tryLoadSensitiveProfile();
      const demoCanon = field.canonical_field;
      let demValue: unknown = undefined;
      if (sensitive && demoCanon) {
        demValue = getSensitiveValue(sensitive, demoCanon);
      }
      if (!sensitive || !demoCanon || isEmptyValue(demValue)) {
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: field.canonical_field,
          action: "skip_demographics",
          value: null,
          reason: "Demographics deferred to sensitive-profile policy path",
        });
        continue;
      }
      answers[demoCanon] = demValue;
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: demoCanon,
        action: "fill",
        value: demValue,
        reason: "Mapped from sensitive profile (operator-supplied)",
      });
      continue;
    }

    if (field.type === "file") {
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: field.canonical_field,
        action: "skip_file",
        value: null,
        reason: "File uploads handled via uploadResume/uploadCoverLetter",
      });
      continue;
    }

    if (!field.canonical_field) {
      const screener = opts.screenerResolutions?.get(field.id);
      if (screener) {
        const canonical = `screener:${screener.key}`;
        if (screener.status === "fill") {
          // Unique canonical per field: two fields may share a key.
          const unique = canonical in answers ? `${canonical}:${field.id}` : canonical;
          answers[unique] = screener.value;
          entries.push({
            field_id: field.id,
            label: field.label,
            type: field.type,
            canonical_field: unique,
            action: "fill",
            value: screener.value,
            reason: `Screener bank answer (${screener.basis})`,
          });
          continue;
        }
        if (screener.status === "review") {
          entries.push({
            field_id: field.id,
            label: field.label,
            type: field.type,
            canonical_field: canonical,
            action: "review_required",
            value: null,
            reason: screener.reason,
          });
          continue;
        }
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: canonical,
          action: "skip_empty",
          value: null,
          reason: screener.reason,
        });
        continue;
      }
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: null,
        action: "skip_unmapped",
        value: null,
        reason: "No answer-alias mapping",
      });
      continue;
    }

    let value = getProfileValue(profile, field.canonical_field);
    if (field.canonical_field === "requires_sponsorship") {
      value = normalizeSponsorship(value);
    }
    if (field.canonical_field === "address.city" && typeof value === "string") {
      // Location typeaheads want "Baltimore, Maryland, USA" not bare city.
      value = locationTypeaheadQuery(
        value,
        profile.address?.state ?? "",
        profile.address?.country ?? "",
      );
    }
    if (
      (field.canonical_field === "graduation_year" ||
        field.canonical_field === "start_year") &&
      value != null
    ) {
      value = String(value);
    }

    if (isEmptyValue(value)) {
      const workAuth =
        isWorkAuthorizationField(field.canonical_field) ||
        isWorkAuthorizationField(field.label);
      if (workAuth && field.required) {
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: field.canonical_field,
          action: "review_required",
          value: null,
          reason: `Required ${field.canonical_field} missing from profile — human review`,
        });
        continue;
      }
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: field.canonical_field,
        action: "skip_empty",
        value: null,
        reason: `Profile value empty for ${field.canonical_field}`,
      });
      continue;
    }

    answers[field.canonical_field] = value;
    entries.push({
      field_id: field.id,
      label: field.label,
      type: field.type,
      canonical_field: field.canonical_field,
      action: "fill",
      value,
      reason: "Mapped from public profile",
    });
  }

  return {
    answers,
    entries,
    fillable_count: entries.filter((e) => e.action === "fill").length,
    skipped_count: entries.filter(
      (e) => e.action !== "fill" && e.action !== "review_required",
    ).length,
    review_required_count: entries.filter((e) => e.action === "review_required")
      .length,
  };
}

export function fillEntriesForAnswers(plan: ResolvedFillPlan): FillPlanEntry[] {
  return plan.entries.filter((e) => e.action === "fill");
}
