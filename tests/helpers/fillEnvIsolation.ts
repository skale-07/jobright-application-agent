import { afterEach, beforeEach } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";

/** Env keys that affect form-fill / submit / feature gates. */
export const CONTROLLED_FILL_ENV_KEYS = [
  "FORM_FILL_ENABLED",
  "DRY_RUN",
  "SUBMIT_ENABLED",
  "SUBMIT_REQUIRES_LOCAL_CONFIRMATION",
  "MAX_UNATTENDED_SUBMISSIONS_PER_RUN",
  "MATERIALS_DOWNLOAD_ENABLED",
  "OUTLOOK_DRAFTS_ENABLED",
  "EMAIL_GENERATION_ENABLED",
  "AGENT_AUTHORING_ENABLED",
  "SCREENER_LLM_MATCH_ENABLED",
  "SCREENER_PREDICT_LLM_ENABLED",
  "SCREENER_PREDICT_FAST_FIRST",
  "ARTIFACT_AUTOPUSH_ENABLED",
  "ESSAY_DRAFT_ENABLED",
  "ESSAY_AUTOFILL_ENABLED",
  "AGENT_FALLBACK_ENABLED",
  "CDP_AUTOLAUNCH_ENABLED",
  "NAVIGATION_ENABLED",
  "GMAIL_VERIFICATION_ENABLED",
  "OUTLOOK_VERIFICATION_ENABLED",
  "ESSAY_REQUIRED_GATE_ENABLED",
  "AUTOMATION_ENABLED",
  // Standing portal creds: if these leak, isRecognizedAtsAuthHost treats
  // every https host as authorized (workday/vault tests then fail).
  "PORTAL_LOGIN_EMAIL",
  "PORTAL_LOGIN_PASSWORD",
] as const;

export type ControlledFillEnvKey = (typeof CONTROLLED_FILL_ENV_KEYS)[number];

export type ControlledFillEnv = Record<
  ControlledFillEnvKey,
  string | undefined
>;

export function snapshotControlledFillEnv(): ControlledFillEnv {
  return Object.fromEntries(
    CONTROLLED_FILL_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as ControlledFillEnv;
}

export function restoreControlledFillEnv(snapshot: ControlledFillEnv): void {
  for (const key of CONTROLLED_FILL_ENV_KEYS) {
    const original = snapshot[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  resetConfigCache();
}

export function applyControlledFillEnv(
  values: Partial<Record<ControlledFillEnvKey, string>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  resetConfigCache();
}

/** Fail-closed defaults for inspection / Phase 4. */
export function applySafeFillEnv(): void {
  // Ambient shell values for the wider gate set must not leak either;
  // deleting them falls back to each flag's fail-closed default.
  for (const key of CONTROLLED_FILL_ENV_KEYS) {
    delete process.env[key];
  }
  applyControlledFillEnv({
    FORM_FILL_ENABLED: "false",
    DRY_RUN: "true",
    SUBMIT_ENABLED: "false",
  });
}

/** Fixture-execute defaults for Phase 5 fill tests. SUBMIT stays off. */
export function applyFixtureFillEnv(): void {
  applyControlledFillEnv({
    FORM_FILL_ENABLED: "true",
    DRY_RUN: "false",
    SUBMIT_ENABLED: "false",
  });
}

/**
 * Registers beforeEach/afterEach so ambient shell env cannot leak into assertions.
 * Call once at the top of a describe block.
 *
 * Does not redirect PRIVATE_DIR — answer aliases and the public profile live
 * there, and inspection/fill tests need them. Tests that must not see the
 * operator's encrypted sensitive profile mock tryLoadSensitiveProfile
 * (see lever-fill / lever-adapter).
 */
export function useIsolatedFillEnv(
  mode: "safe" | "fixture_fill" = "safe",
): void {
  let original: ControlledFillEnv;

  beforeEach(() => {
    original = snapshotControlledFillEnv();
    if (mode === "safe") applySafeFillEnv();
    else applyFixtureFillEnv();
  });

  afterEach(() => {
    restoreControlledFillEnv(original);
  });
}
