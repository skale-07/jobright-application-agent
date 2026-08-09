/**
 * Deterministic screener resolution: label → registry key → bank answer →
 * (for choice controls) literal page option. Every step is conservative:
 * no pattern hit ⇒ no match; bank empty ⇒ policy decides skip-or-review;
 * no option match ⇒ review. The LLM assist (screenerLlmMap.ts) can supply
 * the label→key step for labels the patterns miss, but the answer and the
 * option-verification below are ALWAYS this deterministic path.
 */
import {
  SCREENER_REGISTRY,
  screenerDef,
  type ScreenerAnswerBank,
  type ScreenerDef,
} from "./screeners.js";
import type { PublicProfile } from "./publicProfile.js";
import {
  PREDICTION_OPTION_ALIASES,
  predictScreenerAnswer,
} from "./screenerPredict.js";

export function normalizeScreenerLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // "(Optional) If you were referred…" — parentheticals out
    .replace(/[^a-z0-9\s'/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchScreenerKey(label: string): ScreenerDef | null {
  const norm = normalizeScreenerLabel(label);
  if (!norm) return null;
  for (const def of SCREENER_REGISTRY) {
    if (def.patterns.some((p) => p.test(norm))) return def;
  }
  return null;
}

export type ScreenerResolution =
  | {
      status: "fill";
      key: string;
      value: string;
      basis:
        | "exact_option"
        | "ci_option"
        | "synonym_option"
        | "free_text"
        | "profile_derived";
    }
  | { status: "skip"; key: string; reason: string }
  | { status: "review"; key: string; reason: string };

function normOpt(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Resolve the literal option to select for a choice control. Exact →
 * case-insensitive → registry synonyms. Never a fuzzy or first-option
 * fallback: the polarity lesson (a "No" matching "Now" class of bug)
 * says a choice either matches provably or parks.
 */
export function resolveOptionValue(
  def: ScreenerDef,
  bankAnswer: string,
  options: string[],
  extraSynonyms?: string[],
): { value: string; basis: "exact_option" | "ci_option" | "synonym_option" } | null {
  const exact = options.find((o) => o === bankAnswer);
  if (exact !== undefined) return { value: exact, basis: "exact_option" };

  const ci = options.filter((o) => normOpt(o) === normOpt(bankAnswer));
  if (ci.length === 1) return { value: ci[0]!, basis: "ci_option" };

  const synonyms = [
    ...(def.synonyms?.[bankAnswer] ?? []),
    ...(extraSynonyms ?? []),
  ];
  if (synonyms.length > 0) {
    const bag = new Set(synonyms.map(normOpt));
    const hits = options.filter((o) => bag.has(normOpt(o)));
    if (hits.length === 1) return { value: hits[0]!, basis: "synonym_option" };
  }
  // Last conservative tier: the bank answer's synonym list vs option
  // SUBSTRINGS is deliberately NOT attempted — "No" ⊂ "Not applicable".
  return null;
}

export function resolveScreenerAnswer(input: {
  def: ScreenerDef;
  bank: ScreenerAnswerBank;
  fieldType: string;
  options?: string[] | undefined;
  /** Enables the prediction tier when the bank has no answer. */
  profile?: PublicProfile | undefined;
}): ScreenerResolution {
  const { def, bank } = input;
  const key = def.key;

  if (def.policy === "review_required") {
    return {
      status: "review",
      key,
      reason: `${key} is a human decision by policy`,
    };
  }

  const bankAnswer = bank.answers[key]?.trim() ?? "";
  if (bankAnswer === "") {
    if (def.policy === "skip_if_empty") {
      return { status: "skip", key, reason: `${key} empty in bank — optional, skipped` };
    }
    // Prediction leeway: derive from the profile when a predictor exists.
    // The prediction gets NO extra trust — a choice must still literally
    // match a page option below, and verified predictions surface via
    // `screeners:suggest` so working ones graduate into the bank.
    const prediction = input.profile
      ? predictScreenerAnswer(key, input.profile)
      : null;
    if (prediction) {
      const isChoicePred =
        input.fieldType === "select" ||
        input.fieldType === "radio" ||
        (input.options?.length ?? 0) > 0;
      if (isChoicePred && (input.options?.length ?? 0) > 0) {
        const resolved = resolveOptionValue(
          def,
          prediction.value,
          input.options ?? [],
          PREDICTION_OPTION_ALIASES[prediction.value],
        );
        if (resolved) {
          return { status: "fill", key, value: resolved.value, basis: "profile_derived" };
        }
        return {
          status: "review",
          key,
          reason: `${key}: predicted "${prediction.value}" (${prediction.derivation}) matches no page option — review`,
        };
      }
      if (!isChoicePred) {
        return { status: "fill", key, value: prediction.value, basis: "profile_derived" };
      }
    }
    return {
      status: "review",
      key,
      reason: `${key} matched but has no answer in screeners.json — add one`,
    };
  }

  const isChoice =
    input.fieldType === "select" ||
    input.fieldType === "radio" ||
    (input.options?.length ?? 0) > 0;
  if (isChoice) {
    const options = input.options ?? [];
    if (options.length === 0) {
      // A choice control whose options we couldn't discover: filling would
      // be typing into the dark. The combobox fill path can still verify
      // its committed label, so allow free_text ONLY for select-like
      // widgets with a verified commit — which is exactly what the
      // existing combobox filler enforces. Everything else parks.
      return input.fieldType === "select"
        ? { status: "fill", key, value: bankAnswer, basis: "free_text" }
        : {
            status: "review",
            key,
            reason: `${key}: choice control with undiscovered options — review`,
          };
    }
    const resolved = resolveOptionValue(def, bankAnswer, options);
    if (!resolved) {
      return {
        status: "review",
        key,
        reason: `${key}: bank answer "${bankAnswer}" matches none of the ${options.length} page options — review`,
      };
    }
    return { status: "fill", key, value: resolved.value, basis: resolved.basis };
  }

  return { status: "fill", key, value: bankAnswer, basis: "free_text" };
}

/** One-call convenience used by the fill planner. */
export function resolveScreenerForField(
  field: { label: string; type: string; options?: string[] | undefined },
  bank: ScreenerAnswerBank,
  keyOverride?: string,
  profile?: PublicProfile,
): ScreenerResolution | null {
  const def = keyOverride ? screenerDef(keyOverride) : matchScreenerKey(field.label);
  if (!def) return null;
  return resolveScreenerAnswer({
    def,
    bank,
    fieldType: field.type,
    options: field.options,
    profile,
  });
}
