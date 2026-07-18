import { describe, expect, it } from "vitest";
import { redactObject, maskEmail, maskPhone } from "../../src/logging/redaction.js";
import { sanitizeHtml, sanitizeNetworkMetadata, sanitizeText } from "../../src/recorder/sanitize.js";
import { loadConfig, resetConfigCache } from "../../src/config/index.js";
import {
  createDraft,
  verifyDraft,
  assertDraftsOnlyMode,
  OutlookSendForbiddenError,
} from "../../src/outlook/sendGuards.js";
import { canTransition } from "../../src/queue/states.js";
import { writeJsonAtomic, readJsonFile } from "../../src/storage/atomicJson.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

describe("redaction", () => {
  it("redacts sensitive keys", () => {
    const out = redactObject({
      phone: "555-111-2222",
      action: "resume_ok",
      cookie: "abc",
    });
    expect(out["phone"]).toBe("[REDACTED]");
    expect(out["cookie"]).toBe("[REDACTED]");
    expect(out["action"]).toBe("resume_ok");
  });

  it("masks email and phone", () => {
    expect(maskEmail("jane@example.com")).toMatch(/^j\*\*\*@example.com$/);
    expect(maskPhone("+1 (555) 123-9876")).toContain("9876");
  });
});

describe("recorder sanitize", () => {
  it("strips emails tokens and scripts from html", () => {
    const html = `<div>Contact me@corp.com</div><script>window.token="secret"</script><input value="ssn">`;
    const out = sanitizeHtml(html);
    expect(out).not.toContain("me@corp.com");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain('value="[REDACTED]"');
  });

  it("redacts network auth headers", () => {
    const out = sanitizeNetworkMetadata([
      {
        url: "https://example.com",
        headers: { Authorization: "Bearer abc", Accept: "text/html" },
        body: "secret",
      },
    ]);
    expect(out[0]?.["headers"]).toMatchObject({
      Authorization: "[REDACTED]",
      Accept: "text/html",
    });
    expect(out[0]?.["body"]).toBe("[REDACTED]");
  });

  it("sanitizeText removes jwt-like strings", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature";
    expect(sanitizeText(`token ${jwt}`)).toContain("[REDACTED]");
  });
});

describe("config safety", () => {
  it("forces emailSendEnabled false and rejects send-enabled env flag", () => {
    const forbiddenSendFlag = ["EMAIL", "SEND", "ENABLED"].join("_");
    resetConfigCache();
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DASHBOARD_HOST: "127.0.0.1",
    };
    delete baseEnv[forbiddenSendFlag];
    const cfg = loadConfig(baseEnv);
    expect(cfg.emailSendEnabled).toBe(false);

    resetConfigCache();
    expect(() =>
      loadConfig({
        ...baseEnv,
        [forbiddenSendFlag]: "true",
      }),
    ).toThrow(/forbidden/);
  });

  it("rejects non-localhost dashboard host", () => {
    resetConfigCache();
    expect(() =>
      loadConfig({
        ...process.env,
        DASHBOARD_HOST: "0.0.0.0",
      }),
    ).toThrow(/DASHBOARD_HOST/);
  });
});

describe("outlook send guards", () => {
  it("draft helpers are stubs and drafts-only assert works", async () => {
    await expect(createDraft({})).rejects.toThrow(/Phase 12/);
    await expect(verifyDraft({})).rejects.toThrow(/Phase 12/);
    expect(() => assertDraftsOnlyMode(false)).toThrow(OutlookSendForbiddenError);
    expect(() => assertDraftsOnlyMode(true)).not.toThrow();
  });
});

describe("state helpers", () => {
  it("allows known transitions", () => {
    expect(canTransition("DISCOVERED", "DUPLICATE_CHECK")).toBe(true);
    expect(canTransition("READY_TO_SUBMIT", "SUBMITTING")).toBe(true);
    expect(canTransition("SUBMITTED", "DISCOVERED")).toBe(false);
  });
});

describe("atomic json", () => {
  it("writes and reads atomically", () => {
    const file = path.join(os.tmpdir(), `jaa-${randomUUID()}.json`);
    writeJsonAtomic(file, { ok: true });
    expect(readJsonFile<{ ok: boolean }>(file).ok).toBe(true);
    fs.unlinkSync(file);
  });
});
