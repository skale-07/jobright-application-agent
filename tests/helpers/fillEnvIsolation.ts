import { afterEach, beforeEach } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";

/** Env keys that affect form-fill / submit guards. */
export const CONTROLLED_FILL_ENV_KEYS = [
  "FORM_FILL_ENABLED",
  "DRY_RUN",
  "SUBMIT_ENABLED",
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

export function applyControlledFillEnv(values: {
  FORM_FILL_ENABLED: string;
  DRY_RUN: string;
  SUBMIT_ENABLED: string;
}): void {
  process.env.FORM_FILL_ENABLED = values.FORM_FILL_ENABLED;
  process.env.DRY_RUN = values.DRY_RUN;
  process.env.SUBMIT_ENABLED = values.SUBMIT_ENABLED;
  resetConfigCache();
}

/** Fail-closed defaults for inspection / Phase 4. */
export function applySafeFillEnv(): void {
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
