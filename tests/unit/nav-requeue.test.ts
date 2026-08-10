import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import {
  createApplication,
  getApplication,
  transitionApplication,
} from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { upsertOpenReviewItem } from "../../src/queue/reviewItems.js";
import { requeueNavStarvedApplications } from "../../src/automation/navRequeue.js";
import { applySafeFillEnv, useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * Second-chance requeue for agent-starved navigation parks — from session
 * edc4d38f, which drained an "empty" queue past seven FAILED_RETRYABLE
 * apps whose only problem was the previous session's missing agent leg.
 * UNIT_CONFIRMED.
 */
describe("nav-starved requeue (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    applySafeFillEnv();
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-navreq-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    resetConfigCache();
  });

  function seedFailedApp(reason: string): string {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      company: `Acme${Math.floor(Math.random() * 1_000_000)}`,
      role: "SWE",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = 'QUEUED' WHERE id = ?`).run(app.id);
    transitionApplication(db, {
      applicationId: app.id,
      nextState: "FAILED_RETRYABLE",
      reason,
    });
    return app.id;
  }

  it("requeues a budget-nav park exactly ONCE (permanent marker)", () => {
    const appId = seedFailedApp("navigation unresolved (budget)");
    const first = requeueNavStarvedApplications(db);
    expect(first.requeued).toBe(1);
    expect(getApplication(db, appId)?.state).toBe("QUEUED");
    const versions = JSON.parse(
      (db.prepare(`SELECT versions_json FROM applications WHERE id = ?`).get(appId) as { versions_json: string }).versions_json,
    ) as Record<string, unknown>;
    expect(versions["nav_agent_requeued"]).toBe(true);

    // Park it the same way again — the marker blocks a second requeue.
    transitionApplication(db, {
      applicationId: appId,
      nextState: "FAILED_RETRYABLE",
      reason: "navigation unresolved (budget)",
    });
    expect(requeueNavStarvedApplications(db).requeued).toBe(0);
    expect(getApplication(db, appId)?.state).toBe("FAILED_RETRYABLE");
  });

  it("only touches apps whose LATEST park was budget navigation", () => {
    seedFailedApp("operator confirmed no submission occurred (console)");
    seedFailedApp("navigation: resolved URL belongs to a different employer");
    const starved = seedFailedApp("navigation unresolved (budget)");
    const r = requeueNavStarvedApplications(db);
    expect(r.requeued).toBe(1);
    expect(getApplication(db, starved)?.state).toBe("QUEUED");
  });

  it("skips apps with open review items and excluded apps; honors the cap", () => {
    const withReview = seedFailedApp("navigation unresolved (budget)");
    upsertOpenReviewItem(db, {
      applicationId: withReview,
      kind: "MANUAL",
      title: "operator is looking at this",
      payload: {},
    });
    const excluded = seedFailedApp("navigation unresolved (budget)");
    db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(
      JSON.stringify({ automation_excluded: true }),
      excluded,
    );
    const plain = [
      seedFailedApp("navigation unresolved (budget)"),
      seedFailedApp("navigation unresolved (budget)"),
      seedFailedApp("navigation unresolved (budget)"),
    ];
    const r = requeueNavStarvedApplications(db, { cap: 2 });
    expect(r.requeued).toBe(2);
    expect(r.notes.join(" ")).toMatch(/cap 2 reached/);
    expect(getApplication(db, withReview)?.state).toBe("FAILED_RETRYABLE");
    expect(getApplication(db, excluded)?.state).toBe("FAILED_RETRYABLE");
    const states = plain.map((id) => getApplication(db, id)?.state);
    expect(states.filter((s) => s === "QUEUED").length).toBe(2);
  });
});
