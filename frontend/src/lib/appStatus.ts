/**
 * Operator-facing status chip, derived from the machine state + open-review
 * presence. Coarser than StateBadge on purpose: the L3 question is "what
 * does this app need from automation / from me", not which of ~38 states
 * it is in.
 */

export type AutomationChip =
  | "queued"
  | "filling"
  | "ready"
  | "submitted"
  | "needs-human"
  | "failed";

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

export function deriveChip(state: string, hasOpenReview: boolean): AutomationChip {
  if (hasOpenReview || WALL_STATES.has(state)) return "needs-human";
  if (FAILED_STATES.has(state)) return "failed";
  if (SUBMITTED_STATES.has(state)) return "submitted";
  if (state === "READY_TO_SUBMIT" || state === "SUBMITTING") return "ready";
  if (QUEUED_STATES.has(state)) return "queued";
  return "filling";
}

export const CHIP_CLASS: Record<AutomationChip, string> = {
  queued: "neutral",
  filling: "accent",
  ready: "warn",
  submitted: "ok",
  "needs-human": "danger",
  failed: "danger",
};
