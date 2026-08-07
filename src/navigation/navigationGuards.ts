import { getConfig } from "../config/index.js";

/**
 * Navigation is mutation-class: clicking Apply on live JobRight mutates
 * the account's applied-state. Fail closed on its own flag — nav never
 * reads or requires the fill/submit flags (precedent:
 * MATERIALS_DOWNLOAD_ENABLED).
 */
export function assertNavigationAllowed(reason: string): void {
  const cfg = getConfig();
  if (!cfg.navigationEnabled) {
    throw new Error(
      `NAVIGATION_ENABLED=false — refusing navigation (${reason}). Set NAVIGATION_ENABLED=true in the operator shell for a guarded nav run.`,
    );
  }
}
