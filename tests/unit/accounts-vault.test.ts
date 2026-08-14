import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generatePassword,
  getAccount,
  getOrCreateAccount,
  hostHash,
  listAccountHosts,
  setAccount,
} from "../../src/accounts/vault.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

describe("ATS account vault (N5, UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  let privateDir = "";

  beforeEach(() => {
    applySafeFillEnv();
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-vault-"));
    process.env.PRIVATE_DIR = privateDir;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.PRIVATE_DIR;
    resetConfigCache();
    fs.rmSync(privateDir, { recursive: true, force: true });
  });

  // Operator-supplied logins (accounts:set): the answer to "how do I give
  // Dispatch my ByteDance careers password?" — and, on a non-Workday host,
  // the ONLY thing that authorizes portal auth to sign in there.
  it("setAccount stores an operator login and authorizes that host for portal auth", async () => {
    const { isRecognizedAtsAuthHost } = await import(
      "../../src/verification/portalAuth.js"
    );
    expect(isRecognizedAtsAuthHost("https://jobs.bytedance.com/x")).toBe(false);
    const { account, replaced } = setAccount("jobs.bytedance.com", {
      email: "candidate@fixture.test",
      password: "operator-chosen-secret",
    });
    expect(replaced).toBe(false);
    expect(account.username).toBe("candidate@fixture.test");
    expect(account.password).toBe("operator-chosen-secret");
    expect(isRecognizedAtsAuthHost("https://jobs.bytedance.com/x")).toBe(true);
    // jobright is never vault-authorized, whatever is stored.
    expect(isRecognizedAtsAuthHost("https://jobright.ai/jobs/recommend")).toBe(false);

    // Re-setting only the email keeps the existing password.
    const again = setAccount("jobs.bytedance.com", { email: "new@example.com" });
    expect(again.replaced).toBe(true);
    expect(again.account.password).toBe("operator-chosen-secret");
    expect(again.account.username).toBe("new@example.com");

    // Listing never exposes passwords.
    const listed = listAccountHosts();
    expect(listed).toEqual([
      { host: "jobs.bytedance.com", username: "new@example.com" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("operator-chosen-secret");
  });

  // Operator directive 2026-08-12: ONE email + password for every portal,
  // set in .env — signing in must never be a per-site chore.
  it("standing PORTAL_LOGIN_* credentials serve every https employer host", async () => {
    process.env.PORTAL_LOGIN_EMAIL = "standing@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "one-password-everywhere";
    resetConfigCache();
    try {
      const { isRecognizedAtsAuthHost } = await import(
        "../../src/verification/portalAuth.js"
      );
      const { prepareCredentialsForHost } = await import(
        "../../src/verification/accountCredentials.js"
      );
      // Any employer host qualifies now — no per-host setup at all.
      for (const url of [
        "https://jobs.bytedance.com/apply",
        "https://careers.brand-new-employer.com/login",
        "https://acme.wd5.myworkdayjobs.com/x",
      ]) {
        expect(isRecognizedAtsAuthHost(url), url).toBe(true);
      }
      // ...but never jobright, and never plain http.
      expect(isRecognizedAtsAuthHost("https://jobright.ai/jobs/recommend")).toBe(false);
      expect(isRecognizedAtsAuthHost("http://careers.example.com/login")).toBe(false);

      const r = prepareCredentialsForHost({
        host: "careers.brand-new-employer.com",
        runId: "t",
        loginWallDetected: true,
      });
      expect(r.credentials).toMatchObject({
        available: true,
        username: "standing@fixture.test",
        password: "one-password-everywhere",
      });
      expect(r.notes.join(" ")).toMatch(/standing portal login used/);
      // The password is offered for scrubbing and never sits in notes.
      expect(r.secrets).toContain("one-password-everywhere");
      expect(r.notes.join(" ")).not.toContain("one-password-everywhere");
    } finally {
      delete process.env.PORTAL_LOGIN_EMAIL;
      delete process.env.PORTAL_LOGIN_PASSWORD;
      resetConfigCache();
    }
  });

  it("a site-forced per-host password still overrides the standing one", async () => {
    setAccount("portal.forced.com", {
      email: "standing@fixture.test",
      password: "site-forced-rotation",
    });
    process.env.PORTAL_LOGIN_EMAIL = "standing@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "one-password-everywhere";
    resetConfigCache();
    try {
      const { prepareCredentialsForHost } = await import(
        "../../src/verification/accountCredentials.js"
      );
      const r = prepareCredentialsForHost({
        host: "portal.forced.com",
        runId: "t",
        loginWallDetected: true,
      });
      expect(r.credentials).toMatchObject({ password: "site-forced-rotation" });
      expect(r.notes.join(" ")).toMatch(/per-host password/);
    } finally {
      delete process.env.PORTAL_LOGIN_EMAIL;
      delete process.env.PORTAL_LOGIN_PASSWORD;
      resetConfigCache();
    }
  });

  /**
   * Live 2026-08-14: a REAL Workday account was minted with
   * candidate@example.com (the example-profile placeholder) and its
   * verification code went to a mailbox nobody owns — the application
   * wedged permanently. Placeholder addresses must refuse LOUDLY, naming
   * the fix, on both the standing-login and account-minting paths.
   */
  it("refuses placeholder emails on every credential path, loudly", async () => {
    process.env.PORTAL_LOGIN_EMAIL = "candidate@example.com";
    process.env.PORTAL_LOGIN_PASSWORD = "one-password-everywhere";
    resetConfigCache();
    try {
      const { prepareCredentialsForHost, isPlaceholderEmail } = await import(
        "../../src/verification/accountCredentials.js"
      );
      // The detector: unroutable placeholders yes, real-looking mail no.
      for (const bad of [
        "candidate@example.com",
        "someone@example.org",
        "x@invalid",
        "your.email@gmail.com",
        "a@email.com",
      ]) {
        expect(isPlaceholderEmail(bad), bad).toBe(true);
      }
      for (const ok of [
        "sk.mdia.pts@gmail.com",
        "jane.doe@outlook.com",
        "candidate@fixture.test",
      ]) {
        expect(isPlaceholderEmail(ok), ok).toBe(false);
      }

      // Standing path: password set, email is the placeholder — refused
      // with the fix named, and no account is minted downstream either.
      const standing = prepareCredentialsForHost({
        host: "careers.brand-new-employer.com",
        runId: "t",
        loginWallDetected: true,
      });
      expect(standing.credentials.available).toBe(false);
      expect(standing.notes.join(" ")).toMatch(/placeholder/);
      expect(standing.notes.join(" ")).toMatch(/PORTAL_LOGIN_EMAIL/);

      // Minting path: same refusal via emailOverride.
      delete process.env.PORTAL_LOGIN_PASSWORD;
      resetConfigCache();
      const minted = prepareCredentialsForHost({
        host: "careers.brand-new-employer.com",
        runId: "t",
        loginWallDetected: true,
        emailOverride: "candidate@example.com",
      });
      expect(minted.credentials.available).toBe(false);
      expect(minted.notes.join(" ")).toMatch(/mailbox nobody owns/);
    } finally {
      delete process.env.PORTAL_LOGIN_EMAIL;
      delete process.env.PORTAL_LOGIN_PASSWORD;
      resetConfigCache();
    }
  });

  it("without standing credentials, unknown hosts stay refused (fail-closed)", async () => {
    const { isRecognizedAtsAuthHost } = await import(
      "../../src/verification/portalAuth.js"
    );
    expect(isRecognizedAtsAuthHost("https://careers.unknown-employer.com/login")).toBe(
      false,
    );
  });

  it("setAccount without a password mints a strong one", () => {
    const { account } = setAccount("careers.acme.com", { email: "c@x.com" });
    expect(account.password).toHaveLength(20);
  });

  it("hostHash is stable, case-insensitive, and leaks nothing", () => {
    expect(hostHash("Careers.Example.com")).toBe(hostHash("careers.example.com"));
    expect(hostHash("careers.example.com")).toMatch(/^[0-9a-f]{16}$/);
    expect(hostHash("careers.example.com")).not.toContain("example");
  });

  it("generatePassword guarantees length and character classes", () => {
    for (let i = 0; i < 25; i++) {
      const pw = generatePassword();
      expect(pw).toHaveLength(20);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*\-_+=]/);
    }
    expect(generatePassword()).not.toBe(generatePassword());
  });

  it("creates once, reuses thereafter, stored under private/ats-accounts", () => {
    const { account, created } = getOrCreateAccount("careers.example.com", {
      email: "candidate@fixture.test",
      runId: `nav-${randomUUID()}`,
    });
    expect(created).toBe(true);
    expect(account.username).toBe("candidate@fixture.test");

    const again = getOrCreateAccount("careers.example.com", {
      email: "other@example.com",
      runId: "nav-x",
    });
    expect(again.created).toBe(false);
    expect(again.account.password).toBe(account.password);
    expect(getAccount("careers.example.com")?.username).toBe(
      "candidate@fixture.test",
    );

    const files = fs.readdirSync(path.join(privateDir, "ats-accounts"));
    expect(files).toEqual([`${hostHash("careers.example.com")}.json`]);
  });
});
