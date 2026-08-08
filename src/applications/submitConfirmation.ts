import { waitForEnter } from "../util/stdin.js";

/**
 * The submit confirmation seam. Submission always requires explicit
 * operator confirmation (when SUBMIT_REQUIRES_LOCAL_CONFIRMATION is on,
 * which is the default and is forced for console-launched runs); this
 * module only defines the TRANSPORT of that confirmation. The default is
 * today's TTY prompt, byte-identical; the console injects a callback that
 * carries the same summary to a web modal over the runner's stdio. The
 * callback sits at exactly the point the TTY prompt sits — it cannot skip
 * any gate, and every failure mode of an injected transport must resolve
 * to false (decline ⇒ REFUSED).
 */

export type SubmitConfirmationSummary = {
  application_id: string;
  company: string | null;
  role: string | null;
  url: string;
  attempt: number;
  /** Full sha256 — presentation layers truncate for display. */
  resume_sha256: string;
  resume_size_bytes: number;
  plan: {
    fillable_count: number;
    skipped_count: number;
    review_required_count: number;
  };
};

export type ConfirmSubmission = (
  summary: SubmitConfirmationSummary,
) => Promise<boolean>;

/**
 * The exact block the CLI has always printed — kept as a function so a
 * test can pin it character-for-character (CLI byte-identity guard).
 */
export function formatTtyConfirmation(s: SubmitConfirmationSummary): string {
  return [
    "\n=== SUBMIT CONFIRMATION ===",
    `  company : ${s.company ?? "?"}`,
    `  role    : ${s.role ?? "?"}`,
    `  url     : ${s.url}`,
    `  attempt : ${s.attempt}`,
    `  resume  : sha256 ${s.resume_sha256.slice(0, 16)}… (${s.resume_size_bytes} bytes)`,
    `  plan    : ${s.plan.fillable_count} fill, ${s.plan.skipped_count} skip, ${s.plan.review_required_count} review`,
  ].join("\n");
}

/**
 * Default transport: print the block, block on Enter, proceed. It never
 * declines — exactly today's CLI behavior (Ctrl+C aborts the process).
 */
export function defaultTtyConfirm(
  waitForEnterImpl: (prompt: string) => Promise<void> = waitForEnter,
): ConfirmSubmission {
  return async (summary) => {
    console.log(formatTtyConfirmation(summary));
    await waitForEnterImpl(
      "Press Enter to fill and SUBMIT this application, Ctrl+C to abort... ",
    );
    return true;
  };
}
