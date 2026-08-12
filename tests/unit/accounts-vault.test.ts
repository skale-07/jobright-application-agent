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
      email: "candidate@example.com",
      password: "operator-chosen-secret",
    });
    expect(replaced).toBe(false);
    expect(account.username).toBe("candidate@example.com");
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
      email: "candidate@example.com",
      runId: `nav-${randomUUID()}`,
    });
    expect(created).toBe(true);
    expect(account.username).toBe("candidate@example.com");

    const again = getOrCreateAccount("careers.example.com", {
      email: "other@example.com",
      runId: "nav-x",
    });
    expect(again.created).toBe(false);
    expect(again.account.password).toBe(account.password);
    expect(getAccount("careers.example.com")?.username).toBe(
      "candidate@example.com",
    );

    const files = fs.readdirSync(path.join(privateDir, "ats-accounts"));
    expect(files).toEqual([`${hostHash("careers.example.com")}.json`]);
  });
});
