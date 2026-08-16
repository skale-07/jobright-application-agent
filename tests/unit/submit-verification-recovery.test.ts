import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createApplication, getApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { registerResumeMaterial } from "../../src/jobright/materialsRegister.js";
import { setEmployerApplicationUrl } from "../../src/pipeline/runPipeline.js";
import { listOpenReviewItems } from "../../src/queue/reviewItems.js";
import { diagnoseDisabledSubmit } from "../../src/ats/shared/submitDiagnostics.js";
import { recoverEmailVerification } from "../../src/verification/recoverSubmitVerification.js";
import { readCodeFromMailboxPage } from "../../src/verification/codeProviders.js";
import { leverSelectorsV1 } from "../../src/ats/lever/selectors.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

// Serve the employer URL from the lever-VERIFICATION fixture (disabled
// submit + one-time-code gate that enables it on a 6-digit entry).
vi.mock("../../src/browser/fixtureSession.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/browser/fixtureSession.js")>();
  const html = fs.readFileSync(
    path.join(
      process.cwd(),
      "tests",
      "fixtures",
      "ats",
      "lever-verification",
      "dom.sanitized.html",
    ),
    "utf8",
  );
  return {
    ...actual,
    withPublicUrlPage: async (
      url: string,
      fn: (page: import("playwright").Page) => Promise<unknown>,
    ) =>
      actual.withFixtureHtmlPage("<html><body></body></html>", async (page) => {
        await page.route("**/*", (route) =>
          route.fulfill({ body: html, contentType: "text/html" }),
        );
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return fn(page);
      }),
  };
});

const { runAtsSubmission, isEmailedCodeWallOnly } = await import(
  "../../src/applications/submitRun.js"
);

describe("isEmailedCodeWallOnly gate passthrough (UNIT_CONFIRMED)", () => {
  const wall = (reason: string) => ({
    ok: false,
    failureCode: "LOGIN_WALL",
    reason,
  });

  it("a pure emailed-code wall passes through to the recovery", () => {
    expect(
      isEmailedCodeWallOnly(wall("login wall detected: emailed_code_wall")),
    ).toBe(true);
  });

  it("a wall that ALSO shows a password input still refuses", () => {
    // A password prompt is not recoverable by reading mail — the pre-tuning
    // refusal must survive for every mixed signature detectLoginWall emits.
    expect(
      isEmailedCodeWallOnly(
        wall(
          "login wall detected: password_input_visible_in_dom, emailed_code_wall",
        ),
      ),
    ).toBe(false);
    expect(
      isEmailedCodeWallOnly(
        wall(
          "login wall detected: email_and_password_inputs, emailed_code_wall",
        ),
      ),
    ).toBe(false);
  });

  it("non-LOGIN_WALL failures and passing gates never match", () => {
    expect(
      isEmailedCodeWallOnly({
        ok: false,
        failureCode: "NO_APPLICATION_FORM",
        reason: "emailed_code_wall",
      }),
    ).toBe(false);
    expect(
      isEmailedCodeWallOnly({ ok: true, failureCode: null, reason: null }),
    ).toBe(false);
    expect(
      isEmailedCodeWallOnly(wall("login wall detected: sign_in_heading_or_title")),
    ).toBe(false);
  });
});
const { withFixtureHtmlPage } = await import("../../src/browser/fixtureSession.js");

const LEVER_URL =
  "https://jobs.lever.co/acme/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply";
const SYNTHETIC_PDF = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "sample-resume.pdf",
);
const VERIFICATION_FIXTURE = fs.readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "lever-verification",
    "dom.sanitized.html",
  ),
  "utf8",
);

