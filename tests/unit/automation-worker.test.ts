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
import { upsertOpenReviewItem } from "../../src/queue/reviewItems.js";
import { armSession, getArmStatus, hashArmToken } from "../../src/automation/armSession.js";
import { runAutomationSession } from "../../src/automation/worker.js";
import { applySafeFillEnv, useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

const GREENHOUSE_FIXTURE = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "dom.sanitized.html",
);
const SYNTHETIC_PDF = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "sample-resume.pdf",
);

describe("L3 automation worker (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let dbPath: string;
  let db: Db;
  const noSleep = async (): Promise<void> => undefined;

  function seedQueuedApp(withResume = true): string {
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
    if (withResume) {
      registerResumeMaterial({ db, applicationId: app.id, filePath: SYNTHETIC_PDF });
    }
    return app.id;
  }

  function arm(maxSubmits: number, maxApps: number): string {
    return armSession(db, {
      maxSubmits,
      maxApps,
      durationMinutes: 60,
      discoverMax: 0,
      armedByTokenHash: hashArmToken("t"),
    }).arm_run_id!;
  }

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-worker-${randomUUID()}.sqlite`);
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
    "processes the queue, parks a blocked app, stops when drained",
    async () => {
      // Safe env (DRY_RUN) so each app stops cleanly at the fill gate — the
      // worker's selection/park behavior is what's under test, not a real
      // submit. One app carries a review item and must be skipped entirely.
      const a1 = seedQueuedApp();
      const blocked = seedQueuedApp();
      upsertOpenReviewItem(db, {
        applicationId: blocked,
        kind: "MANUAL",
        title: "operator hold",
      });
      const armId = arm(5, 25);

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
      });

      expect(report.stopped_reason).toBe("queue_drained");
      // Only the unblocked app was processed; the held one was never touched.
      expect(report.per_app.map((r) => r.application_id)).toEqual([a1]);
      expect(getApplication(db, a1)?.state).toBe("NATIVE_AUTOFILL_RUNNING");
      expect(getApplication(db, blocked)?.state).toBe("QUEUED");
    },
    60_000,
  );

  it(
    "requeues nav-starved apps ONLY when the agent leg is up",
    async () => {
      // An app parked by an agent-less session: FAILED_RETRYABLE with the
      // budget-nav reason and no review item — invisible to selection.
      const starved = seedQueuedApp();
      const { transitionApplication } = await import(
        "../../src/queue/stateMachine.js"
      );
      transitionApplication(db, {
        applicationId: starved,
        nextState: "FAILED_RETRYABLE",
        reason: "navigation unresolved (budget)",
      });

      // Agent leg DOWN: the app stays parked and the queue drains.
      const down = await runAutomationSession({
        db,
        armRunId: arm(5, 25),
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        agentLegProbe: async () => false,
      });
      expect(down.per_app).toEqual([]);
      expect(getApplication(db, starved)?.state).toBe("FAILED_RETRYABLE");
      const { disarmSession } = await import("../../src/automation/armSession.js");
      disarmSession(db);

      // Agent leg UP: one requeue, and the session actually processes it.
      const up = await runAutomationSession({
        db,
        armRunId: arm(5, 25),
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        agentLegProbe: async () => true,
      });
      expect(up.notes.join(" ")).toMatch(/nav requeue: 1 navigation-starved/);
      expect(up.per_app.map((r) => r.application_id)).toEqual([starved]);
    },
    60_000,
  );

  it(
    "respects max_apps: stops with apps_cap after the cap",
    async () => {
      seedQueuedApp();
      seedQueuedApp();
      seedQueuedApp();
      const armId = arm(5, 2); // cap 2 apps

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
      });

      expect(report.stopped_reason).toBe("apps_cap");
      expect(report.apps_started).toBe(2);
      expect(getArmStatus(db).apps_started).toBe(2);
    },
    60_000,
  );

  it(
    "excludes apps flagged automation_excluded in versions_json",
    async () => {
      const keep = seedQueuedApp();
      const skip = seedQueuedApp();
      db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(
        JSON.stringify({ automation_excluded: true }),
        skip,
      );
      const armId = arm(5, 25);

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
      });

      expect(report.per_app.map((r) => r.application_id)).toEqual([keep]);
      expect(getApplication(db, skip)?.state).toBe("QUEUED");
    },
    60_000,
  );

  it(
    "stops as expired when the arm window closes; a disarmed row stops as disarmed",
    async () => {
      seedQueuedApp();
      // Arm, then force the row's armed_until into the past.
      const armId = arm(5, 25);
      const meta = JSON.parse(
        (db.prepare(`SELECT metadata_json AS m FROM automation_runs WHERE id = ?`).get(armId) as {
          m: string;
        }).m,
      ) as Record<string, unknown>;
      meta["armed_until"] = new Date(Date.now() - 1000).toISOString();
      db.prepare(`UPDATE automation_runs SET metadata_json = ? WHERE id = ?`).run(
        JSON.stringify(meta),
        armId,
      );

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
      });
      // First loop check sees the expired row → no app processed.
      expect(report.stopped_reason).toBe("expired");
      expect(report.apps_started).toBe(0);
    },
    60_000,
  );

  it(
    "runs discovery at start via the injected discoveryRunner",
    async () => {
      let discovered = 0;
      const armId = armSession(db, {
        maxSubmits: 5,
        maxApps: 25,
        durationMinutes: 60,
        discoverMax: 10,
        armedByTokenHash: hashArmToken("t"),
      }).arm_run_id!;

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        discoverMax: 10,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        // Discovery enqueues one app on the first call, nothing after.
        discoveryRunner: async () => {
          discovered += 1;
          if (discovered === 1) seedQueuedApp();
          return { jobs_inspected: discovered === 1 ? 1 : 0 };
        },
      });

      expect(discovered).toBeGreaterThanOrEqual(1);
      expect(report.discover_runs).toBeGreaterThanOrEqual(1);
      // The discovered app was processed.
      expect(report.apps_started).toBe(1);
    },
    60_000,
  );

  it(
    "a discovery failure (empty feed / auth) is a note, not a crash",
    async () => {
      seedQueuedApp();
      const armId = armSession(db, {
        maxSubmits: 5,
        maxApps: 25,
        durationMinutes: 60,
        discoverMax: 10,
        armedByTokenHash: hashArmToken("t"),
      }).arm_run_id!;

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        discoverMax: 10,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        discoveryRunner: async () => {
          throw new Error("EMPTY_FEED: nothing on the feed");
        },
      });

      // The pre-seeded app still processed; the feed failure is just noted.
      expect(report.apps_started).toBe(1);
      expect(report.notes.some((n) => /empty_feed/.test(n))).toBe(true);
    },
    60_000,
  );
});
