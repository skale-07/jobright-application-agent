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
        | "profile_derived"
        /**
         * A held answer placed onto the page's option list by the model,
         * validated verbatim against that list (screenerOptionSelect.ts).
         * The model chooses; it never authors the value.
         */
        | "llm_option"
        /**
         * Plan-time predict (`SCREENER_PREDICT_LLM_ENABLED`): option
         * answers matched the page verbatim, or free-text appeared in
         * about-me / profile facts. Never promoted into screeners.json.
         */
        | "llm_predict"
        /**
         * The form's OWN "not listed" escape hatch, taken because the
         * candidate's real answer is genuinely absent from a scraped closed
         * option list. The value is that option verbatim; the real answer
         * follows into whatever text box the form reveals next.
         */
        | "other_option";
      /** Model or matcher one-liner — shown in the sandbox / plan reason. */
      rationale?: string;
    }
  | { status: "skip"; key: string; reason: string }
  | { status: "review"; key: string; reason: string };

function normOpt(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Closed Yes/No lists, ignoring "Select..." placeholders. */
export function isYesNoOptionList(options: string[] | undefined): boolean {
  if (!options || options.length === 0) return false;
  const meaningful = options.filter(
    (o) => o.trim() !== "" && !/^select/i.test(o.trim()),
  );
  if (meaningful.length === 0 || meaningful.length > 4) return false;
  const norms = meaningful.map(normOpt);
  const hasYes = norms.some((n) => n === "yes" || n.startsWith("yes "));
  const hasNo = norms.some((n) => n === "no" || n.startsWith("no "));
  return hasYes && hasNo;
}

export function pickYesOption(options: string[]): string | null {
  const yeses = options.filter((o) => {
    const n = normOpt(o);
    return n === "yes" || n.startsWith("yes ");
  });
  return yeses.length === 1 ? yeses[0]! : null;
}

/**
 * LLM label→key (and its cache) must not bind a preference key onto a
 * Yes/No ability question. Live 2026-08-16: "able to work on-site?" was
 * mapped to remote_or_onsite, then option-select turned "Remote" into "No".
 */
export function screenerKeyFitsField(
  key: string,
  field: { label: string; options?: string[] | undefined },
): boolean {
  if (key === "remote_or_onsite") {
    if (isYesNoOptionList(field.options)) return false;
    const n = normalizeScreenerLabel(field.label);
    if (/able to (work |commute )?on-?site|willing to relocate|able to relocate/.test(n)) {
      return false;
    }
  }
  return true;
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

  // Operator directive 2026-08-16: on-site / relocate *ability* is Yes.
  // Do not let a remote-preference bank row, an empty bank, or option-select
  // turn "Are you able to work on-site?" into No.
  if (def.key === "willing_to_relocate") {
    const yes = pickYesOption(input.options ?? []);
    if (yes) {
      return { status: "fill", key, value: yes, basis: "synonym_option" };
    }
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

const LABEL_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "if",
  "not",
  "any",
  "this",
  "that",
  "with",
  "from",
  "by",
  "as",
  "at",
  "it",
  "we",
  "me",
  "my",
  "our",
  "your",
  "you",
  "please",
  "select",
  "choose",
  "indicate",
  "following",
  "listed",
  "other",
  "none",
  "above",
]);

function foldLabelToken(w: string): string {
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && w.length > 3 && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function contentTokens(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalized.split(" ")) {
    if (w.length < 3 || LABEL_STOPWORDS.has(w)) continue;
    out.add(foldLabelToken(w));
  }
  return out;
}

/**
 * Same-question score over the existing custom-bank labels. Not a new
 * index and not the alias substring matcher: a 1–2 word phrase cannot
 * hitch a ride inside a longer question (that is how "organization"
 * became current_company). Exact, a ≥4-word phrase contained in the
 * other label, or ≥2 shared content tokens with high overlap.
 */
export function scoreScreenerLabelOverlap(a: string, b: string): number {
  const na = normalizeScreenerLabel(a);
  const nb = normalizeScreenerLabel(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const wa = na.split(" ");
  const wb = nb.split(" ");
  const shorter = wa.length <= wb.length ? na : nb;
  const longer = wa.length <= wb.length ? nb : na;
  if (Math.min(wa.length, wb.length) >= 4 && longer.includes(shorter)) {
    return 0.9;
  }
  const ta = contentTokens(na);
  const tb = contentTokens(nb);
  if (ta.size < 2 || tb.size < 2) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  if (shared < 2) return 0;
  const jaccard = shared / (ta.size + tb.size - shared);
  const contained = shared / Math.min(ta.size, tb.size);
  return Math.max(jaccard, contained);
}

export type CustomScreenerMatch = {
  key: string;
  score: number;
  exact: boolean;
};

/** Reuse the stored answer; skip the model. */
export const CUSTOM_REUSE_MIN_SCORE = 0.75;
/** Include the pair in the predict payload; still ask the model. */
export const CUSTOM_CONTEXT_MIN_SCORE = 0.5;

export function findCustomScreenerMatch(
  label: string,
  bank: ScreenerAnswerBank,
  minScore: number = CUSTOM_REUSE_MIN_SCORE,
): CustomScreenerMatch | null {
  const norm = normalizeScreenerLabel(label);
  if (!norm) return null;
  let best: CustomScreenerMatch | null = null;
  let runnerUp = 0;
  for (const [key, e] of Object.entries(bank.custom)) {
    let entryBest = 0;
    let exact = false;
    for (const stored of e.labels) {
      const n = normalizeScreenerLabel(stored);
      if (n === norm) {
        exact = true;
        entryBest = 1;
        break;
      }
      entryBest = Math.max(entryBest, scoreScreenerLabelOverlap(label, stored));
    }
    if (entryBest < minScore) continue;
    if (!best || entryBest > best.score) {
      runnerUp = best?.score ?? 0;
      best = { key, score: entryBest, exact };
    } else if (entryBest > runnerUp) {
      runnerUp = entryBest;
    }
  }
  if (!best) return null;
  if (!best.exact && runnerUp > 0 && best.score - runnerUp < 0.08) return null;
  return best;
}

/**
 * Custom-entry resolution: exact normalized label first, then a
 * high-overlap paraphrase of a stored question. Choice controls still
 * require a literal option match. No match ⇒ null (caller may predict).
 */
export function resolveCustomScreener(
  field: { label: string; type: string; options?: string[] | undefined },
  bank: ScreenerAnswerBank,
): ScreenerResolution | null {
  const hit = findCustomScreenerMatch(field.label, bank);
  if (!hit) return null;
  const entry = bank.custom[hit.key];
  if (!entry) return null;
  const key = hit.key;
  const scopedKey = `custom:${key}`;
  const answer = entry.answer.trim();
  if (answer === "") {
    return { status: "review", key: scopedKey, reason: `${scopedKey}: empty answer in bank` };
  }
  const isChoice =
    field.type === "select" ||
    field.type === "radio" ||
    (field.options?.length ?? 0) > 0;
  if (isChoice) {
    const options = field.options ?? [];
    if (options.length === 0) {
      return field.type === "select"
        ? { status: "fill", key: scopedKey, value: answer, basis: "free_text" }
        : {
            status: "review",
            key: scopedKey,
            reason: `${scopedKey}: choice control with undiscovered options — review`,
          };
    }
    const exact = options.find((o) => o === answer);
    if (exact !== undefined) {
      return { status: "fill", key: scopedKey, value: exact, basis: "exact_option" };
    }
    const ci = options.filter((o) => normOpt(o) === normOpt(answer));
    if (ci.length === 1) {
      return { status: "fill", key: scopedKey, value: ci[0]!, basis: "ci_option" };
    }
    return {
      status: "review",
      key: scopedKey,
      reason: `${scopedKey}: promoted answer "${answer}" matches none of the ${options.length} page options — review`,
    };
  }
  return { status: "fill", key: scopedKey, value: answer, basis: "free_text" };
}

/**
 * Custom pairs worth showing the model for these questions. The whole
 * bank is not the payload — only labels that overlap the ask.
 */
export function learnedCustomAnswersFor(
  bank: ScreenerAnswerBank,
  labels: string[],
  maxPairs = 8,
): Array<{ labels: string[]; answer: string }> {
  const scored: Array<{ score: number; labels: string[]; answer: string }> = [];
  for (const e of Object.values(bank.custom)) {
    let best = 0;
    for (const q of labels) {
      for (const stored of e.labels) {
        if (normalizeScreenerLabel(q) === normalizeScreenerLabel(stored)) {
          best = 1;
          break;
        }
        best = Math.max(best, scoreScreenerLabelOverlap(q, stored));
      }
      if (best === 1) break;
    }
    if (best >= CUSTOM_CONTEXT_MIN_SCORE) {
      scored.push({ score: best, labels: e.labels, answer: e.answer });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxPairs).map(({ labels: ls, answer }) => ({
    labels: ls,
    answer,
  }));
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
