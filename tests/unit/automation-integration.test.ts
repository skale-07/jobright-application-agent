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
import { createApplication, getApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { setEmployerApplicationUrl } from "../../src/pipeline/runPipeline.js";
import { registerResumeMaterial } from "../../src/jobright/materialsRegister.js";
import { listOpenReviewItems } from "../../src/queue/reviewItems.js";
import {
  armSession,
  disarmSession,
  getArmStatus,
  hashArmToken,
  noteArmError,
} from "../../src/automation/armSession.js";
import { runAutomationSession } from "../../src/automation/worker.js";
import { applySafeFillEnv, useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "ats", "greenhouse");
const GREENHOUSE_FIXTURE = path.join(FIXTURES, "dom.sanitized.html");
const CAPTCHA_FIXTURE = path.join(FIXTURES, "captcha-blocking-interstitial.html");
const SYNTHETIC_PDF = path.join(FIXTURES, "sample-resume.pdf");

/**
 * A7 integration passes over the whole armed-session story, all through the
 * real worker + pipeline against fixtures (FIXTURE_CONFIRMED). Submits stay
 * fail-closed (safe env) — what is under test is the session control flow:
 * expiry, walls, budget, disarm.
 */
describe("L3 session hardening (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let dbPath: string;
  let db: Db;
  const noSleep = async (): Promise<void> => undefined;

  function seedQueuedApp(): string {
    const jobNo = Math.floor(Math.random() * 1_000_000);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      company: `Acme${jobNo}`,
      role: "SWE",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = 'QUEUED' WHERE id = ?`).run(app.id);
    setEmployerApplicationUrl(db, app.id, `https://boards.greenhouse.io/acme/jobs/${jobNo}`);
    registerResumeMaterial({ db, applicationId: app.id, filePath: SYNTHETIC_PDF });
    return app.id;
  }

  function arm(maxSubmits = 5, maxApps = 25): string {
    return armSession(db, {
      maxSubmits,
      maxApps,
      durationMinutes: 60,
      discoverMax: 0,
      armedByTokenHash: hashArmToken("t"),
    }).arm_run_id!;
  }

  function expireArm(armId: string): void {
    const meta = JSON.parse(
      (
        db.prepare(`SELECT metadata_json AS m FROM automation_runs WHERE id = ?`).get(armId) as {
          m: string;
        }
      ).m,
    ) as Record<string, unknown>;
    meta["armed_until"] = new Date(Date.now() - 1000).toISOString();
    db.prepare(`UPDATE automation_runs SET metadata_json = ? WHERE id = ?`).run(
      JSON.stringify(meta),
      armId,
    );
  }

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-l3int-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    applySafeFillEnv();
    delete process.env.DATABASE_PATH;
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    resetConfigCache();
  });

  it(
    "expiry mid-batch: the in-flight app finishes, the rest stay parked, nothing runs past expiry",
    async () => {
      const first = seedQueuedApp();
      const second = seedQueuedApp();
      const armId = arm();

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        // The progress emit at the top of each iteration is the seam: as
        // soon as one app has been fully processed, force the window shut.
        onProgress: (p) => {
          if (p.apps_started === 1) expireArm(armId);
        },
      });

      expect(report.stopped_reason).toBe("expired");
      expect(report.apps_started).toBe(1);
      // First app completed its walk; the second was never started.
      expect(report.per_app.map((r) => r.application_id)).toEqual([first]);
      expect(getApplication(db, second)?.state).toBe("QUEUED");
      // The expired row was swept — status reads disarmed.
      expect(getArmStatus(db).armed).toBe(false);
    },
    60_000,
  );

  it(
    "disarm mid-run: soft stop after the current app",
    async () => {
      const first = seedQueuedApp();
      seedQueuedApp();
      const armId = arm();

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        onProgress: (p) => {
          if (p.apps_started === 1) disarmSession(db);
        },
      });

      expect(report.stopped_reason).toBe("disarmed");
      expect(report.apps_started).toBe(1);
      expect(report.per_app.map((r) => r.application_id)).toEqual([first]);
    },
    60_000,
  );

  it(
    "a CAPTCHA wall parks the app with a review item and the queue continues",
    async () => {
      const a1 = seedQueuedApp();
      const a2 = seedQueuedApp();
      const armId = arm();

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: CAPTCHA_FIXTURE,
        sleep: noSleep,
      });

      // Both apps were attempted — the first wall did not kill the loop —
      // and both parked at the CAPTCHA wall with review items.
      expect(report.apps_started).toBe(2);
      expect(report.stopped_reason).toBe("queue_drained");
      for (const id of [a1, a2]) {
        expect(getApplication(db, id)?.state).toBe("CAPTCHA_REQUIRED");
      }
      const items = listOpenReviewItems(db).filter((i) => i.kind === "CAPTCHA_REQUIRED");
      expect(items).toHaveLength(2);
      // Nothing was submitted past the wall.
      expect(report.submits_used).toBe(0);
    },
    60_000,
  );

  it(
    "budget exhausted is not a stop: apps keep filling and parking with submit off",
    async () => {
      const a1 = seedQueuedApp();
      const a2 = seedQueuedApp();
      const armId = arm(3, 25);
      // Simulate a session that already spent its whole submit budget.
      db.prepare(
        `UPDATE automation_runs SET unattended_submissions_count = max_unattended_submissions
         WHERE id = ?`,
      ).run(armId);

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
      });

      // Both apps still processed (fill-and-park), no submits attempted.
      expect(report.stopped_reason).toBe("queue_drained");
      expect(report.per_app.map((r) => r.application_id)).toEqual([a1, a2]);
      expect(report.submits_used).toBe(3); // unchanged — cap already spent
      expect(report.per_app.every((r) => !r.submitted)).toBe(true);
    },
    60_000,
  );

  it("noteArmError surfaces on the arm status and never gates anything", () => {
    const armId = arm();
    noteArmError(db, armId, "jobright_auth");
    const status = getArmStatus(db);
    expect(status.armed).toBe(true);
    expect(status.last_error_code).toBe("jobright_auth");
    // Caps and expiry are untouched by the error note.
    expect(status.max_submits).toBe(5);
    disarmSession(db);
    // A completed row silently ignores further notes.
    noteArmError(db, armId, "later");
    expect(getArmStatus(db).armed).toBe(false);
  });
});
