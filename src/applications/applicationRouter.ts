import type { ApplicationRouteDecision } from "./applicationInspector.js";

/**
 * Coarse routing for Stage 1. Fill/submit phases must re-check flags.
 */
export function shouldContinueBatch(route: ApplicationRouteDecision): boolean {
  return (
    route === "skip_unsupported_ats" ||
    route === "inspect_only" ||
    route === "ready_for_fill_later" ||
    route === "needs_essay" ||
    route === "needs_review_unmapped"
  );
}

export function requiresHumanBeforeFill(route: ApplicationRouteDecision): boolean {
  return (
    route === "needs_login" ||
    route === "needs_human_captcha" ||
    route === "needs_account_creation" ||
    route === "needs_essay" ||
    route === "needs_review_unmapped" ||
    route === "skip_unsupported_ats"
  );
}
