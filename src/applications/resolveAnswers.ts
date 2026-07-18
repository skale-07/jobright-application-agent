import type { DiscoveredField, ResolvedApplicationAnswers } from "../ats/adapter.js";
import type { MappedField } from "./fieldNormalization.js";
import { essayFieldsOnly } from "./essayDetector.js";
import { isDemographicsField } from "./essayDetector.js";
import {
  getProfileValue,
  type PublicProfile,
} from "../candidate/publicProfile.js";

export type FillPlanEntry = {
  field_id: string;
  label: string;
  type: DiscoveredField["type"];
  canonical_field: string | null;
  action: "fill" | "skip_essay" | "skip_demographics" | "skip_file" | "skip_unmapped" | "skip_empty";
  value: unknown;
  reason: string;
};

export type ResolvedFillPlan = {
  answers: ResolvedApplicationAnswers;
  entries: FillPlanEntry[];
  fillable_count: number;
  skipped_count: number;
};

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

function normalizeSponsorship(value: unknown): string | unknown {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "yes" || s === "y" || s === "true" || s === "1") return "Yes";
    if (s === "no" || s === "n" || s === "false" || s === "0") return "No";
  }
  return value;
}

/**
 * Build a fill plan from mapped fields + public profile.
 * Never auto-fills essays. Skips demographics and file fields (uploads are separate).
 */
export function buildFillPlan(
  mapped: MappedField[],
  profile: PublicProfile,
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
    if (field.canonical_field === "graduation_year" && value != null) {
      value = String(value);
    }

    if (isEmptyValue(value)) {
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
    skipped_count: entries.filter((e) => e.action !== "fill").length,
  };
}

export function fillEntriesForAnswers(
  plan: ResolvedFillPlan,
): FillPlanEntry[] {
  return plan.entries.filter((e) => e.action === "fill");
}
