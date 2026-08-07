import type { Page } from "playwright";
import type { SubmissionAttempt, SubmissionReceipt } from "../adapter.js";
import { assertSubmitAllowed } from "../../applications/formFillGuards.js";
import { detectErrorPageSignals } from "../greenhouse/identityVerification.js";
import { leverSelectorsV1 } from "./selectors.js";

import { SubmissionUncertainError } from "../shared/submissionUncertain.js";

export { SubmissionUncertainError } from "../shared/submissionUncertain.js";

export type SubmissionPageClassification =
  | "confirmed"
  | "still_on_form"
  | "error_page"
  | "unknown";

function isThanksUrl(finalUrl: string): boolean {
  try {
    const u = new URL(finalUrl);
    return /\/thanks\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Pure classification of the page after a submit click. Lever redirects to
 * .../thanks on success, so the URL is a confirmation signal alongside the
 * in-page markers — everything else is not treated as success. Marker-based
 * confirmation additionally requires the form to be GONE: confirmation-like
 * copy on a page that still shows the form (posting text, footers, blocked
 * submits) classifies still_on_form, erring toward a review item rather
 * than a fabricated receipt.
 */
export function detectSubmissionUncertainty(
  html: string,
  finalUrl: string,
): SubmissionPageClassification {
  if (
    leverSelectorsV1.confirmationMarkers.test(html) &&
    !leverSelectorsV1.formMarkers.test(html)
  ) {
    return "confirmed";
  }
  // Error signals BEFORE the URL-only signal: an error body served at the
  // /thanks URL must never yield a fabricated receipt.
  if (detectErrorPageSignals(html, "")) {
    return "error_page";
  }
  if (isThanksUrl(finalUrl)) {
    return "confirmed";
  }
  if (leverSelectorsV1.formMarkers.test(html)) {
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
 * Click the Lever submit control. assertSubmitAllowed runs here as the last
 * line of defense even though callers gate earlier. NOT WIRED: nothing in
 * the pipeline invokes this until the wiring milestone.
 */
export async function leverSubmit(page: Page): Promise<SubmissionAttempt> {
  assertSubmitAllowed("lever.submit");
  const notes: string[] = [];
  const control = page.locator(leverSelectorsV1.submit).first();
  if ((await control.count()) === 0) {
    return { clicked: false, notes: ["submit control not found"] };
  }
  if (await control.isDisabled().catch(() => false)) {
    return { clicked: false, notes: ["submit control disabled"] };
  }
  await control.click();
  notes.push("submit control clicked");
  // waitForLoadState resolves instantly on the already-loaded document —
  // wait for the actual /thanks navigation, tolerating in-page confirms.
  await page
    .waitForURL(/\/thanks\/?$/i, { timeout: 15_000 })
    .catch(() => notes.push("no /thanks navigation after click"));
  await page.waitForTimeout(1500);
  return { clicked: true, notes };
}

/**
 * Verify the submission from the page actually in hand. Success requires the
 * /thanks URL or explicit confirmation text; a screenshot is captured either
 * way so the uncertain path still carries evidence.
 */
export async function leverVerifySubmission(
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
      // The expected /thanks navigation can destroy the execution context
      // mid-poll — retry after it settles instead of surfacing a raw error.
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

  const matched = html.match(leverSelectorsV1.confirmationMarkers);
  return {
    submitted: true,
    submitted_at: new Date().toISOString(),
    confirmation_url: page.url(),
    confirmation_text:
      matched?.[0] ??
      (isThanksUrl(page.url())
        ? "redirected to /thanks confirmation URL"
        : "confirmation markers matched"),
    application_identifier: extractApplicationIdentifier(html),
    screenshot_path: options.screenshotPath,
  };
}
