/**
 * Deterministic context selection for the screener predictor payload
 * (operator directive 2026-08-17: "partition the prompt" — the judge is a
 * scoring function, never a second LLM).
 *
 * The bank (`saved_answers`) is the one payload piece that grows without
 * bound: every accepted prediction is persisted into it, so after months
 * of runs the predictor would ship the operator's whole answer history to
 * answer three questions. This module prunes it by lexical relevance to
 * the batch's question labels. about-me.md is deliberately NOT pruned
 * here — it is the stable prompt prefix (cached, see emailLlm.ts), and a
 * lexical scorer could drop the very section that answers an oddly-worded
 * question, the exact class the predictor exists for.
 *
 * Fail-open by design: a small bank passes through untouched, and every
 * question token that matches ANY entry keeps that entry. Pruning can
 * only ever shrink cost, never flip an answer — the model still validates
 * verbatim against the page's own options downstream.
 */
import { SCREENER_REGISTRY } from "../candidate/screeners.js";
import { normalizeScreenerLabel } from "../candidate/screenerMatch.js";

/** Below this many entries the bank ships whole — pruning buys nothing. */
export const BANK_PRUNE_MIN_ENTRIES = 20;

/** Generic words that would match every label and defeat the scoring. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "you", "your",
  "are", "is", "do", "does", "have", "has", "will", "would", "please",
  "select", "if", "any", "with", "what", "which", "how", "this", "that",
  "be", "on", "at", "us", "our", "we", "it", "as", "not", "from", "can",
]);

export function relevanceTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeScreenerLabel(text).split(/[\s/_'-]+/)) {
    const t = raw.trim();
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
    // Light stemming so "sponsoring"/"sponsorship" meet "sponsor".
    if (t.length > 5) out.add(t.slice(0, 5));
  }
  return out;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

export type PrunedBankAnswers = {
  kept: Record<string, string>;
  dropped: number;
  total: number;
};

/**
 * Keep only bank answers lexically relevant to this batch's questions.
 * An entry's vocabulary is its key ("graduation_year") plus its registry
 * description when one exists ("What year do you graduate?") — the key
 * alone is often too terse to meet a verbose label.
 */
export function pruneSavedAnswersForQuestions(
  answers: Record<string, string>,
  questionLabels: string[],
): PrunedBankAnswers {
  const entries = Object.entries(answers);
  if (entries.length <= BANK_PRUNE_MIN_ENTRIES) {
    return { kept: answers, dropped: 0, total: entries.length };
  }
  const questionVocab = new Set<string>();
  for (const label of questionLabels) {
    for (const t of relevanceTokens(label)) questionVocab.add(t);
  }
  const kept: Record<string, string> = {};
  let dropped = 0;
  for (const [key, answer] of entries) {
    const def = SCREENER_REGISTRY.find((d) => d.key === key);
    const vocab = relevanceTokens(
      def ? `${key} ${def.description}` : key,
    );
    if (overlaps(vocab, questionVocab)) {
      kept[key] = answer;
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped, total: entries.length };
}
