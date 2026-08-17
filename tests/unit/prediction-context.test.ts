import { describe, expect, it } from "vitest";
import {
  BANK_PRUNE_MIN_ENTRIES,
  pruneSavedAnswersForQuestions,
  relevanceTokens,
} from "../../src/applications/predictionContext.js";

/**
 * Deterministic bank pruning (operator directive 2026-08-17: partition the
 * predictor payload without a second LLM). The bank is the one payload
 * piece that compounds forever — every accepted prediction is persisted —
 * so relevance selection is plain lexical scoring, fail-open.
 */
describe("predictor context pruning (UNIT_CONFIRMED)", () => {
  const bigBank = (): Record<string, string> => {
    const bank: Record<string, string> = {
      work_authorization: "Yes",
      sponsorship: "No",
      graduation_year: "2027",
      relocation: "Yes",
      salary_expectation: "80000",
    };
    for (let i = 0; i < 30; i++) {
      bank[`unrelated_topic_${i}`] = `answer ${i}`;
    }
    return bank;
  };

  it("a small bank ships whole — pruning only kicks in when it pays", () => {
    const small = { work_authorization: "Yes", sponsorship: "No" };
    const r = pruneSavedAnswersForQuestions(small, ["Anything at all?"]);
    expect(r.kept).toEqual(small);
    expect(r.dropped).toBe(0);
  });

  it("a large bank keeps only entries relevant to the batch's questions", () => {
    const r = pruneSavedAnswersForQuestions(bigBank(), [
      "Will you require visa sponsorship?",
      "Are you authorized to work in the United States?",
    ]);
    expect(Object.keys(r.kept)).toContain("sponsorship");
    expect(Object.keys(r.kept)).toContain("work_authorization");
    // The 30 filler entries share no vocabulary with the questions.
    expect(Object.keys(r.kept).some((k) => k.startsWith("unrelated_topic_"))).toBe(
      false,
    );
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.total).toBe(35);
  });

  it("registry descriptions widen an entry's vocabulary beyond its key", () => {
    // "When do you graduate?" shares no token with the key
    // "graduation_year" after stemming alone would still hit via the
    // registry description — prove the def lookup participates.
    const r = pruneSavedAnswersForQuestions(bigBank(), [
      "What year will you finish your degree?",
    ]);
    expect(Object.keys(r.kept)).toContain("graduation_year");
  });

  it("light stemming meets inflected labels", () => {
    const tokens = relevanceTokens("Will you require sponsoring now or later?");
    expect(tokens.has("spons")).toBe(true);
    const entry = relevanceTokens("sponsorship");
    expect(entry.has("spons")).toBe(true);
  });

  it("stopwords and short tokens never create relevance", () => {
    const t = relevanceTokens("Do you have any of the...");
    expect(t.size).toBe(0);
  });

  it("threshold constant is what the docs claim", () => {
    expect(BANK_PRUNE_MIN_ENTRIES).toBe(20);
  });
});
