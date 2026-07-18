import { getConfig } from "../config/index.js";

/**
 * Phase 4: form fill and submit must stay off unless explicitly enabled.
 * Later phases call these before mutating employer forms.
 */
export function assertFormFillAllowed(reason: string): void {
  const cfg = getConfig();
  if (!cfg.formFillEnabled) {
    throw new Error(
      `FORM_FILL_ENABLED=false — refusing form fill (${reason}). Phase 4 inspection only.`,
    );
  }
  if (cfg.dryRun) {
    throw new Error(
      `DRY_RUN=true — refusing form fill (${reason}). Use inspection dry-run instead.`,
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
