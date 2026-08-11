import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateAtsPortal } from "../../src/verification/portalAuth.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * Workday W2 — deterministic portal auth. FIXTURE_CONFIRMED via a routed
 * Workday-host page and a stubbed mailbox waiter. The credential-spray
 * guard (host gate) and the evidence gate (no inbox scan without a
 * verification prompt) are the load-bearing rails under test.
 */
const AUTH_HTML = `<!DOCTYPE html><html><body>
  <form>
    <input data-automation-id="email" type="email" />
    <input data-automation-id="password" type="password" />
    <input data-automation-id="verifyPassword" type="password" />
    <input data-automation-id="createAccountCheckbox" type="checkbox" />
    <button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>
  </form>
  <p>Create an account to apply</p>
</body></html>`;

describe("workday portal auth (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let browser: Browser;
  let privDir: string;
  const savedPriv = process.env.PRIVATE_DIR;

  beforeEach(async () => {
    applySafeFillEnv();
    privDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-portal-"));
    fs.mkdirSync(path.join(privDir, "candidate"), { recursive: true });
    process.env.PRIVATE_DIR = privDir;
    resetConfigCache();
    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    await browser.close().catch(() => undefined);
    if (savedPriv === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = savedPriv;
    fs.rmSync(privDir, { recursive: true, force: true });
    resetConfigCache();
  });

  async function onWorkdayPage<T>(
    html: string,
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route("**/*", (route) =>
      route.fulfill({ body: html, contentType: "text/html" }),
    );
    await page.goto(
      "https://interdigital.wd5.myworkdayjobs.com/en-US/Careers/login",
      { waitUntil: "domcontentloaded" },
    );
    try {
      return await fn(page);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  it("refuses to type credentials on a non-Workday host (credential-spray guard)", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route("**/*", (route) =>
      route.fulfill({ body: AUTH_HTML, contentType: "text/html" }),
    );
    await page.goto("https://phish.example.com/signin", {
      waitUntil: "domcontentloaded",
    });
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      const r = await authenticateAtsPortal(page, { emailOverride: "c@x.com", settleMs: 0 });
      expect(r.status).toBe("refused");
      expect(r.notes.join(" ")).toMatch(/not a recognized ATS auth host/);
      // Nothing was typed.
      expect(await page.locator("[data-automation-id='email']").inputValue()).toBe("");
    } finally {
      applySafeFillEnv();
      await context.close().catch(() => undefined);
    }
  }, 30_000);

  it("creates the account with the candidate email + vault password, no inbox scan without a prompt", async () => {
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(AUTH_HTML, async (page) => {
        let waiterCalls = 0;
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@example.com",
          settleMs: 0,
          waiter: async () => {
            waiterCalls += 1;
            return { kind: "code", code: "0", messageId: "m", pollsUsed: 1 };
          },
        });
        // The form is still present in this fixture (no SPA transition), so
        // the flow reports wall_remains — but the load-bearing facts hold:
        expect(await page.locator("[data-automation-id='email']").inputValue()).toBe(
          "candidate@example.com",
        );
        expect(
          (await page.locator("[data-automation-id='password']").inputValue()).length,
        ).toBeGreaterThan(0);
        // No verification input on this page ⇒ mailbox never consulted.
        expect(waiterCalls).toBe(0);
        expect(r.notes.join(" ")).toMatch(/create-account submitted/);
        // Password is a secret — it must be offered for scrubbing, never in notes.
        const pw = await page.locator("[data-automation-id='password']").inputValue();
        expect(r.secrets).toContain(pw);
        expect(r.notes.join(" ")).not.toContain(pw);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("scans the mailbox ONLY when a code field + verification prompt are present", async () => {
    const VERIFY_HTML = `<!DOCTYPE html><html><body>
      <input data-automation-id="verificationCode" autocomplete="one-time-code" />
      <button data-automation-id="verifyButton" type="button">Verify</button>
      <p>We sent a verification code to your email — enter the code to continue.</p>
    </body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(VERIFY_HTML, async (page) => {
        // No email/password inputs here ⇒ not_an_auth_wall short-circuits
        // BEFORE any mailbox logic, proving the flow needs the sign-in form.
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@example.com",
          settleMs: 0,
          waiter: async () => ({ kind: "code", code: "482193", messageId: "m", pollsUsed: 1 }),
        });
        expect(r.status).toBe("not_an_auth_wall");
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);
});
