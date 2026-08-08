import type { Page } from "playwright";
import { logger } from "../logging/logger.js";
import type { DisabledSubmitDiagnosis } from "../ats/shared/submitDiagnostics.js";
import type { FetchVerificationCode } from "./codeProviders.js";

/**
 * Recovery for an in-form email-verification wall: fetch the code from the
 * operator's mailbox (provider already flag-gated), type it into the
 * detected input, and wait for the submit control to enable. Exactly one
 * recovery attempt per submission run; the caller then re-runs the normal
 * single-click submit path. The code itself never lands in logs, SQLite,
 * or artifacts — only its length is recorded.
 */
export async function recoverEmailVerification(
  page: Page,
  diagnosis: DisabledSubmitDiagnosis,
  options: {
    fetchCode: FetchVerificationCode;
    submitSelector: string;
    requestedAt: string;
    enableTimeoutMs?: number;
  },
): Promise<{ entered: boolean; submitEnabled: boolean; notes: string[] }> {
  const notes: string[] = [];
  const inputSelector = diagnosis.verification.input_selector;
  if (!diagnosis.verification.detected || !inputSelector) {
    return { entered: false, submitEnabled: false, notes: ["no verification input detected"] };
  }

  const fetched = await options.fetchCode({
    requestedAt: options.requestedAt,
    emailHint: diagnosis.verification.email_hint,
  });
  if (!fetched) {
    notes.push("no verification code found in the mailbox within the poll cap");
    return { entered: false, submitEnabled: false, notes };
  }
  notes.push(`verification code retrieved from ${fetched.source} (${fetched.code.length} digits)`);

  const input = page.locator(inputSelector).first();
  if ((await input.count()) === 0) {
    notes.push("verification input disappeared before the code could be entered");
    return { entered: false, submitEnabled: false, notes };
  }
  await input.fill(fetched.code);
  // Some forms validate on blur/keyup — nudge both.
  await input.press("Tab").catch(() => undefined);
  notes.push("verification code entered");
  logger.info("submit verification code entered", {
    service: "verification",
    action: "code_entered",
    metadata: { source: fetched.source, code_length: fetched.code.length },
  });

  const enableTimeoutMs = options.enableTimeoutMs ?? 30_000;
  const deadline = Date.now() + enableTimeoutMs;
  const control = page.locator(options.submitSelector).first();
  let enabled = false;
  while (Date.now() < deadline) {
    if ((await control.count()) > 0 && !(await control.isDisabled().catch(() => true))) {
      enabled = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  notes.push(
    enabled
      ? "submit control enabled after code entry"
      : `submit control still disabled ${enableTimeoutMs}ms after code entry`,
  );
  return { entered: true, submitEnabled: enabled, notes };
}
