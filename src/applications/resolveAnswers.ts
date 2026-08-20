import type { DiscoveredField, ResolvedApplicationAnswers } from "../ats/adapter.js";
import type { MappedField } from "./fieldNormalization.js";
import { essayFieldsOnly, isConditionalYesFollowUp } from "./essayDetector.js";
import { isDemographicsField } from "./essayDetector.js";
import {
  getProfileValue,
  type PublicProfile,
} from "../candidate/publicProfile.js";
import {
  getSensitiveValue,
  tryLoadSensitiveProfile,
} from "../candidate/sensitiveProfileIO.js";
import { locationTypeaheadQuery, shouldComposeCityTypeahead } from "./locationQuery.js";
import type { ScreenerResolution } from "../candidate/screenerMatch.js";
import { normalizeFieldLabel } from "./fieldNormalization.js";
import {
  consentCanonicalFor,
  isApplicationConsentField,
} from "./consentFields.js";

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

function precedingYesNo(entries: FillPlanEntry[]): "yes" | "no" | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (String(e.action).toLowerCase() !== "fill") continue;
    const v = String(e.value ?? "")
      .trim()
      .toLowerCase();
    if (v === "yes" || v === "y" || v === "true") return "yes";
    if (v === "no" || v === "n" || v === "false") return "no";
  }
  return null;
}

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

function profileFactMatchingCheckbox(
  label: string,
  profile: PublicProfile,
): string | null {
  const n = normalizeFieldLabel(label);
  if (n.length < 4) return null;
  const facts = [
    profile.major,
    profile.degree,
    ...(profile.additional_fields_of_study ?? []),
  ]
    .map((s) => normalizeFieldLabel(String(s ?? "")))
    .filter((s) => s.length >= 4);
  for (const fact of facts) {
    if (n === fact) return fact;
    if (n.length >= 12 && (n.includes(fact) || fact.includes(n))) return fact;
  }
  return null;
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
    /**
     * Essay answers generated from the operator's own about-me context and
     * already validated (essayAutofill.ts), keyed by field id.
     */
    essayAnswers?: Map<string, string>;
    /** Why an essay field has no generated answer — shown on skip_essay. */
    essaySkipReason?: string;
    /** Why an unmapped field has no predict/bank answer — shown on skip_unmapped. */
    unmappedReasons?: Map<string, string>;
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
    if (
      isConditionalYesFollowUp(field.label) &&
      precedingYesNo(entries) === "no"
    ) {
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: field.canonical_field,
        action: "skip_empty",
        value: null,
        reason: "conditional follow-up skipped — parent answer is No",
      });
      continue;
    }

    if (essayIds.has(field.id) || field.type === "textarea") {
      const generated = opts.essayAnswers?.get(field.id);
      if (generated) {
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: `essay:generated:${field.id}`,
          action: "fill",
          value: generated,
          reason: "Essay generated from the operator's about-me context",
        });
        continue;
      }
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: field.canonical_field,
        action: "skip_essay",
        value: null,
        reason: opts.essaySkipReason ?? "Essay generation produced no answer",
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

    if (isApplicationConsentField(field)) {
      const canonical = consentCanonicalFor(field.id);
      answers[canonical] = true;
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: canonical,
        action: "fill",
        value: true,
        reason: "Application terms/confirmation checkbox",
      });
      continue;
    }

    if (field.type === "checkbox") {
      const fact = profileFactMatchingCheckbox(field.label, profile);
      if (fact) {
        const canonical = `screener:custom:profile_fact:${field.id}`;
        answers[canonical] = true;
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: canonical,
          action: "fill",
          value: true,
          reason: `Checkbox matches profile fact (${fact})`,
        });
        continue;
      }
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
            reason:
              screener.basis === "llm_predict" || screener.basis === "other_option"
                ? `Predicted from operator context (${screener.basis})${
                    screener.rationale ? `: ${screener.rationale}` : ""
                  }`
                : `Screener bank answer (${screener.basis})${
                    screener.rationale ? `: ${screener.rationale}` : ""
                  }`,
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
        reason:
          opts.unmappedReasons?.get(field.id) ?? "No answer-alias mapping",
      });
      continue;
    }

    let value = getProfileValue(profile, field.canonical_field);
    if (field.canonical_field === "requires_sponsorship") {
      value = normalizeSponsorship(value);
    }
    if (
      field.canonical_field === "address.city" &&
      typeof value === "string" &&
      shouldComposeCityTypeahead(mapped)
    ) {
      // Lone location typeaheads want "Baltimore, Maryland, USA".
      // Split City/State/Country forms keep the bare city.
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
      // Year-only text boxes stay a year. Seasonal comboboxes (Jump:
      // Winter/Spring/Fall 2029) need the profile month to pick one option.
      if (
        field.canonical_field === "graduation_year" &&
        (field.type === "select" || field.type === "radio")
      ) {
        const month = (profile.graduation_month ?? "").trim();
        const year = String(value);
        if (month && !/\d{4}/.test(month) && /^(20\d{2}|19\d{2})$/.test(year)) {
          value = `${month} ${year}`;
        }
      }
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
