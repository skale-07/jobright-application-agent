import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  hasLlmKey,
  makeLlmClient,
  type EmailLlmClient,
} from "../contacts/emailLlm.js";
import {
  isYesNoOptionList,
  type ScreenerResolution,
} from "../candidate/screenerMatch.js";
import { validatePrediction } from "./screenerPredictionLlm.js";
import { llmTraceEvent, postSandboxTrace } from "../sandbox/trace.js";

/**
 * Map an answer we ALREADY HOLD onto the page's option list.
 *
 * The deterministic matcher (`resolveOptionValue`) is exact → case-
 * insensitive → curated synonyms, then parks. That is correct as a literal
 * matcher — substring matching is genuinely unsafe, "No" ⊂ "Not
 * applicable" — but it means a known answer stops the application whenever
 * the employer's wording differs. Measured on one live Lever form:
 *
 *   "How did you learn about this opportunity?"  bank "JobRight",   13 options → review ×13
 *   "…able to begin a new opportunity"           bank "Flexible…",   6 options → review ×6
 *   "Are you able to work onsite?"               bank "Remote",      2 options → review ×1
 *
 * Twenty stops on one form, every answer in hand. This tier asks the model
 * to pick from the page's own list, and the choice is validated back
 * against that list verbatim before it can fill — the model cannot invent
 * an option, only choose one. Abstention is a first-class answer and parks
 * exactly as before.
 *
 * Gated by SCREENER_LLM_MATCH_ENABLED (the same flag as label mapping) and
 * an LLM key. Off, or keyless, or on any error: returns nothing and every
 * caller keeps its existing review.
 */

const SYSTEM_PROMPT = `You map a job applicant's stored answer onto the exact options an application form offers.

For each item you get: the question, the applicant's stored answer, and the form's full option list.
Choose the single option that best represents the stored answer.

The options array is the entire answer space. The fill engine clicks one of those strings. Return that option's text EXACTLY as it appears in the array (same characters, same punctuation, same capitalization). Do not paraphrase.

- If no option faithfully represents the stored answer, return null.
- Never choose an option that changes the meaning. "Remote" must not become "Onsite".
- Never map a work-arrangement preference (Remote / Hybrid / On-site) onto a Yes/No ability question. Abstain.
- For "how did you hear about us"-style questions, a general channel option
  (e.g. "Job board", "Other", "Online search") faithfully represents a specific job board.

Respond with JSON only: {"choices":[{"key":"<key>","option":"<exact option or null>"}]}`;

export type OptionSelectItem = {
  /** Stable id for the field this resolves (the caller's field id). */
  key: string;
  question: string;
  /** The answer already held for this question. */
  answer: string;
  options: string[];
};

export type OptionSelectResult = {
  key: string;
  option: string;
  /** Always "llm_option" — the basis recorded on the fill plan entry. */
  basis: "llm_option";
};

/** Cap per call: one batch per form, and forms do not have 40 dropdowns. */
const MAX_ITEMS = 25;

const PREFERENCE_ANSWER_RE = /^(remote|hybrid|on-?site|onsite|fully remote|in-?office)$/i;

function optionSelectable(item: OptionSelectItem): boolean {
  if (item.options.length === 0) return false;
  if (isYesNoOptionList(item.options) && PREFERENCE_ANSWER_RE.test(item.answer.trim())) {
    return false;
  }
  return true;
}

export async function selectScreenerOptions(input: {
  items: OptionSelectItem[];
  client?: EmailLlmClient;
  traceUrl?: string;
}): Promise<OptionSelectResult[]> {
  const cfg = getConfig();
  const items = input.items.filter(optionSelectable).slice(0, MAX_ITEMS);
  if (!cfg.screenerLlmMatchEnabled || items.length === 0) return [];
  if (!hasLlmKey(cfg) && !input.client) return [];

  try {
    const client = input.client ?? makeLlmClient();
    const userPayload = {
      items: items.map((i) => ({
        key: i.key,
        question: i.question.slice(0, 300),
        stored_answer: i.answer.slice(0, 300),
        options: i.options,
      })),
    };
    const { text } = await client.generateJson({
      system: SYSTEM_PROMPT,
      user: JSON.stringify(userPayload),
    });
    if (input.traceUrl) {
      await postSandboxTrace(
        input.traceUrl,
        llmTraceEvent({
          surface: "option-select",
          system: SYSTEM_PROMPT,
          user: userPayload,
          response: text,
        }),
      );
    }
    const parsed = JSON.parse(text) as {
      choices?: Array<{ key?: unknown; option?: unknown }>;
    };
    const byKey = new Map(items.map((i) => [i.key, i]));
    const out: OptionSelectResult[] = [];
    for (const choice of parsed.choices ?? []) {
      if (typeof choice.key !== "string" || typeof choice.option !== "string") {
        continue; // null / malformed = abstain
      }
      const item = byKey.get(choice.key);
      if (!item) continue;
      const snapped = validatePrediction(choice.option, item.options);
      if (!snapped.ok) {
        logger.warn("screener option choice rejected (not on the page)", {
          service: "screeners",
          action: "option_select_rejected",
          metadata: { question: item.question.slice(0, 120) },
        });
        continue;
      }
      out.push({ key: item.key, option: snapped.value, basis: "llm_option" });
    }
    logger.info("screener option selection", {
      service: "screeners",
      action: "option_select",
      metadata: { asked: items.length, chosen: out.length },
    });
    return out;
  } catch (err) {
    logger.warn("screener option selection failed (fail-open: park as before)", {
      service: "screeners",
      action: "option_select_error",
      metadata: {
        items: items.length,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      },
    });
    return [];
  }
}

/**
 * Does this resolution park only because the held answer did not match an
 * option literally? Those are the ones worth a model call; a "human
 * decision by policy" or a genuinely absent answer is not.
 */
export function isOptionMismatchReview(
  resolution: ScreenerResolution,
): resolution is ScreenerResolution & { status: "review"; reason: string } {
  return (
    resolution.status === "review" &&
    typeof resolution.reason === "string" &&
    /matches none of the \d+ page options|matches no page option/.test(
      resolution.reason,
    )
  );
}

/** The held answer quoted inside the matcher's review reason. */
export function heldAnswerFromReason(reason: string): string | null {
  const m = reason.match(/(?:bank answer|predicted|promoted answer) "([^"]+)"/);
  return m?.[1] ?? null;
}
