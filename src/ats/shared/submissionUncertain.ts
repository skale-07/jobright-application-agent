/**
 * Shared uncertain-submission error for the unwired adapters (Lever, Ashby)
 * so evidence-carrying catches work across both with one instanceof.
 * NOTE for the wiring milestone: src/applications/submitRun.ts checks
 * `instanceof` against the greenhouse module's own SubmissionUncertainError
 * — reconcile the greenhouse class with this one when wiring, or the
 * structured evidence (classification, final_url, screenshot_path) will be
 * silently dropped to a message string for Lever/Ashby runs.
 */
export class SubmissionUncertainError extends Error {
  readonly evidence: Record<string, unknown>;
  constructor(message: string, evidence: Record<string, unknown>) {
    super(message);
    this.name = "SubmissionUncertainError";
    this.evidence = evidence;
  }
}

/**
 * A visible validation error on a still-on-form page means the submit was
 * REJECTED — waiting the rest of the 15s confirmation window teaches
 * nothing (live corpus: 12 × "still_on_form" runs each burned the full
 * window on an answer that was already on screen). Returns the first
 * matched error text so the artifact says WHY, or null when no validation
 * message is visible.
 *
 * Deliberately narrow: matches the phrasings ATSes actually render next to
 * fields, not any "error" substring — a job description mentioning
 * "error budgets" must not fast-fail a real confirmation wait.
 */
const VALIDATION_ERROR_RE =
  /((?:this\s+)?field\s+is\s+required|is\s+a\s+required\s+field|(?:please\s+)?(?:fill\s+(?:in|out)|complete|select|enter|answer)\s+(?:this|all|the)\s+(?:required\s+)?(?:field|fields|question|questions)|required\s+fields?\s+(?:are\s+)?(?:missing|incomplete)|please\s+correct\s+the\s+errors?|there\s+(?:was|were)\s+(?:a\s+)?(?:problem|errors?)\s+(?:with|submitting)\s+your\s+(?:application|form|submission)|couldn'?t\s+submit\s+your\s+application|failed\s+to\s+submit)/i;

export function detectVisibleValidationError(html: string): string | null {
  const m = html.match(VALIDATION_ERROR_RE);
  if (!m) return null;
  return m[0].replace(/\s+/g, " ").trim().slice(0, 120);
}