describe("disabled-submit diagnostics (FIXTURE_CONFIRMED)", () => {
  it(
    "names the verification wall: input selector, prompt, email hint, invalid required fields",
    async () => {
      await withFixtureHtmlPage(VERIFICATION_FIXTURE, async (page) => {
        const d = await diagnoseDisabledSubmit(page);
        expect(d.verification.detected).toBe(true);
        expect(d.verification.input_selector).toBe("#email-verification-code");
        expect(d.verification.prompt_excerpt).toMatch(/verification code/i);
        expect(d.verification.email_hint).toBe("candidate@example.com");
        // Empty required fields (name/email/work-auth) are named too.
        expect(d.required_invalid.length).toBeGreaterThan(0);
        expect(d.summary).toMatch(/email verification code required/);
        expect(d.summary).toMatch(/sent to candidate@example.com/);
      });
    },
    45_000,
  );

  it(
    "prefers the real OTP input over fields that merely say 'code'",
    async () => {
      // Zip/referral code fields come FIRST in DOM order — picking by
      // position would type the mailbox code into the wrong box.
      const decoys = `<html><body><form>
        <label for="zip">Zip code *</label>
        <input id="zip" name="zip_code" required>
        <label for="ref">Referral code</label>
        <input id="ref" name="referral_code" placeholder="code">
        <p>We sent a verification code to candidate@example.com.</p>
        <label for="otp">Verification code</label>
        <input id="otp" name="verification_code" autocomplete="one-time-code">
        <button type="submit" disabled>Submit</button>
      </form></body></html>`;
      await withFixtureHtmlPage(decoys, async (page) => {
        const d = await diagnoseDisabledSubmit(page);
        expect(d.verification.detected).toBe(true);
        expect(d.verification.input_selector).toBe("#otp");
      });

      // With only a zip field and verification wording, nothing qualifies.
      const zipOnly = `<html><body><form>
        <p>We sent a verification code to candidate@example.com.</p>
        <label for="zip">Zip code</label>
        <input id="zip" name="zip_code" placeholder="code">
        <button type="submit" disabled>Submit</button>
      </form></body></html>`;
      await withFixtureHtmlPage(zipOnly, async (page) => {
        const d = await diagnoseDisabledSubmit(page);
        expect(d.verification.detected).toBe(false);
        expect(d.summary).toMatch(/no code input matched/);
      });
    },
    45_000,
  );

  it(
    "a plain form (no verification wording) diagnoses without false positives",
    async () => {
      const plain = fs.readFileSync(
        path.join(process.cwd(), "tests", "fixtures", "ats", "lever", "dom.sanitized.html"),
        "utf8",
      );
      await withFixtureHtmlPage(plain, async (page) => {
        const d = await diagnoseDisabledSubmit(page);
        expect(d.verification.detected).toBe(false);
        expect(d.verification.input_selector).toBeNull();
      });
    },
    45_000,
  );
});

describe("email verification recovery (FIXTURE_CONFIRMED)", () => {
  it(
    "fetches, types, and unlocks the submit control; null fetch fails closed",
    async () => {
      await withFixtureHtmlPage(VERIFICATION_FIXTURE, async (page) => {
        const d = await diagnoseDisabledSubmit(page);

        const dry = await recoverEmailVerification(page, d, {
          fetchCode: async () => null,
          submitSelector: leverSelectorsV1.submit,
          requestedAt: new Date().toISOString(),
          enableTimeoutMs: 2_000,
        });
        expect(dry.entered).toBe(false);
        expect(dry.submitEnabled).toBe(false);

        const ok = await recoverEmailVerification(page, d, {
          fetchCode: async () => ({ code: "482193", source: "test" }),
          submitSelector: leverSelectorsV1.submit,
          requestedAt: new Date().toISOString(),
          enableTimeoutMs: 5_000,
        });
        expect(ok.entered).toBe(true);
        expect(ok.submitEnabled).toBe(true);
        // The code value itself never appears in notes.
        expect(ok.notes.join(" ")).not.toContain("482193");
      });
    },
    45_000,
  );

  it(
    "readCodeFromMailboxPage scans an Outlook-shaped inbox and skips decoys",
    async () => {
      const inbox = `<html><body>
        <div role="option">Weekly digest — top jobs for you, act now!</div>
        <div role="option">Acme Careers — Your verification code</div>
        <div class="allowTextSelection">Hello, your verification code is 482193. It expires in 10 minutes.</div>
      </body></html>`;
      await withFixtureHtmlPage(inbox, async (page) => {
        const code = await readCodeFromMailboxPage(page, {
          requestedAt: new Date().toISOString(),
        });
        expect(code).toBe("482193");
      });

      const noCode = `<html><body>
        <div role="option">Weekly digest — 250000 users joined</div>
        <div class="allowTextSelection">Marketing copy only.</div>
      </body></html>`;
      await withFixtureHtmlPage(noCode, async (page) => {
        expect(
          await readCodeFromMailboxPage(page, { requestedAt: new Date().toISOString() }),
        ).toBeNull();
      });

      // A code that predates the request is stale — reusing it would burn
      // the attempt on an expired value.
      const stale = `<html><body>
        <div role="option">
          <span data-datetime="2020-01-01T00:00:00Z">Jan 1</span>
          Acme Careers — Your verification code
        </div>
        <div class="allowTextSelection">Your verification code is 482193.</div>
      </body></html>`;
      await withFixtureHtmlPage(stale, async (page) => {
        expect(
          await readCodeFromMailboxPage(page, {
            requestedAt: new Date().toISOString(),
          }),
        ).toBeNull();
        // The same message qualifies when the request predates it.
        expect(
          await readCodeFromMailboxPage(page, {
            requestedAt: "2019-01-01T00:00:00Z",
          }),
        ).toBe("482193");
      });
    },
    45_000,
  );
});

