import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";
import { readCodeFromGmailInboxPage } from "../../src/verification/gmailWebProvider.js";
import { chainVerificationCodeProviders } from "../../src/verification/codeProviders.js";
import {
  emailVerificationAvailable,
  resolveNavVerificationWaiter,
} from "../../src/verification/emailVerification.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";

/**
 * Gmail verification WITHOUT the API: the operator's Gmail REST access is
 * unavailable (unverified OAuth scope), so codes come from a Playwright
 * scan of the rendered mailbox. The scan logic is proven against a
 * Gmail-shaped fixture DOM (FIXTURE_CONFIRMED); provider chaining and
 * availability are UNIT_CONFIRMED. No test touches a real mailbox.
 */
describe("gmail web verification", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["GMAIL_VERIFICATION_ENABLED", "OUTLOOK_VERIFICATION_ENABLED"];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    resetConfigCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfigCache();
  });

  it(
    "scans a Gmail-shaped inbox, skips decoys and stale rows, extracts the code (FIXTURE_CONFIRMED)",
    async () => {
      const inbox = `<html><body><div role="main"><table>
        <tr class="zA"><td>Weekly digest — top jobs for you, act now!</td></tr>
        <tr class="zA"><td>Acme Careers — Your verification code</td></tr>
      </table>
      <div class="a3s">Hello, your verification code is 573018. It expires in 10 minutes.</div>
      </div></body></html>`;
      await withFixtureHtmlPage(inbox, async (page) => {
        expect(
          await readCodeFromGmailInboxPage(page, {
            requestedAt: new Date().toISOString(),
          }),
        ).toBe("573018");
      });

      // A code that predates the request is stale — never reused.
      const stale = `<html><body><div role="main"><table>
        <tr class="zA"><td><span title="2020-01-01T00:00:00Z">Jan 1</span> Acme Careers — Your verification code</td></tr>
      </table>
      <div class="a3s">Your verification code is 999111.</div>
      </div></body></html>`;
      await withFixtureHtmlPage(stale, async (page) => {
        expect(
          await readCodeFromGmailInboxPage(page, {
            requestedAt: new Date().toISOString(),
          }),
        ).toBeNull();
      });

      const noCode = `<html><body><div role="main"><table>
        <tr class="zA"><td>Marketing blast — 250000 users joined</td></tr>
      </table><div class="a3s">Copy only.</div></div></body></html>`;
      await withFixtureHtmlPage(noCode, async (page) => {
        expect(
          await readCodeFromGmailInboxPage(page, {
            requestedAt: new Date().toISOString(),
          }),
        ).toBeNull();
      });
    },
    45_000,
  );

  it(
    "picks the LAST message in a Gmail verification thread (FIXTURE_CONFIRMED)",
    async () => {
      const now = new Date().toISOString();
      // Live 2026-08-16: inbox still had 389820 (previous sandbox run);
      // 392556 had just been mailed. First-match + `.last()` title (a
      // "Starred" tooltip, not a datetime) treated the old row as fresh.
      // One Gmail conversation, oldest message first — the live shape.
      const inbox = `<html><body><div role="main"><table>
        <tr class="zA"><td>
          <span title="${now}">now</span>
          <span title="Starred">star</span>
          Frobnicator — Your verification code
        </td></tr>
      </table>
      <div class="a3s">Thanks for creating your account (skale072007@gmail.com). Your verification code is: 389820.</div>
      <div class="a3s">Your verification code is: 392556.</div>
      <div class="a3s">Your verification code is: 560516.</div>
      </div></body></html>`;
      await withFixtureHtmlPage(inbox, async (page) => {
        expect(
          await readCodeFromGmailInboxPage(page, { requestedAt: now }),
        ).toBe("560516");
      });

      const undated = `<html><body><div role="main"><table>
        <tr class="zA"><td>Acme Careers — Your verification code is 389820</td></tr>
      </table></div></body></html>`;
      const { scanGmailInboxForVerification } = await import(
        "../../src/verification/gmailWebProvider.js"
      );
      await withFixtureHtmlPage(undated, async (page) => {
        expect(
          await scanGmailInboxForVerification(page, {
            requestedAt: now,
            requireProvenFresh: true,
          }),
        ).toBeNull();
      });
    },
    45_000,
  );

  it("provider chain: first code wins, later fetchers never run; all-dry is null (UNIT_CONFIRMED)", async () => {
    const calls: string[] = [];
    const chain = chainVerificationCodeProviders([
      async () => {
        calls.push("a");
        return null;
      },
      async () => {
        calls.push("b");
        return { code: "111222", source: "b" };
      },
      async () => {
        calls.push("c");
        return { code: "333444", source: "c" };
      },
    ]);
    const r = await chain({ requestedAt: new Date().toISOString(), emailHint: null });
    expect(r).toEqual({ code: "111222", source: "b" });
    expect(calls).toEqual(["a", "b"]);

    const dry = chainVerificationCodeProviders([async () => null]);
    expect(
      await dry({ requestedAt: new Date().toISOString(), emailHint: null }),
    ).toBeNull();
  });

  it("availability needs only a flag — no API token required (UNIT_CONFIRMED)", () => {
    expect(emailVerificationAvailable()).toBe(false);
    process.env.GMAIL_VERIFICATION_ENABLED = "true";
    resetConfigCache();
    expect(emailVerificationAvailable()).toBe(true);
  });

  it("nav waiter consults gmail-web BEFORE outlook when REST times out (UNIT_CONFIRMED)", async () => {
    const order: string[] = [];
    const waiter = resolveNavVerificationWaiter({
      gmailWaiter: async () => ({ kind: "timeout", pollsUsed: 10 }),
      gmailWebFetch: async () => {
        order.push("gmail-web");
        return { kind: "code" as const, value: "808080", source: "gmail-web" };
      },
      outlookFetch: async () => {
        order.push("outlook");
        return { kind: "code" as const, value: "909090", source: "outlook" };
      },
    })!;
    const r = await waiter(
      { sent_to: "candidate@example.com", requested_at: new Date().toISOString() },
      [],
    );
    expect(r.kind).toBe("code");
    if (r.kind === "code") {
      expect(r.code).toBe("808080");
      expect(r.messageId).toMatch(/^gmail-web:/);
    }
    expect(order).toEqual(["gmail-web"]);
  });

  it(
    "scan returns the MAGIC LINK when a fresh verification mail has no code (FIXTURE_CONFIRMED)",
    async () => {
      const { scanGmailInboxForVerification } = await import(
        "../../src/verification/gmailWebProvider.js"
      );
      const inbox = `<html><body><div role="main"><table>
        <tr class="zA"><td>Acme Careers — Confirm your email</td></tr>
      </table>
      <div class="a3s">Click to continue:
        <a href="https://links.mailer-acme.net/ls/click?u=abc123">Verify my email</a>
        <a href="https://acme.example.com/unsubscribe">Unsubscribe</a>
      </div>
      </div></body></html>`;
      await withFixtureHtmlPage(inbox, async (page) => {
        const hit = await scanGmailInboxForVerification(page, {
          requestedAt: new Date().toISOString(),
          accept: "code_or_link",
        });
        // The tracking-domain link qualifies (verified sender + fresh +
        // verification-ish); the unsubscribe footer link never does.
        expect(hit).toEqual({
          kind: "link",
          value: "https://links.mailer-acme.net/ls/click?u=abc123",
        });
      });
    },
    45_000,
  );

  it("nav waiter maps a link hit to kind=link (UNIT_CONFIRMED)", async () => {
    const waiter = resolveNavVerificationWaiter({
      gmailWebFetch: async () => ({
        kind: "link" as const,
        value: "https://links.mailer.net/click?t=xyz",
        source: "gmail-web",
      }),
    })!;
    const r = await waiter(
      { sent_to: "candidate@example.com", requested_at: new Date().toISOString() },
      [],
    );
    expect(r.kind).toBe("link");
    if (r.kind === "link") {
      expect(r.url).toBe("https://links.mailer.net/click?t=xyz");
    }
  });

  it("nav waiter works gmail-web-only — no REST waiter, no outlook (UNIT_CONFIRMED)", async () => {
    const waiter = resolveNavVerificationWaiter({
      gmailWebFetch: async () => ({ kind: "code" as const, value: "606060", source: "gmail-web" }),
    })!;
    const r = await waiter(
      { sent_to: "candidate@example.com", requested_at: new Date().toISOString() },
      [],
    );
    expect(r.kind).toBe("code");
  });
});
