/**
 * The flag-ceiling rule: capability comes ONLY from the operator's shell
 * that started the console. A gated flag reaches a child run iff the
 * shell had it enabled AND the UI opted in for that specific run — the
 * UI can narrow, never widen. Every gated key is explicitly set on the
 * child so its environment is fully determined, never ambient. Two keys
 * are always forced so a console-launched run can never take the
 * unattended submission branch.
 */

export const GATED_FLAG_KEYS = [
  "FORM_FILL_ENABLED",
  "SUBMIT_ENABLED",
  "MATERIALS_DOWNLOAD_ENABLED",
  "NAVIGATION_ENABLED",
  "GMAIL_VERIFICATION_ENABLED",
  "OUTLOOK_VERIFICATION_ENABLED",
  "AGENT_FALLBACK_ENABLED",
  "CDP_AUTOLAUNCH_ENABLED",
  "AGENT_AUTHORING_ENABLED",
  "SCREENER_LLM_MATCH_ENABLED",
  "SCREENER_PREDICT_LLM_ENABLED",
  "ARTIFACT_AUTOPUSH_ENABLED",
  "ESSAY_DRAFT_ENABLED",
  "ESSAY_AUTOFILL_ENABLED",
  "NATIVE_AUTOFILL_ENABLED",
  "JOBRIGHT_AUTOFILL_ENABLED",
  "OUTLOOK_DRAFTS_ENABLED",
  "EMAIL_GENERATION_ENABLED",
  "LINKEDIN_ENRICHMENT_ENABLED",
  "ESSAY_REQUIRED_GATE_ENABLED",
  "AUTOMATION_ENABLED",
] as const;

/**
 * The two submit-safety keys the console forces on every run. Exported so
 * the run API advertises exactly what composeChildEnv sets (single source,
 * no drift). For an unarmed run both are forced; an armed automation run
 * relaxes them (see composeChildEnv's `context.unattended`).
 */
export const FORCED_SUBMIT_SAFETY = {
  SUBMIT_REQUIRES_LOCAL_CONFIRMATION: "true",
  MAX_UNATTENDED_SUBMISSIONS_PER_RUN: "0",
} as const;

export type GatedFlagKey = (typeof GATED_FLAG_KEYS)[number];

export type FlagCeiling = {
  flags: Record<GatedFlagKey, boolean>;
  /** True only when the shell explicitly ran with DRY_RUN=false. */
  live_mode_available: boolean;
};

export type FlagOptIns = {
  flags?: Partial<Record<GatedFlagKey, boolean>>;
  live_mode?: boolean;
};

/** Same accepted truthy forms as src/config/env.ts boolFromEnv. */
function parseBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  const s = value.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export function readCeiling(env: NodeJS.ProcessEnv = process.env): FlagCeiling {
  const flags = Object.fromEntries(
    GATED_FLAG_KEYS.map((key) => [key, parseBool(env[key])]),
  ) as Record<GatedFlagKey, boolean>;
  // DRY_RUN defaults true; live mode exists only when the shell explicitly
  // set a falsy value ("false"/"0"/"no" — anything not truthy, but present).
  const dryRun = env["DRY_RUN"];
  return {
    flags,
    live_mode_available: dryRun !== undefined && !parseBool(dryRun),
  };
}

export type ComposeContext = {
  /**
   * Present ONLY for an armed automation run (set by RunManager after
   * re-validating the arm at spawn). Relaxes the two forced submit-safety
   * keys so the worker's submits take the unattended branch, bounded by
   * the arm row's budget. The env cap is belt-and-suspenders — the real
   * budget lives in the arm automation_runs row.
   */
  unattended?: { maxSubmits: number };
};

export function composeChildEnv(
  env: NodeJS.ProcessEnv,
  ceiling: FlagCeiling,
  optIns: FlagOptIns,
  context: ComposeContext = {},
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  for (const key of GATED_FLAG_KEYS) {
    child[key] =
      ceiling.flags[key] && optIns.flags?.[key] === true ? "true" : "false";
  }
  child["DRY_RUN"] =
    ceiling.live_mode_available && optIns.live_mode === true ? "false" : "true";
  if (context.unattended) {
    // Armed session: the worker's submits skip the confirmation and draw
    // from the (env-mirrored) budget. The arm row is the authority.
    child["SUBMIT_REQUIRES_LOCAL_CONFIRMATION"] = "false";
    child["MAX_UNATTENDED_SUBMISSIONS_PER_RUN"] = String(
      Math.max(0, Math.floor(context.unattended.maxSubmits)),
    );
  } else {
    // Every other run: the web-confirmation callback is the ONLY path to a
    // submit click; the unattended branch is structurally unreachable.
    child["SUBMIT_REQUIRES_LOCAL_CONFIRMATION"] =
      FORCED_SUBMIT_SAFETY.SUBMIT_REQUIRES_LOCAL_CONFIRMATION;
    child["MAX_UNATTENDED_SUBMISSIONS_PER_RUN"] =
      FORCED_SUBMIT_SAFETY.MAX_UNATTENDED_SUBMISSIONS_PER_RUN;
  }
  return child;
}

export function grantedAndDenied(
  ceiling: FlagCeiling,
  optIns: FlagOptIns,
): { granted: string[]; denied: string[] } {
  const granted: string[] = [];
  const denied: string[] = [];
  for (const [key, wanted] of Object.entries(optIns.flags ?? {})) {
    if (wanted !== true) continue;
    if (ceiling.flags[key as GatedFlagKey]) granted.push(key);
    else denied.push(key);
  }
  if (optIns.live_mode === true) {
    if (ceiling.live_mode_available) granted.push("LIVE_MODE");
    else denied.push("LIVE_MODE");
  }
  return { granted: granted.sort(), denied: denied.sort() };
}
