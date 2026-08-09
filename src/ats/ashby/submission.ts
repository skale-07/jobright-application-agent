import type { Page } from "playwright";
import type { SubmissionAttempt, SubmissionReceipt } from "../adapter.js";
import { assertSubmitAllowed } from "../../applications/formFillGuards.js";
import { detectErrorPageSignals } from "../greenhouse/identityVerification.js";
import { ashbySelectorsV1 } from "./selectors.js";
import { resolveSubmitControl } from "../shared/submitControl.js";

import { SubmissionUncertainError } from "../shared/submissionUncertain.js";

export { SubmissionUncertainError } from "../shared/submissionUncertain.js";

export type SubmissionPageClassification =
  | "confirmed"
  | "still_on_form"
  | "error_page"
  | "unknown";

/**
 * Pure classification of the page after a submit click. Ashby is a SPA:
 * success is an in-page panel and the URL does NOT change — an unchanged
 * URL is never treated as failure, only the absence of explicit
 * confirmation markers is. Confirmation additionally requires the form to
 * be GONE: confirmation-like copy while the form still renders classifies
 * still_on_form, erring toward a review item rather than a fabricated
 * receipt.
 */
export function detectSubmissionUncertainty(
  html: string,
  finalUrl: string,
): SubmissionPageClassification {
  void finalUrl;
  // renderedFormMarkers, not the broad formMarkers: the SPA's script/JSON
  // blobs keep "_systemfield_" strings after a successful submit, and a
  // real success must not classify still_on_form forever.
  if (
    ashbySelectorsV1.confirmationMarkers.test(html) &&
    !ashbySelectorsV1.renderedFormMarkers.test(html)
  ) {
    return "confirmed";
  }
  if (detectErrorPageSignals(html, "")) {
    return "error_page";
  }
  if (ashbySelectorsV1.renderedFormMarkers.test(html)) {
    return "still_on_form";
  }
  return "unknown";
}

/** Try to pull an application/candidate identifier out of confirmation text. */
export function extractApplicationIdentifier(html: string): string | null {
  const m = html.match(
    /(?:application|confirmation|reference)\s*(?:id|number|#)\s*[:#]?\s*([A-Za-z0-9-]{4,40})/i,
  );
  return m?.[1] ?? null;
}

/**
 * Click the Ashby submit control, resolved through the ranked cascade
 * (accessible name → CSS, form-scoped, wizard names excluded) — a bare
 * `button[type=submit]` query is exactly what failed on the first live
 * Ashby attempt. On a miss the CTA inventory rides in the notes so the
 * submit report carries evidence instead of a black box.
 * assertSubmitAllowed runs here as the last line of defense even though
 * callers gate earlier.
 */
export async function ashbySubmit(page: Page): Promise<SubmissionAttempt> {
  assertSubmitAllowed("ashby.submit");
  const resolution = await resolveSubmitControl(page, ashbySelectorsV1.submitCascade);
  if (!resolution.found) {
    return {
      clicked: false,
      notes: [
        "submit control not found",
        ...resolution.notes,
        `cta inventory: ${JSON.stringify(resolution.inventory)}`,
      ],
    };
  }
  const notes: string[] = [...resolution.notes];
  const control = resolution.control;
  if (await control.isDisabled().catch(() => false)) {
    return { clicked: false, notes: [...notes, "submit control disabled"] };
  }
  await control.click();
  notes.push("submit control clicked");
  // SPA: no navigation expected — the success panel renders in place.
  await page.waitForTimeout(1500);
  return { clicked: true, notes };
}

/**
 * Verify the submission from the page actually in hand. Success requires
 * the explicit in-page confirmation panel; a screenshot is captured either
 * way so the uncertain path still carries evidence.
 */
export async function ashbyVerifySubmission(
  page: Page,
  options: { screenshotPath: string; timeoutMs?: number },
): Promise<SubmissionReceipt> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;

  let classification: SubmissionPageClassification = "unknown";
  let html = "";
  while (Date.now() < deadline) {
    try {
      html = await page.content();
    } catch {
      // A mid-poll re-render/navigation can destroy the execution context —
      // retry after it settles instead of surfacing a raw error.
      await page.waitForTimeout(500);
      continue;
    }
    classification = detectSubmissionUncertainty(html, page.url());
    if (classification === "confirmed" || classification === "error_page") {
      break;
    }
    await page.waitForTimeout(1000);
  }

  await page
    .screenshot({ path: options.screenshotPath, fullPage: true })
    .catch(() => undefined);

  if (classification !== "confirmed") {
    throw new SubmissionUncertainError(
      `Submission not confirmed within ${timeoutMs}ms (page classified: ${classification})`,
      {
        classification,
        final_url: page.url(),
        screenshot_path: options.screenshotPath,
        html_bytes: html.length,
      },
    );
  }

  const matched = html.match(ashbySelectorsV1.confirmationMarkers);
  return {
    submitted: true,
    submitted_at: new Date().toISOString(),
    confirmation_url: page.url(),
    confirmation_text: matched?.[0] ?? "confirmation markers matched",
    application_identifier: extractApplicationIdentifier(html),
    screenshot_path: options.screenshotPath,
  };
}
