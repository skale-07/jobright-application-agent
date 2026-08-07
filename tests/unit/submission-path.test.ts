import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import {
  detectSubmissionUncertainty,
  extractApplicationIdentifier,
  greenhouseVerifySubmission,
  SubmissionUncertainError,
} from "../../src/ats/greenhouse/submission.js";
import { runGreenhouseSubmission } from "../../src/applications/submitRun.js";
import { assertSubmitAllowed } from "../../src/applications/formFillGuards.js";
import {
  createAutomationRun,
  getAutomationRun,
  tryConsumeUnattendedSubmission,
} from "../../src/queue/automationRuns.js";
import {
  insertPendingSubmission,
  markSubmissionUncertain,
  markSubmissionVerified,
} from "../../src/queue/submissionsRepo.js";
import {
  buildIdempotencyKey,
  claimIdempotencyKey,
  IdempotencyConflictError,
  markIdempotencyUncertain,
} from "../../src/queue/idempotency.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  applyControlledFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

const confirmationHtml = fs.readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "greenhouse-confirmation",
    "dom.sanitized.html",
  ),
  "utf8",
);
const formHtml = fs.readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "greenhouse",
    "dom.sanitized.html",
  ),
  "utf8",
);

function seedApp(db: Db, state = "READY_TO_SUBMIT"): string {
  // Unique URL per seed: the job fingerprint would otherwise collide with
  // the partial unique one-active-application-per-job index.
  const jobNo = Math.floor(Math.random() * 1_000_000);
  const job = upsertJobByFingerprint(db, {
    jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
    applicationUrl: `https://boards.greenhouse.io/acme/jobs/${jobNo}`,
    company: "Acme",
    role: "SWE Intern",
  });
  const app = createApplication(db, { jobId: job.id });
  db.prepare(`UPDATE applications SET state = ? WHERE id = ?`).run(
    state,
    app.id,
  );
  return app.id;
}

