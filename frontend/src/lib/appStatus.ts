import type { IconName } from "../components/Icon";

/**
 * The console's single operator-facing status vocabulary.
 *
 * There used to be three. `StateBadge` printed the raw machine state
 * (~38 of them, SHOUTING_SNAKE_CASE); this file derived six lowercase
 * chips from it; `plainLanguage.ts` wrote a third set in prose. A user
 * reading Home, Applications and a detail page saw the same application
 * described three different ways, and had to learn that "SUBMITTING",
 * "ready" and "about to send" were one thing.
 *
 * So: this is the vocabulary. Raw states stay available where an
 * operator is already debugging (the detail page's technical block, the
 * advanced pages), never as the primary label. `plainLanguage.ts` keeps
 * its job — it speaks about review ITEMS, which is a different question
 * ("what does this need from me") than an application's status.
 *
 * Colour carries urgency and nothing else — grey nothing, blue Dispatch
 * is working, green done, amber you, red broken. The icon carries
 * identity. That is why `needs-you` and `failed` no longer look alike:
 * they were both danger-red before, which told the operator that a form
 * question they can answer in ten seconds is as bad as a crash.
 */

export type AppStatus =
  | "queued"
  | "filling"
  | "ready"
  | "submitted"
  | "needs-you"
  | "failed";

export type StatusTone = "ok" | "warn" | "danger" | "accent" | "neutral";

export type StatusPresentation = {
  /** What the operator reads. Lowercase: this is a label, not a shout. */
  label: string;
  /** Badge class — urgency class, not per-status identity. */
  tone: StatusTone;
  icon: IconName;
  /** One sentence, on hover and in the detail head. */
  hint: string;
};

export const APP_STATUS: Record<AppStatus, StatusPresentation> = {
  queued: {
    label: "queued",
    tone: "neutral",
    icon: "clock",
    hint: "Waiting its turn. Dispatch starts this on its own.",
  },
  filling: {
    label: "filling",
    tone: "accent",
    icon: "play",
    hint: "Dispatch is working through this form right now.",
  },
  ready: {
    label: "ready to send",
    tone: "accent",
    icon: "bolt",
    hint: "Filled and verified. It goes out on the next submit run.",
  },
  submitted: {
    label: "submitted",
    tone: "ok",
    icon: "check",
    hint: "Sent. Outreach to people inside the company runs from here.",
  },
  "needs-you": {
    label: "needs you",
    tone: "warn",
    icon: "alert",
    hint: "Dispatch hit something only you can clear — usually one question or one login.",
  },
  failed: {
    label: "failed",
    tone: "danger",
    icon: "x",
    hint: "This attempt ended in an error. Nothing was sent.",
  },
};

const WALL_STATES = new Set([
  "ESSAY_REQUIRED",
  "AUTH_REQUIRED",
  "CAPTCHA_REQUIRED",
  "AMBIGUOUS_FIELD",
  "UNSUPPORTED_ATS",
  "SUBMISSION_VERIFICATION_FAILED",
]);

const SUBMITTED_STATES = new Set([
  "SUBMITTED",
  "CONTACTS_EXTRACTING",
  "CONTACTS_EXTRACTED",
  "LINKEDIN_ENRICHING",
  "LINKEDIN_ENRICHED",
  "EMAIL_GENERATING",
  "EMAIL_GENERATED",
  "DRAFT_CREATING",
  "DRAFT_CREATED",
  "COMPLETED",
]);

const QUEUED_STATES = new Set([
  "DISCOVERED",
  "DUPLICATE_CHECK",
  "ELIGIBILITY_CHECK",
  "QUEUED",
]);

const FAILED_STATES = new Set(["FAILED_RETRYABLE", "FAILED_FINAL", "FILTERED_OUT"]);

export function deriveStatus(state: string, hasOpenReview: boolean): AppStatus {
  if (hasOpenReview || WALL_STATES.has(state)) return "needs-you";
  if (FAILED_STATES.has(state)) return "failed";
  if (SUBMITTED_STATES.has(state)) return "submitted";
  if (state === "READY_TO_SUBMIT" || state === "SUBMITTING") return "ready";
  if (QUEUED_STATES.has(state)) return "queued";
  return "filling";
}
