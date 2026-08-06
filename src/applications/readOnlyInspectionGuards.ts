import { getConfig, resetConfigCache } from "../config/index.js";

/**
 * Fail-closed guard for read-only live/fixture inspections.
 * Requires FORM_FILL_ENABLED=false, DRY_RUN=true, SUBMIT_ENABLED=false.
 */
export function assertReadOnlyInspectionAllowed(reason: string): void {
  resetConfigCache();
  const cfg = getConfig();
  if (cfg.formFillEnabled || !cfg.dryRun || cfg.submitEnabled) {
    throw new Error(
      `Read-only inspection refused because unsafe environment flags are enabled (${reason}). ` +
        `Require FORM_FILL_ENABLED=false DRY_RUN=true SUBMIT_ENABLED=false ` +
        `(got FORM_FILL_ENABLED=${cfg.formFillEnabled} DRY_RUN=${cfg.dryRun} SUBMIT_ENABLED=${cfg.submitEnabled}).`,
    );
  }
}