describe("submit gate matrix (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  const combos: Array<[string, string, string]> = [
    ["false", "true", "false"],
    ["false", "true", "true"],
    ["false", "false", "false"],
    ["false", "false", "true"],
    ["true", "true", "false"],
    ["true", "true", "true"],
    ["true", "false", "false"],
  ];

  for (const [fill, dry, submit] of combos) {
    it(`refuses with FORM_FILL=${fill} DRY_RUN=${dry} SUBMIT=${submit}`, () => {
      applyControlledFillEnv({
        FORM_FILL_ENABLED: fill,
        DRY_RUN: dry,
        SUBMIT_ENABLED: submit,
      });
      expect(() => assertSubmitAllowed("test")).toThrow(
        /FORM_FILL_ENABLED|DRY_RUN|SUBMIT_ENABLED/,
      );
    });
  }

  it("allows only the deliberate triple", () => {
    applyControlledFillEnv({
      FORM_FILL_ENABLED: "true",
      DRY_RUN: "false",
      SUBMIT_ENABLED: "true",
    });
    expect(() => assertSubmitAllowed("test")).not.toThrow();
  });

  it("runGreenhouseSubmission refuses before any browser or DB write", async () => {
    const dbPath = path.join(os.tmpdir(), `jaa-sub-gate-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    const db = openDatabase(dbPath);
    try {
      migrate(db);
      const appId = seedApp(db);
      await expect(
        runGreenhouseSubmission({ db, applicationId: appId }),
      ).rejects.toThrow(/SUBMIT_ENABLED|FORM_FILL_ENABLED|DRY_RUN/);
      const subs = db
        .prepare(`SELECT COUNT(*) AS n FROM submissions`)
        .get() as { n: number };
      expect(subs.n).toBe(0);
    } finally {
      closeDatabase(db);
      for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
  });
});

describe("submission page classification (UNIT/FIXTURE_CONFIRMED)", () => {
  it("classifies confirmation, form, error, unknown", () => {
    expect(
      detectSubmissionUncertainty(
        confirmationHtml,
        "https://boards.greenhouse.io/acme/confirmation",
      ),
    ).toBe("confirmed");
    expect(
      detectSubmissionUncertainty(
        formHtml,
        "https://boards.greenhouse.io/acme/jobs/12345",
      ),
    ).toBe("still_on_form");
    expect(
      detectSubmissionUncertainty(
        "<html><body><h1>Oops! Something went wrong (404)</h1><p>page not found</p></body></html>",
        "https://boards.greenhouse.io/error",
      ),
    ).toBe("error_page");
    expect(
      detectSubmissionUncertainty(
        "<html><body><p>totally unrelated content</p></body></html>",
        "https://boards.greenhouse.io/x",
      ),
    ).toBe("unknown");
  });

  it("extracts the confirmation identifier when present", () => {
    expect(extractApplicationIdentifier(confirmationHtml)).toBe(
      "GH-4481-CONF",
    );
    expect(extractApplicationIdentifier("<p>no id here</p>")).toBeNull();
  });

  it("verifySubmission returns a receipt on the confirmation fixture", async () => {
    const shot = path.join(os.tmpdir(), `jaa-shot-${randomUUID()}.png`);
    await withFixtureHtmlPage(confirmationHtml, async (page) => {
      const receipt = await greenhouseVerifySubmission(page, {
        screenshotPath: shot,
        timeoutMs: 3000,
      });
      expect(receipt.submitted).toBe(true);
      expect(receipt.confirmation_text.toLowerCase()).toContain("thank you");
      expect(receipt.application_identifier).toBe("GH-4481-CONF");
    });
    fs.rmSync(shot, { force: true });
  }, 30_000);

  it("verifySubmission throws SubmissionUncertainError while still on the form", async () => {
    const shot = path.join(os.tmpdir(), `jaa-shot2-${randomUUID()}.png`);
    await withFixtureHtmlPage(formHtml, async (page) => {
      await expect(
        greenhouseVerifySubmission(page, {
          screenshotPath: shot,
          timeoutMs: 2500,
        }),
      ).rejects.toBeInstanceOf(SubmissionUncertainError);
    });
    fs.rmSync(shot, { force: true });
  }, 30_000);
});

describe("resubmission blocking + unattended cap (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-sub-block-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("uncertain idempotency key blocks reclaim until resolution", () => {
    const appId = seedApp(db);
    const key = buildIdempotencyKey("submit", {
      application_id: appId,
      attempt: "1",
    });
    claimIdempotencyKey(db, key, { holderRunId: "r1" });
    markIdempotencyUncertain(db, key, "post-click inconclusive");
    expect(() =>
      claimIdempotencyKey(db, key, { holderRunId: "r2" }),
    ).toThrow(IdempotencyConflictError);
  });

  it("verified + uncertain submissions both block runGreenhouseSubmission", async () => {
    applyControlledFillEnv({
      FORM_FILL_ENABLED: "true",
      DRY_RUN: "false",
      SUBMIT_ENABLED: "true",
    });
    try {
      const appId = seedApp(db);
      const a = insertPendingSubmission(db, { applicationId: appId });
      markSubmissionUncertain(db, a.id, { note: "x" });
      // No resume registered would also refuse, but the guard fires first.
      const report = runGreenhouseSubmission({ db, applicationId: appId });
      await expect(report).rejects.toThrow(/uncertain submission/i);

      const appId2 = seedApp(db);
      const b = insertPendingSubmission(db, { applicationId: appId2 });
      markSubmissionVerified(db, b.id, {
        submitted: true,
        submitted_at: new Date().toISOString(),
        confirmation_url: "u",
        confirmation_text: "t",
        application_identifier: null,
        screenshot_path: "s",
      });
      await expect(
        runGreenhouseSubmission({ db, applicationId: appId2 }),
      ).rejects.toThrow(/already has verified submission/);
    } finally {
      resetConfigCache();
    }
  });

  it("unattended cap: 0 always refuses; cap 1 allows exactly one", () => {
    process.env.MAX_UNATTENDED_SUBMISSIONS_PER_RUN = "0";
    resetConfigCache();
    const run0 = createAutomationRun(db, { stage: "submit" });
    expect(tryConsumeUnattendedSubmission(db, run0.id)).toBe(false);

    process.env.MAX_UNATTENDED_SUBMISSIONS_PER_RUN = "1";
    resetConfigCache();
    const run1 = createAutomationRun(db, { stage: "submit" });
    expect(tryConsumeUnattendedSubmission(db, run1.id)).toBe(true);
    expect(tryConsumeUnattendedSubmission(db, run1.id)).toBe(false);
    expect(getAutomationRun(db, run1.id)?.unattended_submissions_count).toBe(1);

    delete process.env.MAX_UNATTENDED_SUBMISSIONS_PER_RUN;
    resetConfigCache();
  });

  it("refuses when application is not READY_TO_SUBMIT", async () => {
    applyControlledFillEnv({
      FORM_FILL_ENABLED: "true",
      DRY_RUN: "false",
      SUBMIT_ENABLED: "true",
    });
    try {
      const appId = seedApp(db, "QUEUED");
      const report = await runGreenhouseSubmission({
        db,
        applicationId: appId,
      });
      expect(report.outcome).toBe("REFUSED");
      expect(report.reason).toMatch(/not READY_TO_SUBMIT/);
    } finally {
      resetConfigCache();
    }
  });

  it("refuses without a registered resume material", async () => {
    applyControlledFillEnv({
      FORM_FILL_ENABLED: "true",
      DRY_RUN: "false",
      SUBMIT_ENABLED: "true",
    });
    try {
      const appId = seedApp(db);
      const report = await runGreenhouseSubmission({
        db,
        applicationId: appId,
      });
      expect(report.outcome).toBe("REFUSED");
      expect(report.reason).toMatch(/resume material/i);
    } finally {
      resetConfigCache();
    }
  });
});
