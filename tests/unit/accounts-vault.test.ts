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
