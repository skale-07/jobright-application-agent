import type { Page } from "playwright";
import type {
  SubmissionAttempt,
  SubmissionReceipt,
  SubmitClickOptions,
} from "../adapter.js";
import { CLICK_WITHHELD_NOTE } from "../adapter.js";
import { assertSubmitAllowed } from "../../applications/formFillGuards.js";
import { detectErrorPageSignals } from "../greenhouse/identityVerification.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import { genericSelectorsV1 } from "./selectors.js";
import { resolveSubmitControl } from "../shared/submitControl.js";
import {
  SubmissionUncertainError,
  detectVisibleValidationError,
} from "../shared/submissionUncertain.js";

export { SubmissionUncertainError } from "../shared/submissionUncertain.js";

export type SubmissionPageClassification =
  | "confirmed"
  | "still_on_form"
  | "error_page"
  | "unknown";

/**
 * A structural signature of the form's fields.
 *
 * Vendor adapters prove "the form is gone" with a product-specific DOM
 * marker (`data-automation-id=`, `data-ui=`). A company-hosted form has no
 * such marker, and confirmation TEXT alone is not enough — "thank you for
 * your interest" sits in footers on live, unsubmitted pages, which is
 * exactly the fabricated-receipt failure the vendor registries warn about.
 *
 * So the negative signal is structural instead: fingerprint the fields
 * before the click, and require them to be gone afterwards. This is
 * stricter than a text marker, not looser — a page still showing the same
 * inputs is never "confirmed" no matter what it says.
 */
export function fieldFingerprint(html: string): string[] {
  const fields = discoverFieldsFromHtml(html);
  const ids = fields
    .map((f) => (f.inputId || f.name || f.label || "").trim().toLowerCase())
    .filter((s) => s.length > 0);
  return [...new Set(ids)].sort();
}

/** Fraction of the pre-click fields still present (0 = form gone). */
export function fingerprintOverlap(before: string[], after: string[]): number {
  if (before.length === 0) return 0;
  const now = new Set(after);
  const survivors = before.filter((id) => now.has(id)).length;
  return survivors / before.length;
}

/**
 * Post-click classification for a generic employer form. Confirmation
 * needs BOTH halves: the industry-standard confirmation language, and
 * evidence the form itself is gone (structural fingerprint, or the
 * absence of any form at all).
 */
export function classifyGenericSubmission(
  html: string,
  finalUrl: string,
  context: { preClickFingerprint: string[] },
): SubmissionPageClassification {
  if (detectErrorPageSignals(html, "")) return "error_page";

  const overlap = fingerprintOverlap(
    context.preClickFingerprint,
    fieldFingerprint(html),
  );
  const formGone = overlap <= 0.25 || !genericSelectorsV1.formMarkers.test(html);
  if (genericSelectorsV1.confirmationMarkers.test(html) && formGone) {
    return "confirmed";
  }
  if (!formGone) return "still_on_form";
  void finalUrl; // a URL alone never confirms on an unknown host
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
 * Click the submit control through the shared ranked cascade (accessible
 * name → CSS, form-scoped, wizard/save names excluded); a miss carries the
 * CTA inventory in the notes. assertSubmitAllowed is the last line of
 * defense, exactly as on a vendor adapter.
 *
 * The pre-click field fingerprint is captured HERE, immediately before the
 * click, and stashed on the page so verifySubmission can compare against
 * it — the two run as separate calls through the AtsBinding.
 */
export async function genericSubmit(
  page: Page,
  opts: SubmitClickOptions = {},
): Promise<SubmissionAttempt> {
  assertSubmitAllowed("generic.submit");
  const resolution = await resolveSubmitControl(
    page,
    genericSelectorsV1.submitCascade,
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

  const before = fieldFingerprint(await page.content().catch(() => ""));
  rememberFingerprint(page, before);
  notes.push(`pre-click field fingerprint: ${before.length} field(s)`);

  if (opts.beforeClick && !(await opts.beforeClick())) {
    return { clicked: false, notes: [...notes, CLICK_WITHHELD_NOTE] };
  }
  await control.click();
  notes.push("submit control clicked");
  await page.waitForTimeout(2000);
  return { clicked: true, notes };
}

/**
 * Pre-click fingerprints, keyed by Page. A WeakMap so a closed page is
 * collected; never persisted, never an artifact.
 */
const FINGERPRINTS = new WeakMap<Page, string[]>();

export function rememberFingerprint(page: Page, fingerprint: string[]): void {
  FINGERPRINTS.set(page, fingerprint);
}

export function recallFingerprint(page: Page): string[] {
  return FINGERPRINTS.get(page) ?? [];
}

/**
 * Verify from the page in hand. No fingerprint (verify called without a
 * preceding genericSubmit) means the structural check degrades to "is
 * there still a form" — never to a text-only pass.
 */
export async function genericVerifySubmission(
  page: Page,
  options: { screenshotPath: string; timeoutMs?: number },
): Promise<SubmissionReceipt> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  const preClickFingerprint = recallFingerprint(page);

  let classification: SubmissionPageClassification = "unknown";
  let html = "";
  let validationError: string | null = null;
  while (Date.now() < deadline) {
    try {
      html = await page.content();
    } catch {
      await page.waitForTimeout(500);
      continue;
    }
    classification = classifyGenericSubmission(html, page.url(), {
      preClickFingerprint,
    });
    if (classification === "confirmed" || classification === "error_page") {
      break;
    }
    // Fast fail: still on the form with a visible validation message —
    // the submit was rejected and the reason is already on screen.
    if (classification === "still_on_form") {
      validationError = detectVisibleValidationError(html);
      if (validationError) break;
    }
    await page.waitForTimeout(1000);
  }

  await page
    .screenshot({ path: options.screenshotPath, fullPage: true })
    .catch(() => undefined);

  if (classification !== "confirmed") {
    throw new SubmissionUncertainError(
      validationError
        ? `Submission rejected by the form: "${validationError}" (page classified: ${classification})`
        : `Submission not confirmed within ${timeoutMs}ms (page classified: ${classification})`,
      {
        classification,
        validation_error: validationError,
        final_url: page.url(),
        screenshot_path: options.screenshotPath,
        html_bytes: html.length,
      },
    );
  }

  const matched = html.match(genericSelectorsV1.confirmationMarkers);
  return {
    submitted: true,
    submitted_at: new Date().toISOString(),
    confirmation_url: page.url(),
    confirmation_text: matched?.[0] ?? "confirmation markers matched",
    application_identifier: extractApplicationIdentifier(html),
    screenshot_path: options.screenshotPath,
  };
}
