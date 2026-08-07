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
