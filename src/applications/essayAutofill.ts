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
- Facts about the CANDIDATE come ONLY from candidate_context. Never invent an employer, a school, a metric, a date, or a project.
- posting_context (when present) is text taken from the employer's own posting and application pages — the company name, the role, what the team does. Use it to know who the employer is and to connect the candidate's real background to the role ("why us" reasoning). Never invent employer facts beyond it.
- If neither context supports an answer, return null. A missing answer is far better than an invented one.
- Write first person, plain and specific. No preamble, no sign-off, no headings.
- 90-200 words unless the question asks for less.
- Do not mention being an AI, and do not use bracketed placeholders.

Respond with JSON only: {"answer":"<text>"} or {"answer":null}`;

export type EssayAutofillItem = {
  fieldId: string;
  question: string;
};

/** Bounded: posting context is a grounding aid, not a document dump. */
export const MAX_POSTING_CONTEXT_CHARS = 900;

/**
 * Deterministically harvest "who is this employer / what is this role" text
 * from a page the flow has already seen: title, headings, meta description,
 * and short paragraphs. No LLM, no network — string extraction only. Form
 * chrome (labels, options, buttons) is excluded so the result reads like a
 * posting, not like the questionnaire we are about to answer.
 *
 * Live artifact 1787010568814/1787010626392: "Why Frobnicator?" was asked
 * with company=null, role=null and no posting text — the model (correctly,
 * per its grounding rules) abstained, and the essay went to the employer
 * BLANK even though the pages the flow walked named the company, the role,
 * and the location. This function is that missing channel.
 */
export function extractPostingContext(html: string): string {
  const stripTags = (s: string): string =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&nbsp;/gi, " ")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  // Drop scripts/styles first, then form internals — a <p> INSIDE the form
  // is fill-machinery commentary, not posting copy.
  const page = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined): void => {
    const text = stripTags(raw ?? "");
    if (text.length < 3) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(text);
  };
  push(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page)?.[1]);
  push(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(
      page,
    )?.[1],
  );
  for (const m of page.matchAll(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi)) {
    push(m[1]);
  }
  for (const m of page.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    push(m[1]);
  }
  return parts.join("\n").slice(0, MAX_POSTING_CONTEXT_CHARS);
}

/** Merge page extracts gathered along the flow (posting → outer → form). */
export function mergePostingContext(
  ...extracts: Array<string | null | undefined>
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of extracts) {
    for (const line of (e ?? "").split("\n")) {
      const t = line.trim();
      if (t.length < 3) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(t);
    }
  }
  return lines.join("\n").slice(0, MAX_POSTING_CONTEXT_CHARS);
}

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
  /** Page-derived employer/role text (extractPostingContext / merge). */
  postingContext?: string;
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
        posting_context: input.postingContext?.trim() || null,
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
