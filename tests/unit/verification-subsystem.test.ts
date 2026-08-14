import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";
import { prepareCredentialsForHost } from "../../src/verification/accountCredentials.js";
import { resolveNavVerificationWaiter } from "../../src/verification/emailVerification.js";
import { getAccount } from "../../src/accounts/vault.js";

/**
 * The isolated verification subsystem — the account-creation +
 * email-verification core the user's Workday-style portals depend on.
 * Every trust rule is pinned here as a unit, independent of the nav
 * orchestrator: vault reuse/mint policy, jobright exclusion, provider
 * preference order, and Outlook's codes-only fallback. UNIT_CONFIRMED —
 * no test touches Gmail, Outlook, or a browser.
 */
describe("verification subsystem (UNIT_CONFIRMED)", () => {
  let privDir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "PRIVATE_DIR",
    "GMAIL_VERIFICATION_ENABLED",
    "OUTLOOK_VERIFICATION_ENABLED",
    "PORTAL_LOGIN_EMAIL",
    "PORTAL_LOGIN_PASSWORD",
  ];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    privDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-verif-"));
    process.env.PRIVATE_DIR = privDir;
    delete process.env.GMAIL_VERIFICATION_ENABLED;
    delete process.env.OUTLOOK_VERIFICATION_ENABLED;
    delete process.env.PORTAL_LOGIN_EMAIL;
    delete process.env.PORTAL_LOGIN_PASSWORD;
    resetConfigCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(privDir, { recursive: true, force: true });
    resetConfigCache();
  });

  describe("account credentials (vault policy)", () => {
    it("mints an account ONLY on a live login wall, persists it, and reuses it after", () => {
      const runId = `nav-${randomUUID()}`;
      // No wall: nothing is minted, ever.
      const noWall = prepareCredentialsForHost({
        host: "careers.workday-tenant.com",
        runId,
        loginWallDetected: false,
        emailOverride: "candidate@fixture.test",
      });
      expect(noWall.credentials.available).toBe(false);
      expect(getAccount("careers.workday-tenant.com")).toBeNull();

      // Wall: minted with the candidate email + generated password.
      const minted = prepareCredentialsForHost({
        host: "careers.workday-tenant.com",
        runId,
        loginWallDetected: true,
        emailOverride: "candidate@fixture.test",
      });
      expect(minted.credentials.available).toBe(true);
      if (minted.credentials.available) {
        expect(minted.credentials.username).toBe("candidate@fixture.test");
        expect(minted.credentials.password.length).toBeGreaterThanOrEqual(20);
        expect(minted.secrets).toContain(minted.credentials.password);
      }
      expect(minted.notes.join(" ")).toMatch(/created account/);

      // Reuse: same credentials come back even WITHOUT a wall (an existing
      // account is always offered), and no second account is minted.
      const reused = prepareCredentialsForHost({
        host: "careers.workday-tenant.com",
        runId: `nav-${randomUUID()}`,
        loginWallDetected: false,
        emailOverride: "other@example.com",
      });
      expect(reused.credentials).toEqual(minted.credentials);
      expect(reused.notes.join(" ")).toMatch(/existing account/);
    });

    it("never offers credentials for jobright.ai or a null host", () => {
      for (const host of [null, "jobright.ai", "app.jobright.ai"]) {
        const r = prepareCredentialsForHost({
          host,
          runId: "nav-x",
          loginWallDetected: true,
          emailOverride: "candidate@fixture.test",
        });
        expect(r.credentials.available).toBe(false);
        expect(r.secrets).toEqual([]);
      }
    });

    it("refuses to mint without a candidate email, with a named note", () => {
      const r = prepareCredentialsForHost({
        host: "portal.example.com",
        runId: "nav-x",
        loginWallDetected: true,
        emailOverride: "",
      });
      expect(r.credentials.available).toBe(false);
      expect(r.notes.join(" ")).toMatch(/no candidate email/);
      expect(getAccount("portal.example.com")).toBeNull();
    });
  });

  describe("email-verification provider order", () => {
    const NEED = {
      sent_to: "candidate@fixture.test",
      requested_at: new Date().toISOString(),
    };

    it("returns null when no provider is enabled — the caller walls to human review", () => {
      expect(resolveNavVerificationWaiter()).toBeNull();
    });

    it("gmail is preferred; outlook is never consulted when gmail delivers", async () => {
      let outlookCalls = 0;
      const waiter = resolveNavVerificationWaiter({
        gmailWaiter: async () => ({
          kind: "code",
          code: "123456",
          messageId: "m1",
          pollsUsed: 2,
        }),
        outlookFetch: async () => {
          outlookCalls++;
          return { kind: "code" as const, value: "999999", source: "outlook" };
        },
      })!;
      const r = await waiter(NEED, []);
      expect(r).toEqual({ kind: "code", code: "123456", messageId: "m1", pollsUsed: 2 });
      expect(outlookCalls).toBe(0);
    });

    it("falls back to outlook (codes only) when gmail times out", async () => {
      const waiter = resolveNavVerificationWaiter({
        gmailWaiter: async () => ({ kind: "timeout", pollsUsed: 10 }),
        outlookFetch: async () => ({ kind: "code" as const, value: "424242", source: "outlook" }),
      })!;
      const r = await waiter(NEED, ["example.com"]);
      expect(r.kind).toBe("code");
      if (r.kind === "code") {
        expect(r.code).toBe("424242");
        expect(r.messageId).toMatch(/^outlook:/);
        expect(r.pollsUsed).toBe(11); // gmail's 10 + one mailbox scan
      }
    });

    it("both providers dry ⇒ timeout with the combined poll count", async () => {
      const waiter = resolveNavVerificationWaiter({
        gmailWaiter: async () => ({ kind: "timeout", pollsUsed: 10 }),
        outlookFetch: async () => null,
      })!;
      const r = await waiter(NEED, []);
      expect(r).toEqual({ kind: "timeout", pollsUsed: 11 });
    });

    it("outlook-only shells still get a waiter (gmail token absent)", async () => {
      const waiter = resolveNavVerificationWaiter({
        outlookFetch: async () => ({ kind: "code" as const, value: "777777", source: "outlook" }),
      })!;
      const r = await waiter(NEED, []);
      expect(r.kind).toBe("code");
    });

    it("magic links pass through untouched from gmail (domain checks live in the gmail parser)", async () => {
      const waiter = resolveNavVerificationWaiter({
        gmailWaiter: async (_need, allowedDomains) => {
          expect(allowedDomains).toContain("portal.example.com");
          return {
            kind: "link",
            url: "https://portal.example.com/verify?t=abc",
            messageId: "m2",
            pollsUsed: 1,
          };
        },
        outlookFetch: async () => null,
      })!;
      const r = await waiter(NEED, ["portal.example.com"]);
      expect(r.kind).toBe("link");
    });
  });
});

