import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractMagicLink,
  extractOtpCode,
  registrableDomain,
} from "../../src/gmail/verificationParsers.js";
import {
  GmailClient,
  extractBodyText,
  type FetchLike,
} from "../../src/gmail/client.js";
import {
  FORBIDDEN_GMAIL_IDENTIFIERS,
  GmailWriteForbiddenError,
} from "../../src/gmail/readonlyGuards.js";
import { waitForVerificationEmail } from "../../src/gmail/waitForVerification.js";
import {
  buildConsentUrl,
  extractCodeFromRedirect,
} from "../../src/gmail/authFlow.js";
import { getConfig, resetConfigCache } from "../../src/config/index.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "gmail");
const fixture = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, name), "utf8");

const TOKEN = {
  client_id: "id.apps.googleusercontent.com",
  client_secret: "secret-value",
  refresh_token: "refresh-value",
  account_email: "candidate@example.com",
  obtained_at: "2026-08-07T00:00:00Z",
};

function fakeFetch(
  handler: (url: string, init?: { body?: string }) => { status?: number; json: unknown },
): FetchLike {
  return async (url, init) => {
    const out = handler(String(url), init);
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.json,
    };
  };
}

describe("gmail verification parsers (N4, UNIT_CONFIRMED)", () => {
  it("extracts a keyword-adjacent OTP and ignores footer numbers", () => {
    expect(extractOtpCode("Your code", fixture("otp-code.txt"))).toBe("482193");
    expect(extractOtpCode("Big news!", fixture("marketing-decoy.txt"))).toBeNull();
  });

  it("extracts the sender-domain magic link, never the unsubscribe link", () => {
    const link = extractMagicLink(fixture("magic-link.txt"), {
      senderAddress: "no-reply@ashbyhq.com",
    });
    expect(link).toBe("https://jobs.ashbyhq.com/auth/verify?token=abc123def456");
    const none = extractMagicLink(fixture("marketing-decoy.txt"), {
      senderAddress: "news@example.org",
    });
    expect(none).toBeNull();
  });

  it("registrable domain folds subdomains", () => {
    expect(registrableDomain("jobs.ashbyhq.com")).toBe("ashbyhq.com");
    expect(registrableDomain("mail.eu.lever.co")).toBe("lever.co");
  });

  it("extractBodyText keeps anchor hrefs from html bodies", () => {
    const html = Buffer.from(
      '<html><body><p>Click <a href="https://jobs.ashbyhq.com/verify?t=1">here</a></p></body></html>',
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const text = extractBodyText({
      mimeType: "text/html",
      body: { data: html },
    });
    expect(text).toContain("https://jobs.ashbyhq.com/verify?t=1");
  });
});

describe("gmail readonly guards (N4, UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("bans send/modify/compose identifiers", () => {
    expect(FORBIDDEN_GMAIL_IDENTIFIERS.length).toBeGreaterThanOrEqual(5);
    expect(FORBIDDEN_GMAIL_IDENTIFIERS).toContain(
      ["users", "messages", "send"].join("."),
    );
  });

  it("loadConfig rejects the assembled send flag", () => {
    const key = ["GMAIL", "SEND", "ENABLED"].join("_");
    process.env[key] = "true";
    resetConfigCache();
    try {
      expect(() => getConfig()).toThrow(/readonly verification only/);
    } finally {
      delete process.env[key];
      resetConfigCache();
    }
  });
});

