import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { makeLlmClient, type EmailLlmClient } from "../contacts/emailLlm.js";
import { llmTraceEvent, postSandboxTrace } from "../sandbox/trace.js";
import { tryLoadAboutMe, validateDraft } from "./essayDraft.js";

/**
 * Essay autofill (operator directive 2026-08-13: "Essays should be
 * autofilled since the LLM can generate it based on my context. EVERYTHING
 * should be filled on the application… that's a trade off I am willing to
 * make").
 *
 * This CHANGES a documented invariant, so it is written to be inspectable
 * rather than quiet:
 *
 *   - Fail-closed: ESSAY_AUTOFILL_ENABLED or SCREENER_PREDICT_LLM_ENABLED
 *     (operator directive 2026-08-15: essays fill on the same LLM path
 *     already trusted for screeners). Also requires about-me.md. No
 *     context ⇒ nothing is invented; the essay parks with the real reason.
 *   - Generated text passes the SAME validator the review-drafting path
 *     uses (validateDraft: length bounds, no placeholder brackets, no
 *     model self-reference). A rejected draft parks; it never fills.
 *   - Every generated answer is recorded on the fill-plan entry with
 *     action "fill_essay_generated" and lands in the run artifact, so what
 *     was written to an employer is always readable afterwards.
 *
 * The honest risk, stated once: essay prose is what a human reads. A model
 * writing from about-me.md can still phrase a claim more strongly than the
 * source supports, and unlike a dropdown that is not verifiable by
 * read-back. The mitigation is the artifact — check the first few.
 */

const SYSTEM_PROMPT = `You write a job applicant's answer to an application essay question, in their voice, using ONLY the context they provide.

Rules:
- Use ONLY facts present in candidate_context. Never invent an employer, a school, a metric, a date, or a project.
- If the context does not support an answer, return null. A missing answer is far better than an invented one.
- Write first person, plain and specific. No preamble, no sign-off, no headings.
- 90-200 words unless the question asks for less.
- Do not mention being an AI, and do not use bracketed placeholders.

Respond with JSON only: {"answer":"<text>"} or {"answer":null}`;

export type EssayAutofillItem = {
  fieldId: string;
  question: string;
};

export type EssayAutofillResult = {
  fieldId: string;
  question: string;
  answer: string;
};

/** Bounded: a form with 20 essays is a form a human should look at. */
const MAX_ESSAYS = 6;

export function essayAutofillAvailable(): { ok: boolean; reason: string } {
  const cfg = getConfig();
  if (!cfg.essayAutofillEnabled && !cfg.screenerPredictLlmEnabled) {
    return {
      ok: false,
      reason:
        "ESSAY_AUTOFILL_ENABLED and SCREENER_PREDICT_LLM_ENABLED are both off",
    };
  }
  if (!tryLoadAboutMe()) {
    return {
      ok: false,
      reason:
        "private/candidate/about-me.md missing or too short — nothing to write from",
    };
  }
  if (!cfg.anthropicApiKey && !cfg.openaiApiKey) {
    return { ok: false, reason: "no LLM provider key configured" };
  }
  return { ok: true, reason: "ok" };
}

export async function generateEssayAnswers(input: {
  items: EssayAutofillItem[];
  job?: { company: string; role: string } | null;
  client?: EmailLlmClient;
  traceUrl?: string;
}): Promise<{ answers: EssayAutofillResult[]; notes: string[] }> {
  const notes: string[] = [];
  const items = input.items.slice(0, MAX_ESSAYS);
  if (items.length === 0) return { answers: [], notes };

  const available = essayAutofillAvailable();
  if (!available.ok && !input.client) {
    notes.push(`essay autofill skipped: ${available.reason}`);
    return { answers: [], notes };
  }
  const about = tryLoadAboutMe();
  if (!about) {
    notes.push("essay autofill skipped: no about-me context");
    return { answers: [], notes };
  }

  const client = input.client ?? makeLlmClient();
  const answers: EssayAutofillResult[] = [];
  for (const item of items) {
    try {
      const userPayload = {
        question: item.question,
        company: input.job?.company ?? null,
        role: input.job?.role ?? null,
        candidate_context: about,
      };
      const { text } = await client.generateJson({
        system: SYSTEM_PROMPT,
        user: JSON.stringify(userPayload),
      });
      if (input.traceUrl) {
        await postSandboxTrace(
          input.traceUrl,
          llmTraceEvent({
            surface: "essay",
            system: SYSTEM_PROMPT,
            user: userPayload,
            response: text,
          }),
        );
      }
      const parsed = JSON.parse(text) as { answer?: unknown };
      if (parsed.answer === null || parsed.answer === undefined) {
        notes.push(
          `essay not answered (model abstained): ${item.question.slice(0, 80)}`,
        );
        continue;
      }
      // Same validator as the human-review drafting path — a generated
      // answer good enough to fill must be good enough to show a human.
      const check = validateDraft(parsed.answer);
      if (!check.ok) {
        notes.push(
          `essay draft rejected (${check.reason}): ${item.question.slice(0, 80)}`,
        );
        continue;
      }
      answers.push({
        fieldId: item.fieldId,
        question: item.question,
        answer: (parsed.answer as string).trim(),
      });
    } catch (err) {
      notes.push(
        `essay generation failed (parks as before): ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`,
      );
    }
  }
  logger.info("essay autofill", {
    service: "essays",
    action: "autofill",
    metadata: { asked: items.length, answered: answers.length },
  });
  return { answers, notes };
}
