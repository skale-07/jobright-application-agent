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

  /**
   * The lists banned API-shaped strings (`sendMail(`, `users.messages.send`)
   * and TS identifiers, but nothing named an integration layer's ACTION
   * SLUG. A line reading execute("GMAIL_SEND_EMAIL") passed check:forbidden
   * clean until 2026-08-12 — a send call containing none of the banned
   * shapes, shipped one identifier away from the draft action in the same
   * toolkit. Drafts-only has to be enforceable against that too.
   */
  it("bans mail-send tool slugs, not just API shapes and identifiers", async () => {
    const { FORBIDDEN_OUTLOOK_IDENTIFIERS } = await import(
      "../../src/outlook/sendGuards.js"
    );
    const { FORBIDDEN_GMAIL_IDENTIFIERS } = await import(
      "../../src/gmail/readonlyGuards.js"
    );
    const all: string[] = [
      ...FORBIDDEN_OUTLOOK_IDENTIFIERS,
      ...FORBIDDEN_GMAIL_IDENTIFIERS,
    ];
    for (const slug of [
      ["GMAIL", "SEND", "EMAIL"].join("_"),
      ["OUTLOOK", "SEND", "EMAIL"].join("_"),
      ["OUTLOOK", "REPLY", "EMAIL"].join("_"),
      ["OUTLOOK", "FORWARD", "EMAIL"].join("_"),
    ]) {
      expect(all).toContain(slug);
    }
    // The DRAFT actions stay legal — this is drafts-only, not mail-free.
    expect(all.join(" ")).not.toContain(
      ["OUTLOOK", "CREATE", "DRAFT"].join("_"),
    );
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