describe("gmail client (N4, UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("refuses construction while GMAIL_VERIFICATION_ENABLED=false", () => {
    applySafeFillEnv();
    expect(() => new GmailClient({ token: TOKEN })).toThrow(
      /GMAIL_VERIFICATION_ENABLED=false/,
    );
  });

  it("refreshes, asserts readonly scope, and searches", async () => {
    applyControlledFillEnv({ GMAIL_VERIFICATION_ENABLED: "true" });
    try {
      const calls: string[] = [];
      const client = new GmailClient({
        token: TOKEN,
        fetchImpl: fakeFetch((url) => {
          calls.push(url);
          if (url.includes("oauth2.googleapis.com")) {
            return {
              json: {
                access_token: "at-1",
                scope: "https://www.googleapis.com/auth/gmail.readonly",
              },
            };
          }
          return { json: { messages: [{ id: "m1" }, { id: "m2" }] } };
        }),
      });
      const messages = await client.searchMessages("after:0");
      expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(calls[0]).toContain("oauth2.googleapis.com");
    } finally {
      applySafeFillEnv();
    }
  });

  it("refuses a token that carries non-readonly scopes", async () => {
    applyControlledFillEnv({ GMAIL_VERIFICATION_ENABLED: "true" });
    try {
      const client = new GmailClient({
        token: TOKEN,
        fetchImpl: fakeFetch(() => ({
          json: {
            access_token: "at-1",
            scope:
              "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.mod" +
              "ify",
          },
        })),
      });
      await expect(client.searchMessages("after:0")).rejects.toThrow(
        GmailWriteForbiddenError,
      );
    } finally {
      applySafeFillEnv();
    }
  });

  it("waitForVerificationEmail finds a code within the poll cap and times out honestly", async () => {
    applyControlledFillEnv({ GMAIL_VERIFICATION_ENABLED: "true" });
    try {
      let searches = 0;
      const client = new GmailClient({
        token: TOKEN,
        fetchImpl: fakeFetch((url) => {
          if (url.includes("oauth2.googleapis.com")) {
            return { json: { access_token: "at", scope: "" } };
          }
          if (url.includes("/messages/")) {
            return {
              json: {
                id: "msg-9",
                internalDate: "1700000000000",
                payload: {
                  mimeType: "text/plain",
                  headers: [
                    { name: "Subject", value: "Your verification code" },
                    { name: "From", value: "Ashby <no-reply@ashbyhq.com>" },
                  ],
                  body: {
                    data: Buffer.from(fixture("otp-code.txt"))
                      .toString("base64")
                      .replace(/\+/g, "-")
                      .replace(/\//g, "_"),
                  },
                },
              },
            };
          }
          searches++;
          // First poll: nothing; second poll: one hit.
          return { json: searches < 2 ? {} : { messages: [{ id: "msg-9" }] } };
        }),
      });
      const need = {
        sent_to: "candidate@example.com",
        requested_at: "2026-08-07T00:00:00Z",
      };
      const result = await waitForVerificationEmail({
        client,
        need,
        sleep: async () => {},
      });
      expect(result).toMatchObject({ kind: "code", code: "482193", pollsUsed: 2 });

      // Timeout path: fresh client that never finds anything.
      let polls = 0;
      const dryClient = new GmailClient({
        token: TOKEN,
        fetchImpl: fakeFetch((url) => {
          if (url.includes("oauth2.googleapis.com")) {
            return { json: { access_token: "at", scope: "" } };
          }
          polls++;
          return { json: {} };
        }),
      });
      const timeout = await waitForVerificationEmail({
        client: dryClient,
        need,
        polls: 3,
        sleep: async () => {},
      });
      expect(timeout).toEqual({ kind: "timeout", pollsUsed: 3 });
      expect(polls).toBe(3);
    } finally {
      applySafeFillEnv();
    }
  });
});

describe("gmail auth flow helpers (N4, UNIT_CONFIRMED)", () => {
  it("consent URL pins the readonly scope; redirect parsing extracts the code", () => {
    const url = new URL(buildConsentUrl("client-1"));
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    expect(
      extractCodeFromRedirect("http://localhost:8791/cb?code=4%2FabcDEF&scope=x"),
    ).toBe("4/abcDEF");
    expect(() => extractCodeFromRedirect("http://localhost:8791/cb?error=denied")).toThrow(
      /no \?code=/,
    );
  });
});
