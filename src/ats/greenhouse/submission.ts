import type { Page } from "playwright";
import type { SubmissionAttempt, SubmissionReceipt } from "../adapter.js";
import { assertSubmitAllowed } from "../../applications/formFillGuards.js";
import { detectErrorPageSignals } from "./identityVerification.js";
import { greenhouseSelectorsV1 } from "./selectors.js";

export type SubmissionPageClassification =
  | "confirmed"
  | "still_on_form"
  | "error_page"
  | "unknown";

export class SubmissionUncertainError extends Error {
  readonly evidence: Record<string, unknown>;
  constructor(message: string, evidence: Record<string, unknown>) {
    super(message);
    this.name = "SubmissionUncertainError";
    this.evidence = evidence;
  }
}

/**
 * Pure classification of the page after a submit click.
 * "confirmed" requires explicit confirmation text — anything else is not
 * treated as success.
 */
export function detectSubmissionUncertainty(
  html: string,
  finalUrl: string,
): SubmissionPageClassification {
  if (greenhouseSelectorsV1.confirmationMarkers.test(html)) {
    return "confirmed";
  }
  if (detectErrorPageSignals(html, "")) {
    return "error_page";
  }
  if (greenhouseSelectorsV1.formMarkers.test(html)) {
    return "still_on_form";
  }
  void finalUrl;
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
 * Click the Greenhouse submit control. assertSubmitAllowed runs here as the
 * last line of defense even though callers gate earlier.
 */
export async function greenhouseSubmit(page: Page): Promise<SubmissionAttempt> {
  assertSubmitAllowed("greenhouse.submit");
  const notes: string[] = [];
  const control = page.locator(greenhouseSelectorsV1.submit).first();
  if ((await control.count()) === 0) {
    return { clicked: false, notes: ["submit control not found"] };
  }
  if (await control.isDisabled().catch(() => false)) {
    return { clicked: false, notes: ["submit control disabled"] };
  }
  await control.click();
  notes.push("submit control clicked");
  await page
    .waitForLoadState("domcontentloaded", { timeout: 30_000 })
    .catch(() => notes.push("no navigation after click (SPA confirmation?)"));
  await page.waitForTimeout(1500);
  return { clicked: true, notes };
}

/**
 * Verify the submission from the page actually in hand. Success requires
 * explicit confirmation text; a screenshot is captured either way so the
 * uncertain path still carries evidence.
 */
export async function greenhouseVerifySubmission(
  page: Page,
  options: { screenshotPath: string; timeoutMs?: number },
): Promise<SubmissionReceipt> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;

  let classification: SubmissionPageClassification = "unknown";
  let html = "";
  while (Date.now() < deadline) {
    html = await page.content();
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

  const matched = html.match(greenhouseSelectorsV1.confirmationMarkers);
  return {
    submitted: true,
    submitted_at: new Date().toISOString(),
    confirmation_url: page.url(),
    confirmation_text: matched?.[0] ?? "confirmation markers matched",
    application_identifier: extractApplicationIdentifier(html),
    screenshot_path: options.screenshotPath,
  };
}
