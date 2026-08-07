import type { MappedField } from "../../applications/fieldNormalization.js";
import type {
  ApprovedFillPlan,
  ApprovedFillPlanEntry,
} from "../../applications/approvedFillPlan.js";
import type { PublicProfile } from "../../candidate/publicProfile.js";

/**
 * Lever and Ashby render a single "Full name" field, but the safe factual
 * canonicals are legal_name.first / legal_name.last. These helpers compose
 * the two individually-approved values into one field WITHOUT widening
 * SAFE_FACTUAL_CANONICALS or touching assertExecutableApprovedEntry: the
 * entry rides canonical legal_name.first, and the reason string carries the
 * truth about the composed value. Fails closed — an incomplete name demotes
 * the entry to REVIEW_REQUIRED instead of composing a partial.
 *
 * Middle name is deliberately excluded from composition; the operator can
 * supply it at review if a form demands the full legal name.
 */

export type FullNameFieldMatcher = (field: {
  name?: string | undefined;
  label: string;
}) => boolean;

export function makeFullNameMatcher(opts: {
  /** Exact input `name` attributes that identify the full-name field. */
  fieldNames: string[];
  /** Label fallback, e.g. /^full[\s_-]?name\b/i. */
  labelPattern: RegExp;
}): FullNameFieldMatcher {
  const names = new Set(opts.fieldNames);
  return (field) =>
    (field.name !== undefined && names.has(field.name)) ||
    opts.labelPattern.test(field.label.trim());
}

/**
 * Tag an unmapped single full-name text field with canonical
 * legal_name.first so it enters the normal plan/approval pipeline.
 * Runs after mapDiscoveredFields, before buildFillPlan. Fields that
 * already carry a canonical mapping are never overridden.
 */
export function annotateFullNameField(
  mapped: MappedField[],
  matches: FullNameFieldMatcher,
): MappedField[] {
  return mapped.map((f) => {
    if (f.canonical_field !== null) return f;
    if (f.type !== "text") return f;
    if (!matches({ name: f.name, label: f.label })) return f;
    return {
      ...f,
      canonical_field: "legal_name.first",
      mapping_confidence: "medium",
    };
  });
}

const COMPOSED_REASON =
  "Single full-name field: composed legal_name.first + legal_name.last (both safe factual canonicals)";

const DEMOTED_REASON =
  "Full-name composition failed closed: legal_name.first/legal_name.last incomplete in profile — human review";

/**
 * Rewrite the annotated full-name entry's value to "First Last".
 * Returns a new plan; the input is not mutated. If either name component
 * is empty the entry is demoted to REVIEW_REQUIRED (approved: false)
 * rather than filling a partial name.
 *
 * Plan entries only carry field_id, which is the input's id attribute when
 * one exists — NOT necessarily its name attribute, which is what the
 * matcher's fieldNames refer to. Callers that know the id→name mapping
 * (adapters hold it in their FieldMeta) MUST pass resolveFieldName so an
 * annotated field whose id differs from its name (and whose label isn't
 * literally "Full name") is still composed instead of silently filling
 * only the first name.
 */
export function composeFullName(
  plan: ApprovedFillPlan,
  profile: PublicProfile,
  matches: FullNameFieldMatcher,
  resolveFieldName?: (fieldId: string) => string | undefined,
): ApprovedFillPlan {
  const first = (profile.legal_name.first ?? "").trim();
  const last = (profile.legal_name.last ?? "").trim();
  const composed = `${first} ${last}`.trim();
  const answers = { ...plan.answers };
  let changed = false;

  const entries: ApprovedFillPlanEntry[] = plan.entries.map((entry) => {
    const isTarget =
      entry.canonical_field === "legal_name.first" &&
      entry.action === "FILL" &&
      entry.approved &&
      matches({
        name: resolveFieldName?.(entry.field_id) ?? entry.field_id,
        label: entry.label,
      });
    if (!isTarget) return entry;

    changed = true;
    if (first === "" || last === "") {
      delete answers["legal_name.first"];
      return {
        ...entry,
        action: "REVIEW_REQUIRED" as const,
        approved: false,
        value: null,
        reason: DEMOTED_REASON,
      };
    }
    answers["legal_name.first"] = composed;
    return { ...entry, value: composed, reason: COMPOSED_REASON };
  });

  if (!changed) return plan;
  return {
    entries,
    answers,
    fillable_count: entries.filter((e) => e.approved).length,
    skipped_count: entries.filter((e) => e.action === "SKIP").length,
    review_required_count: entries.filter((e) => e.action === "REVIEW_REQUIRED")
      .length,
  };
}
