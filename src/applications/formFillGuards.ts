import { getConfig } from "../config/index.js";

/**
 * Form fill and submit stay fail-closed unless explicitly enabled.
 * Phase 5 implements fill/verify; submit remains Phase 7.
 */
export function assertFormFillAllowed(reason: string): void {
  const cfg = getConfig();
  if (!cfg.formFillEnabled) {
    throw new Error(
      `FORM_FILL_ENABLED=false — refusing form fill (${reason}). Use ats:fill --dry-run for a plan, or set FORM_FILL_ENABLED=true and DRY_RUN=false to execute.`,
    );
  }
  if (cfg.dryRun) {
    throw new Error(
      `DRY_RUN=true — refusing form fill (${reason}). Set DRY_RUN=false to execute fill.`,
    );
  }
}

export function assertSubmitAllowed(reason: string): void {
  assertFormFillAllowed(reason);
  const cfg = getConfig();
  if (!cfg.submitEnabled) {
    throw new Error(
      `SUBMIT_ENABLED=false — refusing submit (${reason}).`,
    );
  }
}

export function isInspectionOnlyMode(): boolean {
  const cfg = getConfig();
  return !cfg.formFillEnabled || cfg.dryRun;
}
