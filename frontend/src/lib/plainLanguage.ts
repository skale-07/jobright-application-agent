import type { ReviewItemView } from "../api/types";

/**
 * Plain-language layer for non-technical users: every review item becomes
 * "what happened + what you should do", with no state-machine vocabulary.
 * The technical title/payload stay available on the Review page — this is
 * the summary the Home to-do list speaks in.
 */

export type PlainItem = {
  /** Short imperative, e.g. "Answer 1 written question". */
  action: string;
  /** One sentence of context in normal words. */
  why: string;
  /** Rough urgency bucket for ordering the to-do list. */
  weight: number;
};

export function describeReviewItem(item: ReviewItemView): PlainItem {
  const payload = item.payload ?? {};
  switch (item.kind) {
    case "ESSAY": {
      const essays = payload["essays"];
      const n = Array.isArray(essays) ? essays.length : 1;
      const hasDraft = payload["essay_drafts"] !== undefined;
      return {
        action: `Answer ${n} written question${n === 1 ? "" : "s"}`,
        why: hasDraft
          ? "A draft answer is ready for you — read it, make it yours, and approve."
          : "The employer asks a question only you can answer.",
        weight: 10,
      };
    }
    case "CAPTCHA_REQUIRED":
      return {
        action: "Solve a CAPTCHA",
        why: "The employer's site showed a robot check. Open the page once and pass it; everything else resumes automatically.",
        weight: 20,
      };
    case "AUTH_REQUIRED":
      return {
        action: "Log in again",
        why: "A site signed you out. Log back in and the queue keeps moving.",
        weight: 20,
      };
    case "UNCERTAIN_SUBMISSION":
      return {
        action: "Confirm whether it submitted",
        why: "A submission ended uncertainly — confirm what happened before anything retries.",
        weight: 5,
      };
    case "DUPLICATE_RISK":
      return {
        action: "Possible duplicate — take a look",
        why: "This looks like a job you already applied to.",
        weight: 55,
      };
    case "UNSUPPORTED_ATS":
      return {
        action: "Paste the application link",
        why: "This employer uses a job site Dispatch can't fill automatically yet.",
        weight: 40,
      };
    case "AMBIGUOUS_FIELD":
      return {
        action: "Check one form field",
        why: "A field didn't verify after filling — a quick look sorts it out.",
        weight: 25,
      };
    default: {
      if (payload["source"] === "screener_prediction") {
        return {
          action: "Approve a suggested answer",
          why: `Dispatch met a new question — "${String(payload["question"] ?? "").slice(0, 80)}" — and suggests "${String(payload["predicted_answer"] ?? "")}". Approve or edit once; it fills automatically forever after.`,
          weight: 30,
        };
      }
      if (payload["source"] === "screener_question") {
        return {
          action: "Answer a question Dispatch couldn't fill",
          why: `A form asked "${String(payload["question"] ?? "").slice(0, 80)}" and Dispatch had no saved answer, so it left the field blank. Answer once here; every future form fills it automatically.`,
          weight: 12,
        };
      }
      const title = item.title.toLowerCase();
      if (title.includes("wrong company")) {
        return {
          action: "Wrong page caught — nothing to do",
          why: "Dispatch noticed it had the wrong company's page and stopped itself. It will find the right one; dismiss this when read.",
          weight: 60,
        };
      }
      if (title.includes("duplicate posting")) {
        return {
          action: "Duplicate found — dismiss it",
          why: "The same job was listed twice. The original application keeps going; this copy can be dismissed.",
          weight: 60,
        };
      }
      if (title.includes("url missing") || title.includes("url unknown")) {
        return {
          action: "Paste the application link",
          why: "Dispatch couldn't find where this job's application form lives.",
          weight: 40,
        };
      }
      return {
        action: "Take a look",
        why: item.title,
        weight: 50,
      };
    }
  }
}

/** "Cohere — ML Intern" or a safe fallback. */
export function jobLabel(item: {
  company?: string | null;
  role?: string | null;
}): string {
  if (item.company && item.role) return `${item.company} — ${item.role}`;
  return item.company ?? item.role ?? "One of your applications";
}
