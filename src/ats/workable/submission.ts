import type { Page } from "playwright";
import type {
  SubmissionAttempt,
  SubmissionReceipt,
  SubmitClickOptions,
} from "../adapter.js";
import { CLICK_WITHHELD_NOTE } from "../adapter.js";
import { assertSubmitAllowed } from "../../applications/formFillGuards.js";
import { detectErrorPageSignals } from "../greenhouse/identityVerification.js";
import { workableSelectorsV1 } from "./selectors.js";
import { resolveSubmitControl } from "../shared/submitControl.js";
import { SubmissionUncertainError } from "../shared/submissionUncertain.js";

export { SubmissionUncertainError } from "../shared/submissionUncertain.js";

export type SubmissionPageClassification =
  | "confirmed"
  | "still_on_form"
  | "error_page"
  | "unknown";

function isThankYouUrl(finalUrl: string): boolean {
  try {
    const u = new URL(finalUrl);
    return /\/(thank[-_]?you|thanks)\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Pure classification of the page after a submit click, Lever-shaped:
 * marker-based confirmation requires the form to be GONE, error signals
 * beat the URL-only signal, and everything else errs toward a review item
 * rather than a fabricated receipt.
 */
export function detectSubmissionUncertainty(
  html: string,
  finalUrl: string,
): SubmissionPageClassification {
  if (
    workableSelectorsV1.confirmationMarkers.test(html) &&
    !workableSelectorsV1.formMarkers.test(html)
  ) {
    return "confirmed";
  }
  if (detectErrorPageSignals(html, "")) {
    return "error_page";
  }
  if (isThankYouUrl(finalUrl)) {
    return "confirmed";
  }
  if (workableSelectorsV1.formMarkers.test(html)) {
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
 * Click the Workable submit control through the shared ranked cascade
 * (accessible name → data-ui/CSS, form-scoped, wizard names excluded); a
 * miss carries the CTA inventory in the notes. assertSubmitAllowed runs
 * here as the last line of defense.
 */
export async function workableSubmit(
  page: Page,
  opts: SubmitClickOptions = {},
): Promise<SubmissionAttempt> {
  assertSubmitAllowed("workable.submit");
  const resolution = await resolveSubmitControl(
    page,
    workableSelectorsV1.submitCascade,
  );
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
  if (opts.beforeClick && !(await opts.beforeClick())) {
    return { clicked: false, notes: [...notes, CLICK_WITHHELD_NOTE] };
  }
  await control.click();
  notes.push("submit control clicked");
  // Workable confirms in-page (SPA) or via a thank-you route — wait for
  // either, tolerating the in-page case.
  await page
    .waitForURL(/\/(thank[-_]?you|thanks)\/?$/i, { timeout: 15_000 })
    .catch(() => notes.push("no thank-you navigation after click"));
  await page.waitForTimeout(1500);
  return { clicked: true, notes };
}

/**
 * Verify the submission from the page actually in hand. Success requires
 * the thank-you URL or explicit confirmation text with the form gone; a
 * screenshot is captured either way so the uncertain path carries evidence.
 */
export async function workableVerifySubmission(
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
      // Navigation can destroy the execution context mid-poll — retry.
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

  const matched = html.match(workableSelectorsV1.confirmationMarkers);
  return {
    submitted: true,
    submitted_at: new Date().toISOString(),
    confirmation_url: page.url(),
    confirmation_text:
      matched?.[0] ??
      (isThankYouUrl(page.url())
        ? "redirected to thank-you confirmation URL"
        : "confirmation markers matched"),
    application_identifier: extractApplicationIdentifier(html),
    screenshot_path: options.screenshotPath,
  };
}
