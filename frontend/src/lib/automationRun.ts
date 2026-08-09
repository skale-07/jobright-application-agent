/**
 * The one automation-run request body, shared by every "start a session"
 * button (Home hero, ArmCard). A single definition so a new capability
 * flag can never be opted into on one button and forgotten on another —
 * the live run that shipped without ESSAY_DRAFT_ENABLED came from exactly
 * that drift. The shell ceiling still decides what is actually granted.
 */
export const AUTOMATION_RUN_BODY = {
  kind: "automation",
  // Operator wants visible browsers for L3 inspection (captcha, walls).
  params: { headed: true },
  flags: {
    AUTOMATION_ENABLED: true,
    FORM_FILL_ENABLED: true,
    SUBMIT_ENABLED: true,
    NAVIGATION_ENABLED: true,
    NATIVE_AUTOFILL_ENABLED: true,
    MATERIALS_DOWNLOAD_ENABLED: true,
    GMAIL_VERIFICATION_ENABLED: true,
    // Navigation agent (phase C): without this opt-in the armed child gets
    // AGENT_FALLBACK_ENABLED=false and every nav wall dies as "budget".
    AGENT_FALLBACK_ENABLED: true,
    // Screener label→bank-key mapping assist (answers always come from the
    // operator's screeners.json; options must match deterministically).
    SCREENER_LLM_MATCH_ENABLED: true,
    // New-question answer predictions into review items (one-click promote
    // into the bank; predictions never fill without that approval).
    SCREENER_PREDICT_LLM_ENABLED: true,
    // Essay SUGGESTION drafts into review items after the session —
    // approval stays human; nothing is auto-filled.
    ESSAY_DRAFT_ENABLED: true,
    // Outreach tail (drafts only, never send) — granted only if the shell
    // ceiling carries these; otherwise the tail is simply skipped.
    EMAIL_GENERATION_ENABLED: true,
    OUTLOOK_DRAFTS_ENABLED: true,
  },
  live_mode: true,
};

export const ARM_DEFAULTS = {
  duration_minutes: 120,
  max_submits: 10,
  max_apps: 25,
};
