import { describe, expect, it } from "vitest";
import {
  assertFormFillAllowed,
  assertSubmitAllowed,
} from "../../src/applications/formFillGuards.js";
import { getConfig, resetConfigCache } from "../../src/config/index.js";
import { DOTENV_PATH } from "../../src/config/env.js";
import {
  applyFixtureFillEnv,
  applySafeFillEnv,
  snapshotControlledFillEnv,
  restoreControlledFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

describe("UNIT_CONFIRMED fill env isolation", () => {
  useIsolatedFillEnv("safe");

  it("loads flags from the repo-root .env path", () => {
    expect(DOTENV_PATH.replace(/\\/g, "/")).toMatch(/\/\.env$/);
  });

  it("safe defaults without relying on .env", () => {
    delete process.env.FORM_FILL_ENABLED;
    delete process.env.DRY_RUN;
    delete process.env.SUBMIT_ENABLED;
    resetConfigCache();

    // Schema defaults: formFill false, dryRun true, submit false
    // But useIsolatedFillEnv already forced safe — re-apply delete then safe
    applySafeFillEnv();
    const cfg = getConfig();
    expect(cfg.formFillEnabled).toBe(false);
    expect(cfg.submitEnabled).toBe(false);
    expect(() => assertFormFillAllowed("defaults")).toThrow(/FORM_FILL_ENABLED/);
    expect(() => assertSubmitAllowed("defaults")).toThrow(
      /FORM_FILL_ENABLED|SUBMIT_ENABLED/,
    );
  });

  it("config reset flips fill guard on and off", () => {
    applySafeFillEnv();
    expect(() => assertFormFillAllowed("off")).toThrow(/FORM_FILL_ENABLED/);

    applyFixtureFillEnv();
    expect(() => assertFormFillAllowed("on")).not.toThrow();
    expect(getConfig().submitEnabled).toBe(false);
    expect(() => assertSubmitAllowed("submit still off")).toThrow(
      /SUBMIT_ENABLED/,
    );

    applySafeFillEnv();
    expect(() => assertFormFillAllowed("off again")).toThrow(/FORM_FILL_ENABLED/);
  });

  it("hostile parent shell values are overridden by safe isolation", () => {
    const snap = snapshotControlledFillEnv();
    try {
      process.env.FORM_FILL_ENABLED = "true";
      process.env.DRY_RUN = "false";
      process.env.SUBMIT_ENABLED = "true";
      process.env.PORTAL_LOGIN_PASSWORD = "should-not-leak";
      resetConfigCache();
      // Without isolation, guards would allow fill — apply safe explicitly
      applySafeFillEnv();
      expect(getConfig().formFillEnabled).toBe(false);
      expect(getConfig().submitEnabled).toBe(false);
      expect(process.env.PORTAL_LOGIN_PASSWORD).toBeUndefined();
    expect(() => assertFormFillAllowed("hostile")).toThrow(/FORM_FILL_ENABLED/);
      expect(() => assertSubmitAllowed("hostile")).toThrow(
        /FORM_FILL_ENABLED|SUBMIT_ENABLED/,
      );
    } finally {
      restoreControlledFillEnv(snap);
    }
  });

  it("fill-enabled then fill-disabled order both hold", () => {
    applyFixtureFillEnv();
    expect(() => assertFormFillAllowed("a")).not.toThrow();
    applySafeFillEnv();
    expect(() => assertFormFillAllowed("b")).toThrow(/FORM_FILL_ENABLED/);
    applyFixtureFillEnv();
    expect(() => assertFormFillAllowed("c")).not.toThrow();
    applySafeFillEnv();
    expect(() => assertFormFillAllowed("d")).toThrow(/FORM_FILL_ENABLED/);
  });
});
