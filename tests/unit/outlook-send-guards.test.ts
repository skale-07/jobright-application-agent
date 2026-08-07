import { describe, expect, it } from "vitest";
import {
  assertDraftsOnlyMode,
  FORBIDDEN_OUTLOOK_IDENTIFIERS,
  OutlookSendForbiddenError,
} from "../../src/outlook/sendGuards.js";
import { loadConfig } from "../../src/config/index.js";

/**
 * This file is referenced by the check-forbidden allowlist: it is the one
 * test allowed to spell out the banned identifiers it asserts against.
 */
describe("outlook send guards (UNIT_CONFIRMED)", () => {
  it("drafts-only assert throws when the flag is off", () => {
    expect(() => assertDraftsOnlyMode(false)).toThrow(OutlookSendForbiddenError);
    expect(() => assertDraftsOnlyMode(true)).not.toThrow();
  });

  it("the banned identifier list is intact", () => {
    const banned = [...FORBIDDEN_OUTLOOK_IDENTIFIERS];
    expect(banned).toContain(["EMAIL", "SEND", "ENABLED"].join("_"));
    expect(banned).toContain("sendMail(");
    expect(banned.some((b) => b.includes("sendEmail"))).toBe(true);
    expect(banned.length).toBeGreaterThanOrEqual(7);
  });

  it("config hard-rejects the banned env flag", () => {
    const flag = ["EMAIL", "SEND", "ENABLED"].join("_");
    expect(() =>
      loadConfig({ ...process.env, [flag]: "true" }),
    ).toThrow(/forbidden/i);
  });

  it("draft modules export no send-shaped functions", async () => {
    const draftRun = await import("../../src/outlook/draftRun.js");
    const composer = await import("../../src/outlook/draftComposer.js");
    for (const mod of [draftRun, composer]) {
      for (const key of Object.keys(mod)) {
        expect(key.toLowerCase()).not.toMatch(/send/);
      }
    }
  });
});
