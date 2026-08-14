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
  let savedPortalEmail: string | undefined;
  let savedPortalPassword: string | undefined;

  beforeEach(async () => {
    applySafeFillEnv();
    savedPortalEmail = process.env.PORTAL_LOGIN_EMAIL;
    savedPortalPassword = process.env.PORTAL_LOGIN_PASSWORD;
    delete process.env.PORTAL_LOGIN_EMAIL;
    delete process.env.PORTAL_LOGIN_PASSWORD;
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
    if (savedPortalEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
    else process.env.PORTAL_LOGIN_EMAIL = savedPortalEmail;
    if (savedPortalPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
    else process.env.PORTAL_LOGIN_PASSWORD = savedPortalPassword;
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
        expect(r.notes.join(" ")).toMatch(/portal auth create/);
        expect(r.diagnosis?.classification).toBe("create_account_form");
        // Password is a secret — it must be offered for scrubbing, never in notes.
        const pw = await page.locator("[data-automation-id='password']").inputValue();
        expect(r.secrets).toContain(pw);
        expect(r.notes.join(" ")).not.toContain(pw);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("escalates to create-account ONLY after the sign-in is rejected", async () => {
    // Live Amazon wall (operator screenshots 2026-08-12): a sign-in page
    // with a "Create an ... account" link. The account is minted only
    // because the portal said the credentials are wrong.
    const REJECT_HTML = `<!DOCTYPE html><html><body>
      <div id="wall">
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <button data-automation-id="signInSubmitButton" type="button">Sign in</button>
        <button id="route" type="button">Create an Example account</button>
      </div>
      <p id="err"></p>
      <script>
        document.querySelector('[data-automation-id=signInSubmitButton]')
          .addEventListener('click', () => {
            document.getElementById('err').textContent =
              'Your email or password is incorrect. Please try again.';
          });
        document.getElementById('route').addEventListener('click', () => {
          (globalThis).__routeClicked = true;
          document.getElementById('err').textContent = '';
          document.getElementById('wall').innerHTML =
            '<input data-automation-id="email" type="email" />' +
            '<input data-automation-id="password" type="password" />' +
            '<input data-automation-id="verifyPassword" type="password" />' +
            '<button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>';
          document.querySelector('[data-automation-id=createAccountSubmitButton]')
            .addEventListener('click', () => {
              (globalThis).__created = true;
              document.body.innerHTML = '<p>Welcome, your account is ready.</p>';
            });
        });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(REJECT_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@example.com",
          settleMs: 0,
        });
        expect(r.escalated_to_create).toBe(true);
        expect(r.status).toBe("account_created");
        expect(
          await page.evaluate(() => (globalThis as unknown as { __created?: boolean }).__created),
        ).toBe(true);
        expect(r.notes.join(" ")).toMatch(/sign-in rejected — opened/);
        // The rejection is what authorized the escalation, and it is on record.
        expect(r.notes.join(" ")).toMatch(/credentials_rejected/);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("never escalates when the sign-in succeeds (create route left untouched)", async () => {
    const OK_HTML = `<!DOCTYPE html><html><body>
      <div id="wall">
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <button data-automation-id="signInSubmitButton" type="button">Sign in</button>
        <button id="route" type="button">Create an Example account</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=signInSubmitButton]')
          .addEventListener('click', () => {
            document.body.innerHTML = '<p>My Applications</p>';
          });
        document.getElementById('route').addEventListener('click', () => {
          (globalThis).__routeClicked = true;
        });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(OK_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@example.com",
          settleMs: 0,
        });
        expect(r.status).toBe("signed_in");
        expect(r.escalated_to_create).toBe(false);
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __routeClicked?: boolean }).__routeClicked,
          ),
        ).toBeUndefined();
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

  it("Crowe posting: Apply → Apply Manually → Sign In with standing credentials (FIXTURE_CONFIRMED)", async () => {
    // Operator screenshots 2026-08-14: posting Apply, modal Apply Manually,
    // then Create Account with "Already have an account? Sign In".
    const CROWE_HTML = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h1>AI Engineering Intern</h1>
        <button data-automation-id="adventureButton" type="button">Apply</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=adventureButton]')
          .addEventListener('click', () => {
            document.getElementById('stage').innerHTML =
              '<h2>Start Your Application</h2>' +
              '<button data-automation-id="autofillWithResume" type="button">Autofill with Resume</button>' +
              '<button data-automation-id="applyManually" type="button">Apply Manually</button>' +
              '<button type="button">Use My Last Application</button>';
            document.querySelector('[data-automation-id=applyManually]')
              .addEventListener('click', () => {
                document.getElementById('stage').innerHTML =
                  '<h2>Create Account</h2>' +
                  '<input data-automation-id="email" type="email" />' +
                  '<input data-automation-id="password" type="password" />' +
                  '<input data-automation-id="verifyPassword" type="password" />' +
                  '<button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>' +
                  '<p>Already have an account? <button data-automation-id="signInLink" type="button">Sign In</button></p>';
                document.querySelector('[data-automation-id=signInLink]')
                  .addEventListener('click', () => {
                    document.getElementById('stage').innerHTML =
                      '<h2>Sign In</h2>' +
                      '<input data-automation-id="email" type="email" />' +
                      '<input data-automation-id="password" type="password" />' +
                      '<button data-automation-id="signInSubmitButton" type="button">Sign In</button>';
                    document.querySelector('[data-automation-id=signInSubmitButton]')
                      .addEventListener('click', () => {
                        document.body.innerHTML = '<p>My Information</p>';
                      });
                  });
                document.querySelector('[data-automation-id=createAccountSubmitButton]')
                  .addEventListener('click', () => {
                    (globalThis).__createdInstead = true;
                  });
              });
            document.querySelector('[data-automation-id=autofillWithResume]')
              .addEventListener('click', () => {
                (globalThis).__autofill = true;
              });
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    const prevEmail = process.env.PORTAL_LOGIN_EMAIL;
    const prevPassword = process.env.PORTAL_LOGIN_PASSWORD;
    process.env.PORTAL_LOGIN_EMAIL = "candidate@example.com";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    try {
      await onWorkdayPage(CROWE_HTML, async (page) => {
        let waiterCalls = 0;
        const r = await authenticateAtsPortal(page, {
          settleMs: 0,
          waiter: async () => {
            waiterCalls += 1;
            return { kind: "code", code: "000000", messageId: "m", pollsUsed: 1 };
          },
        });
        expect(r.notes.join(" ")).toMatch(/clicked "Apply"/);
        expect(r.notes.join(" ")).toMatch(/Apply Manually/);
        expect(r.notes.join(" ")).toMatch(/flipped Create Account → Sign In/);
        expect(r.status).toBe("signed_in");
        expect(r.escalated_to_create).toBe(false);
        expect(waiterCalls).toBe(0);
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __autofill?: boolean }).__autofill,
          ),
        ).toBeUndefined();
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __createdInstead?: boolean }).__createdInstead,
          ),
        ).toBeUndefined();
        expect(r.secrets).toContain("StandingPass1!");
        expect(r.notes.join(" ")).not.toContain("StandingPass1!");
      });
    } finally {
      if (prevEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
      else process.env.PORTAL_LOGIN_EMAIL = prevEmail;
      if (prevPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
      else process.env.PORTAL_LOGIN_PASSWORD = prevPassword;
      applySafeFillEnv();
      resetConfigCache();
    }
  }, 30_000);

  /**
   * The fixture above reveals each stage SYNCHRONOUSLY on click, which is
   * why it passed while the live run failed. Live 2026-08-14 (Crowe):
   * Workday rebuilt the page ~seconds after "Apply Manually"; the walk
   * probed 800ms later, found no third button, returned, and reported
   * "portal auth: no sign-in form on this page" with PORTAL_LOGIN_*
   * sitting unused in the env. This is that page, on a delay.
   */
  it("waits for a Workday account form that renders SECONDS after Apply Manually", async () => {
    const DELAYED_HTML = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h1>AI Engineering Intern</h1>
        <button data-automation-id="adventureButton" type="button">Apply</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=adventureButton]')
          .addEventListener('click', () => {
            document.getElementById('stage').innerHTML =
              '<h2>Start Your Application</h2>' +
              '<button data-automation-id="applyManually" type="button">Apply Manually</button>';
            document.querySelector('[data-automation-id=applyManually]')
              .addEventListener('click', () => {
                // Nothing clickable in the meantime — the old walk gave up here.
                document.getElementById('stage').innerHTML = '<p>Loading…</p>';
                setTimeout(() => {
                  document.getElementById('stage').innerHTML =
                    '<div data-automation-id="progressBar">Create Account/Sign In</div>' +
                    '<h2>Create Account</h2>' +
                    '<input data-automation-id="email" type="email" />' +
                    '<input data-automation-id="password" type="password" />' +
                    '<input data-automation-id="verifyPassword" type="password" />' +
                    '<button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>';
                  document.querySelector('[data-automation-id=createAccountSubmitButton]')
                    .addEventListener('click', () => {
                      (globalThis).__created = true;
                      document.body.innerHTML = '<p>My Information</p>';
                    });
                }, 1500);
              });
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    const prevEmail = process.env.PORTAL_LOGIN_EMAIL;
    const prevPassword = process.env.PORTAL_LOGIN_PASSWORD;
    process.env.PORTAL_LOGIN_EMAIL = "candidate@example.com";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    try {
      await onWorkdayPage(DELAYED_HTML, async (page) => {
        // settleMs > 0 engages the live poll (0 keeps fixtures synchronous).
        const r = await authenticateAtsPortal(page, { settleMs: 1 });
        expect(r.notes.join(" ")).toMatch(/Apply Manually/);
        // The whole point: the form was found, so the credentials were used.
        expect(r.notes.join(" ")).not.toMatch(/no sign-in form on this page/);
        expect(r.status).not.toBe("not_an_auth_wall");
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __created?: boolean }).__created,
          ),
        ).toBe(true);
        expect(r.secrets).toContain("StandingPass1!");
        expect(r.notes.join(" ")).not.toContain("StandingPass1!");
      });
    } finally {
      if (prevEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
      else process.env.PORTAL_LOGIN_EMAIL = prevEmail;
      if (prevPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
      else process.env.PORTAL_LOGIN_PASSWORD = prevPassword;
      applySafeFillEnv();
      resetConfigCache();
    }
  }, 30_000);

  it("after sign-in, scans Gmail only when the page asks for a verification code (FIXTURE_CONFIRMED)", async () => {
    const OTP_HTML = `<!DOCTYPE html><html><body>
      <div id="wall">
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=signInSubmitButton]')
          .addEventListener('click', () => {
            document.getElementById('wall').innerHTML =
              '<p>We sent a verification code to your email — enter the code to continue.</p>' +
              '<input data-automation-id="verificationCode" autocomplete="one-time-code" />' +
              '<button data-automation-id="verifyButton" type="button">Verify</button>';
            document.querySelector('[data-automation-id=verifyButton]')
              .addEventListener('click', () => {
                document.body.innerHTML = '<p>My Information</p>';
              });
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(OTP_HTML, async (page) => {
        let waiterCalls = 0;
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@example.com",
          settleMs: 0,
          waiter: async () => {
            waiterCalls += 1;
            return { kind: "code", code: "482193", messageId: "m", pollsUsed: 1 };
          },
        });
        expect(waiterCalls).toBe(1);
        expect(r.verification_used).toBe(true);
        expect(r.status).toBe("signed_in");
        expect(r.secrets).toContain("482193");
        expect(r.notes.join(" ")).toMatch(/emailed code entered/);
        expect(r.notes.join(" ")).not.toContain("482193");
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);
});
