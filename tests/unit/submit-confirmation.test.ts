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
import { createAutomationRun } from "../../src/queue/automationRuns.js";
import {
  defaultTtyConfirm,
  formatTtyConfirmation,
  type SubmitConfirmationSummary,
} from "../../src/applications/submitConfirmation.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

// Serve the employer URL from the lever fixture so the full submission path
// (gates, plan, confirmation) runs offline. Only withPublicUrlPage is
// replaced; everything else in the module stays real.
vi.mock("../../src/browser/fixtureSession.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/browser/fixtureSession.js")>();
  const leverHtml = fs.readFileSync(
    path.join(process.cwd(), "tests", "fixtures", "ats", "lever", "dom.sanitized.html"),
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
          route.fulfill({ body: leverHtml, contentType: "text/html" }),
        );
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return fn(page);
      }),
  };
});

const { runAtsSubmission } = await import("../../src/applications/submitRun.js");

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

const SAMPLE: SubmitConfirmationSummary = {
  application_id: "app-1",
  company: "Acme",
  role: "SWE",
  url: LEVER_URL,
  attempt: 2,
  resume_sha256: "0123456789abcdef0123456789abcdef",
  resume_size_bytes: 12345,
  plan: { fillable_count: 7, skipped_count: 2, review_required_count: 1 },
};

describe("submit confirmation seam (UNIT_CONFIRMED)", () => {
  it("formatTtyConfirmation matches the historical CLI block character-for-character", () => {
    // This string IS the byte-identity guard: it mirrors the console.log
    // sequence the CLI printed before the seam existed. Do not reflow.
    expect(formatTtyConfirmation(SAMPLE)).toBe(
      "\n=== SUBMIT CONFIRMATION ===\n" +
        "  company : Acme\n" +
        "  role    : SWE\n" +
        `  url     : ${LEVER_URL}\n` +
        "  attempt : 2\n" +
        "  resume  : sha256 0123456789abcdef… (12345 bytes)\n" +
        "  plan    : 7 fill, 2 skip, 1 review",
    );
    expect(formatTtyConfirmation({ ...SAMPLE, company: null, role: null })).toContain(
      "  company : ?\n  role    : ?",
    );
  });

  it("defaultTtyConfirm prints the block, waits for Enter, and never declines", async () => {
    const prompts: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const confirm = defaultTtyConfirm(async (prompt) => {
        prompts.push(prompt);
      });
      await expect(confirm(SAMPLE)).resolves.toBe(true);
      expect(prompts).toEqual([
        "Press Enter to fill and SUBMIT this application, Ctrl+C to abort... ",
      ]);
      expect(logSpy).toHaveBeenCalledWith(formatTtyConfirmation(SAMPLE));
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("web-confirm decline path (FIXTURE_CONFIRMED via routed lever fixture)", () => {
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
    dbPath = path.join(os.tmpdir(), `jaa-confirm-${randomUUID()}.sqlite`);
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
    "decline refuses BEFORE the SUBMITTING transition; app stays READY_TO_SUBMIT",
    async () => {
      const database = freshDb();
      const appId = seedReadyApp(database);
      applyControlledFillEnv({
        FORM_FILL_ENABLED: "true",
        DRY_RUN: "false",
        SUBMIT_ENABLED: "true",
      });

      let seen: SubmitConfirmationSummary | null = null;
      const report = await runAtsSubmission({
        db: database,
        applicationId: appId,
        confirmSubmission: async (summary) => {
          seen = summary;
          return false;
        },
      });

      expect(report.outcome).toBe("REFUSED");
      expect(report.reason).toMatch(/declined/i);

      // The callback received the true summary of what would be submitted.
      expect(seen).not.toBeNull();
      const summary = seen as unknown as SubmitConfirmationSummary;
      expect(summary.company).toBe("Acme");
      expect(summary.url).toBe(LEVER_URL);
      expect(summary.resume_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(summary.plan.fillable_count).toBeGreaterThan(0);

      // Declined BEFORE any mutation: app still READY_TO_SUBMIT, never SUBMITTING.
      expect(getApplication(database, appId)?.state).toBe("READY_TO_SUBMIT");
      const submitting = database
        .prepare(
          `SELECT COUNT(*) AS n FROM application_events
           WHERE application_id = ? AND next_state = 'SUBMITTING'`,
        )
        .get(appId) as { n: number };
      expect(submitting.n).toBe(0);

      // Evidence trail: failed submissions row + failed idempotency key.
      const sub = database
        .prepare(
          `SELECT status, submitted FROM submissions WHERE application_id = ?`,
        )
        .get(appId) as { status: string; submitted: number };
      expect(sub.status).toBe("FAILED");
      expect(sub.submitted).toBe(0);
      const idem = database
        .prepare(`SELECT status, result_ref FROM idempotency_keys`)
        .get() as { status: string; result_ref: string | null };
      expect(idem.status).toBe("failed");
      expect(idem.result_ref).toContain("operator_declined");

      // A fresh attempt is possible (idempotency key failed, not claimed).
      const second = await runAtsSubmission({
        db: database,
        applicationId: appId,
        confirmSubmission: async () => false,
      });
      expect(second.outcome).toBe("REFUSED");
      expect(second.reason).toMatch(/declined/i);
    },
    120_000,
  );

  it(
    "accept proceeds past the confirmation into SUBMITTING",
    async () => {
      const database = freshDb();
      const appId = seedReadyApp(database);
      applyControlledFillEnv({
        FORM_FILL_ENABLED: "true",
        DRY_RUN: "false",
        SUBMIT_ENABLED: "true",
      });

      let calls = 0;
      const report = await runAtsSubmission({
        db: database,
        applicationId: appId,
        confirmSubmission: async () => {
          calls++;
          return true;
        },
      });

      expect(calls).toBe(1);
      // The fixture page cannot produce a verified receipt; what matters is
      // that acceptance crossed the confirmation boundary into SUBMITTING.
      const submitting = database
        .prepare(
          `SELECT COUNT(*) AS n FROM application_events
           WHERE application_id = ? AND next_state = 'SUBMITTING'`,
        )
        .get(appId) as { n: number };
      expect(submitting.n).toBe(1);
      expect(report.outcome).not.toBe("REFUSED");
    },
    120_000,
  );

  it(
    "unattended without --yes refuses WITHOUT burning a budget slot (ordering fix)",
    async () => {
      const database = freshDb();
      const appId = seedReadyApp(database);
      // Unattended mode: confirmation off, a cap of 1 available.
      applyControlledFillEnv({
        FORM_FILL_ENABLED: "true",
        DRY_RUN: "false",
        SUBMIT_ENABLED: "true",
        SUBMIT_REQUIRES_LOCAL_CONFIRMATION: "false",
        MAX_UNATTENDED_SUBMISSIONS_PER_RUN: "1",
      });
      const run = createAutomationRun(database, { stage: "submit" });

      const report = await runAtsSubmission({
        db: database,
        applicationId: appId,
        automationRunId: run.id,
        // no assumeYes → must refuse before consuming the slot
      });

      expect(report.outcome).toBe("REFUSED");
      expect(report.reason).toMatch(/--yes/);
      // The budget counter must be untouched — the whole point of the fix.
      const counter = (
        database
          .prepare(
            `SELECT unattended_submissions_count AS c FROM automation_runs WHERE id = ?`,
          )
          .get(run.id) as { c: number }
      ).c;
      expect(counter).toBe(0);
    },
    120_000,
  );
});