describe("mailbox provider order (UNIT_CONFIRMED)", () => {
  it("an Outlook-family address scans OUTLOOK first", async () => {
    const { mailboxProviderOrder } = await import(
      "../../src/verification/emailVerification.js"
    );
    for (const email of [
      "me@outlook.com",
      "me@hotmail.com",
      "me@live.co.uk",
      "me@msn.com",
    ]) {
      expect(mailboxProviderOrder(email)[0], email).toBe("outlook");
    }
  });

  it("a Gmail address scans GMAIL first; unknown domains keep gmail-first", async () => {
    const { mailboxProviderOrder } = await import(
      "../../src/verification/emailVerification.js"
    );
    expect(mailboxProviderOrder("me@gmail.com")[0]).toBe("gmail");
    expect(mailboxProviderOrder("me@jh.edu")[0]).toBe("gmail");
    expect(mailboxProviderOrder(null)[0]).toBe("gmail");
    // Both providers always remain in the chain as the fallback.
    expect(mailboxProviderOrder("me@outlook.com")).toHaveLength(2);
  });
});

describe("mailbox order comes from the ENV address (UNIT_CONFIRMED)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    delete process.env.VERIFICATION_MAILBOX;
    delete process.env.PORTAL_LOGIN_EMAIL;
    delete process.env.GMAIL_VERIFICATION_ENABLED;
    delete process.env.OUTLOOK_VERIFICATION_ENABLED;
    process.env = { ...saved };
    resetConfigCache();
  });

  it("an explicit VERIFICATION_MAILBOX override always wins", async () => {
    const { mailboxProviderOrder } = await import(
      "../../src/verification/emailVerification.js"
    );
    // Even a gmail.com address defers to the explicit setting.
    expect(mailboxProviderOrder("me@gmail.com", { override: "outlook" })[0]).toBe(
      "outlook",
    );
    expect(mailboxProviderOrder("me@outlook.com", { override: "gmail" })[0]).toBe(
      "gmail",
    );
  });

  it("submit recovery opens the SAME inbox the env names, Outlook first", async () => {
    process.env.PORTAL_LOGIN_EMAIL = "me@outlook.com";
    process.env.GMAIL_VERIFICATION_ENABLED = "true";
    process.env.OUTLOOK_VERIFICATION_ENABLED = "true";
    resetConfigCache();
    const { mailboxProviderOrder } = await import(
      "../../src/verification/emailVerification.js"
    );
    const { getConfig } = await import("../../src/config/index.js");
    const cfg = getConfig();
    expect(mailboxProviderOrder(cfg.portalLoginEmail ?? null)[0]).toBe("outlook");
    // The chain builder is driven by that same order (both providers on).
    const { resolveVerificationCodeProvider } = await import(
      "../../src/verification/codeProviders.js"
    );
    expect(resolveVerificationCodeProvider()).not.toBeNull();
  });
});
