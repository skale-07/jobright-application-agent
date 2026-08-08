import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GATED_FLAG_KEYS,
  composeChildEnv,
  grantedAndDenied,
  readCeiling,
} from "../../src/console/flagCeiling.js";

/** Snapshot the gated keys + DRY_RUN so ambient shell values can't leak. */
const ALL_KEYS = [...GATED_FLAG_KEYS, "DRY_RUN"] as const;

describe("flag ceiling (UNIT_CONFIRMED)", () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = Object.fromEntries(ALL_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ALL_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ALL_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it("ceiling reflects the shell env; live mode needs an explicit DRY_RUN=false", () => {
    let ceiling = readCeiling({});
    expect(Object.values(ceiling.flags).every((v) => v === false)).toBe(true);
    expect(ceiling.live_mode_available).toBe(false);

    ceiling = readCeiling({ FORM_FILL_ENABLED: "true", NAVIGATION_ENABLED: "yes" });
    expect(ceiling.flags.FORM_FILL_ENABLED).toBe(true);
    expect(ceiling.flags.NAVIGATION_ENABLED).toBe(true);
    expect(ceiling.flags.SUBMIT_ENABLED).toBe(false);
    // DRY_RUN absent → defaults true → no live mode.
    expect(ceiling.live_mode_available).toBe(false);

    expect(readCeiling({ DRY_RUN: "false" }).live_mode_available).toBe(true);
    expect(readCeiling({ DRY_RUN: "true" }).live_mode_available).toBe(false);
  });

  it("composeChildEnv: flag reaches the child only when ceiling AND opt-in agree", () => {
    const shell = {
      PATH: "/usr/bin",
      FORM_FILL_ENABLED: "true",
      SUBMIT_ENABLED: "true",
      DRY_RUN: "false",
    };
    const ceiling = readCeiling(shell);

    // Opt into FORM_FILL only — SUBMIT stays false despite the shell having it.
    const child = composeChildEnv(shell, ceiling, {
      flags: { FORM_FILL_ENABLED: true },
      live_mode: true,
    });
    expect(child["FORM_FILL_ENABLED"]).toBe("true");
    expect(child["SUBMIT_ENABLED"]).toBe("false");
    expect(child["DRY_RUN"]).toBe("false");
    expect(child["PATH"]).toBe("/usr/bin"); // non-gated env passes through

    // Opt-in WITHOUT ceiling → still false (the UI can never widen).
    const denied = composeChildEnv({}, readCeiling({}), {
      flags: { SUBMIT_ENABLED: true, NAVIGATION_ENABLED: true },
      live_mode: true,
    });
    expect(denied["SUBMIT_ENABLED"]).toBe("false");
    expect(denied["NAVIGATION_ENABLED"]).toBe("false");
    expect(denied["DRY_RUN"]).toBe("true"); // no live mode without shell DRY_RUN=false

    // Ceiling without opt-in → false (per-run explicitness).
    const noOptIn = composeChildEnv(shell, ceiling, {});
    expect(noOptIn["FORM_FILL_ENABLED"]).toBe("false");
    expect(noOptIn["DRY_RUN"]).toBe("true");
  });

  it("every gated key is explicitly set and the unattended branch is force-closed", () => {
    const shell = { MAX_UNATTENDED_SUBMISSIONS_PER_RUN: "5", SUBMIT_REQUIRES_LOCAL_CONFIRMATION: "false" };
    const child = composeChildEnv(shell, readCeiling(shell), {});
    for (const key of GATED_FLAG_KEYS) {
      expect(child[key], key).toMatch(/^(true|false)$/);
    }
    // Forced regardless of the shell: console children can never submit
    // unattended — the web confirmation is the only path to a click.
    expect(child["SUBMIT_REQUIRES_LOCAL_CONFIRMATION"]).toBe("true");
    expect(child["MAX_UNATTENDED_SUBMISSIONS_PER_RUN"]).toBe("0");
  });

  it("grantedAndDenied reports exactly what the run got", () => {
    const ceiling = readCeiling({ FORM_FILL_ENABLED: "true", DRY_RUN: "false" });
    const { granted, denied } = grantedAndDenied(ceiling, {
      flags: { FORM_FILL_ENABLED: true, SUBMIT_ENABLED: true },
      live_mode: true,
    });
    expect(granted).toEqual(["FORM_FILL_ENABLED", "LIVE_MODE"]);
    expect(denied).toEqual(["SUBMIT_ENABLED"]);
  });
});
