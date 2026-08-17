import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmailLlmClient } from "../../src/contacts/emailLlm.js";
import { predictAnswersForQuestions } from "../../src/applications/screenerPredictionLlm.js";
import { resetConfigCache } from "../../src/config/index.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Cheap-first escalation (SCREENER_PREDICT_FAST_FIRST). The design point:
 * validatePrediction is the FREE difficulty detector — a failed cheap
 * attempt is the hard-question signal, so no judge LLM ever runs. These
 * tests script both tiers and assert exactly which questions each saw.
 */

type Prediction = {
  label: string;
  answer: string | null;
  key: string;
  basis: string;
};

/** Scripted tier: answers per label, records the labels it was asked. */
function tier(
  script: Record<string, string | null>,
  askedBatches: string[][],
): EmailLlmClient {
  return {
    async generateJson({ user }) {
      const payload = JSON.parse(user) as {
        questions: Array<{ label: string }>;
      };
      askedBatches.push(payload.questions.map((q) => q.label));
      const predictions: Prediction[] = payload.questions.map((q) => ({
        label: q.label,
        answer: script[q.label] ?? null,
        key: "k",
        basis: "scripted",
      }));
      return { text: JSON.stringify({ predictions }), model: "stub" };
    },
  };
}

describe("cheap-first predict escalation (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  let privDir: string;
  let priorPrivate: string | undefined;
  beforeEach(() => {
    process.env.SCREENER_PREDICT_LLM_ENABLED = "true";
    priorPrivate = process.env.PRIVATE_DIR;
    privDir = path.join(os.tmpdir(), `fastfirst-priv-${randomUUID()}`);
    fs.mkdirSync(path.join(privDir, "candidate"), { recursive: true });
    fs.writeFileSync(
      path.join(privDir, "candidate", "about-me.md"),
      "A candidate context long enough to load: automation engineering student with browser tooling experience.",
    );
    process.env.PRIVATE_DIR = privDir;
    resetConfigCache();
  });
  afterEach(() => {
    if (priorPrivate === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = priorPrivate;
    fs.rmSync(privDir, { recursive: true, force: true });
    resetConfigCache();
  });

  const QUESTIONS = [
    { id: "q1", label: "Which region can you cover?", options: ["East", "West"] },
    { id: "q2", label: "Describe your favorite debugging story" },
    { id: "q3", label: "Preferred start window?", options: ["June", "July"] },
  ];

  it("questions the fast tier answers validly never reach the strong model", async () => {
    const fastAsked: string[][] = [];
    const strongAsked: string[][] = [];
    const fast = tier(
      {
        "Which region can you cover?": "East",
        "Describe your favorite debugging story": "Traced a heisenbug to a race.",
        "Preferred start window?": "June",
      },
      fastAsked,
    );
    const strong = tier({}, strongAsked);

    const out = await predictAnswersForQuestions(
      QUESTIONS,
      strong,
      undefined,
      fast,
    );
    expect(out.get("q1")?.value).toBe("East");
    expect(out.get("q2")?.value).toBe("Traced a heisenbug to a race.");
    expect(out.get("q3")?.value).toBe("June");
    expect(fastAsked).toHaveLength(1);
    expect(strongAsked).toHaveLength(0);
  });

  it("ONLY the questions that failed validation escalate to the strong model", async () => {
    const fastAsked: string[][] = [];
    const strongAsked: string[][] = [];
    // Fast tier: one good option pick, one null, one off-list garbage on a
    // form WITHOUT an Other hatch — the last two must escalate.
    const fast = tier(
      {
        "Which region can you cover?": "East",
        "Describe your favorite debugging story": null,
        "Preferred start window?": "Anytime works",
      },
      fastAsked,
    );
    const strong = tier(
      {
        "Describe your favorite debugging story": "Bisected a flaky test to a TZ bug.",
        "Preferred start window?": "July",
      },
      strongAsked,
    );

    const out = await predictAnswersForQuestions(
      QUESTIONS,
      strong,
      undefined,
      fast,
    );
    expect(out.get("q1")?.value).toBe("East");
    expect(out.get("q2")?.value).toBe("Bisected a flaky test to a TZ bug.");
    expect(out.get("q3")?.value).toBe("July");
    expect(fastAsked[0]).toHaveLength(3);
    // The strong model saw exactly the two failures — not the whole batch.
    expect(strongAsked).toHaveLength(1);
    expect(strongAsked[0]).toEqual([
      "Describe your favorite debugging story",
      "Preferred start window?",
    ]);
  });

  it("a strong-tier failure still parks the question (nothing invents an answer)", async () => {
    const fast = tier({}, []);
    const strong = tier({}, []);
    const out = await predictAnswersForQuestions(
      [{ id: "q1", label: "Which region can you cover?", options: ["East", "West"] }],
      strong,
      undefined,
      fast,
    );
    expect(out.size).toBe(0);
  });

  it("without a fast client the strong model handles the batch in one call (behavior unchanged)", async () => {
    const strongAsked: string[][] = [];
    const strong = tier(
      { "Which region can you cover?": "West" },
      strongAsked,
    );
    const out = await predictAnswersForQuestions(
      [{ id: "q1", label: "Which region can you cover?", options: ["East", "West"] }],
      strong,
    );
    expect(out.get("q1")?.value).toBe("West");
    expect(strongAsked).toHaveLength(1);
  });
});