describe("submitRun verification recovery end-to-end (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  let db: Db | null = null;
  let dbPath = "";

  afterEach(() => {
    applySafeFillEnv();
    if (db) closeDatabase(db);
    db = null;
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
  });

  function freshDb(): Db {
    dbPath = path.join(os.tmpdir(), `jaa-verify-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    const opened = openDatabase(dbPath);
    migrate(opened);
    db = opened;
    return opened;
  }

  function seedReadyApp(database: Db): string {
    const job = upsertJobByFingerprint(database, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().slice(0, 24)}`,
      company: "Acme",
      role: "SWE",
    });
    const app = createApplication(database, { jobId: job.id });
    database
      .prepare(`UPDATE applications SET state = 'READY_TO_SUBMIT' WHERE id = ?`)
      .run(app.id);
    setEmployerApplicationUrl(database, app.id, LEVER_URL);
    registerResumeMaterial({ db: database, applicationId: app.id, filePath: SYNTHETIC_PDF });
    return app.id;
  }

  it(
    "recovers: fetches the code, unlocks submit, and crosses into the click",
    async () => {
      const database = freshDb();
      const appId = seedReadyApp(database);
      applyControlledFillEnv({
        FORM_FILL_ENABLED: "true",
        DRY_RUN: "false",
        SUBMIT_ENABLED: "true",
      });

      let fetches = 0;
      const report = await runAtsSubmission({
        db: database,
        applicationId: appId,
        confirmSubmission: async () => true,
        fetchVerificationCode: async ({ emailHint }) => {
          fetches++;
          expect(emailHint).toBe("candidate@example.com");
          return { code: "482193", source: "test" };
        },
      });

      expect(fetches).toBe(1);
      // The click happened — the run is past FAILED_BEFORE_CLICK territory.
      expect(report.outcome).not.toBe("FAILED_BEFORE_CLICK");
      expect(report.outcome).not.toBe("REFUSED");
      const submitting = database
        .prepare(
          `SELECT COUNT(*) AS n FROM application_events
           WHERE application_id = ? AND next_state = 'SUBMITTING'`,
        )
        .get(appId) as { n: number };
      expect(submitting.n).toBe(1);
    },
    120_000,
  );

  it(
    "no provider: fails before the click with a NAMED reason and an AUTH_REQUIRED review item",
    async () => {
      const database = freshDb();
      const appId = seedReadyApp(database);
      // Verification flags stay OFF (isolated env) — provider resolves null.
      applyControlledFillEnv({
        FORM_FILL_ENABLED: "true",
        DRY_RUN: "false",
        SUBMIT_ENABLED: "true",
      });

      const report = await runAtsSubmission({
        db: database,
        applicationId: appId,
        confirmSubmission: async () => true,
      });

      expect(report.outcome).toBe("FAILED_BEFORE_CLICK");
      expect(report.reason).toMatch(/email verification code required/i);
      expect(report.reason).toMatch(/sent to candidate@example.com/);
      expect(report.reason).toMatch(/no mailbox provider enabled/i);
      expect(getApplication(database, appId)?.state).toBe("FAILED_RETRYABLE");
      const item = listOpenReviewItems(database).find(
        (i) => i.kind === "AUTH_REQUIRED" && /verification code/i.test(i.title),
      );
      expect(item).toBeTruthy();
    },
    120_000,
  );
});
