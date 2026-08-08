import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GmailAuthBroker } from "../../src/console/gmailAuthBroker.js";
import { GMAIL_READONLY_SCOPE } from "../../src/gmail/readonlyGuards.js";
import { readGmailToken } from "../../src/gmail/tokenStore.js";
import type { FetchLike } from "../../src/gmail/client.js";
import { resetConfigCache } from "../../src/config/index.js";

function fakeFetch(json: unknown, status = 200): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  });
}

describe("gmail auth broker (UNIT_CONFIRMED)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-gmail-broker-"));
    process.env.PRIVATE_DIR = tmpDir;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.PRIVATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it("start returns the readonly consent URL and parks on awaiting_redirect_url", () => {
    const broker = new GmailAuthBroker({ fetchImpl: fakeFetch({}) });
    expect(broker.status()).toBe("idle");
    const { consentUrl } = broker.start({
      email: "candidate@example.com",
      clientId: "client-1",
      clientSecret: "secret-1",
    });
    const url = new URL(consentUrl);
    expect(url.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(broker.status()).toBe("awaiting_redirect_url");
  });

  it("only one flow at a time", () => {
    const broker = new GmailAuthBroker({ fetchImpl: fakeFetch({}) });
    broker.start({ email: "a@example.com", clientId: "c", clientSecret: "s" });
    expect(() =>
      broker.start({ email: "b@example.com", clientId: "c", clientSecret: "s" }),
    ).toThrow(/already awaiting_redirect_url/);
  });

  it("the pasted redirect URL completes the exchange and stores a readonly token", async () => {
    const broker = new GmailAuthBroker({
      fetchImpl: fakeFetch({
        refresh_token: "rt-1",
        scope: GMAIL_READONLY_SCOPE,
      }),
    });
    broker.start({
      email: "candidate@example.com",
      clientId: "client-1",
      clientSecret: "secret-1",
    });
    const tokenPath = await broker.submitRedirectUrl(
      "http://localhost:8791/cb?code=4%2FabcDEF",
    );
    expect(fs.existsSync(tokenPath)).toBe(true);
    const stored = readGmailToken();
    expect(stored?.scope).toBe(GMAIL_READONLY_SCOPE);
    expect(stored?.account_email).toBe("candidate@example.com");
    // Back to idle, so a second flow may start.
    expect(broker.status()).toBe("idle");
  });

  it("a widened grant is refused and nothing is stored", async () => {
    const broker = new GmailAuthBroker({
      fetchImpl: fakeFetch({
        refresh_token: "rt-1",
        scope: `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.mod` + "ify",
      }),
    });
    broker.start({ email: "a@example.com", clientId: "c", clientSecret: "s" });
    await expect(
      broker.submitRedirectUrl("http://localhost:8791/cb?code=x"),
    ).rejects.toThrow(/exceed readonly/);
    expect(readGmailToken()).toBeNull();
    expect(broker.status()).toBe("idle");
  });

  it("submitting with no flow in progress is an error", async () => {
    const broker = new GmailAuthBroker({ fetchImpl: fakeFetch({}) });
    await expect(
      broker.submitRedirectUrl("http://localhost:8791/cb?code=x"),
    ).rejects.toThrow(/no Gmail auth flow/);
  });

  it("the flow times out waiting for the paste and resets to idle", async () => {
    const broker = new GmailAuthBroker({
      fetchImpl: fakeFetch({}),
      timeoutMs: 50,
    });
    broker.start({ email: "a@example.com", clientId: "c", clientSecret: "s" });
    await new Promise((r) => setTimeout(r, 150));
    expect(broker.status()).toBe("idle");
    expect(readGmailToken()).toBeNull();
  });
});
