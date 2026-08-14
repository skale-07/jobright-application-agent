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
import { setEmployerApplicationUrl } from "../../src/pipeline/runPipeline.js";
import {
  clearSkipRequest,
  getSkipRequest,
  isSkipRequested,
  requestSkip,
  unskip,
} from "../../src/automation/skipRequests.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * "add functionality to add a skip button if the agent is stuck on the
 *  current job" — operator, 2026-08-14.
 *
 * Excluding an app from automation already existed but is only read when
 * the worker PICKS one. Once a pipeline was running, nothing could redirect
 * it — a job stuck behind a slow typeahead held the armed session until its
 * own timeouts expired. Skip is a cooperative signal the pipeline reads
 * between steps.
 */
describe("operator skip (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let dbPath: string;
  let db: Db;

  function seedApp(): string {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      company: "Acme",
      role: "SWE",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = 'QUEUED' WHERE id = ?`).run(app.id);
    setEmployerApplicationUrl(db, app.id, "https://boards.greenhouse.io/acme/jobs/1");
    return app.id;
  }

  function versions(id: string): Record<string, unknown> {
    const row = db
      .prepare(`SELECT versions_json FROM applications WHERE id = ?`)
      .get(id) as { versions_json: string };
    return JSON.parse(row.versions_json) as Record<string, unknown>;
  }

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-skip-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
  });

  it("records a skip request the pipeline can see", () => {
    const id = seedApp();
    expect(isSkipRequested(db, id)).toBe(false);
    expect(requestSkip(db, id, "stuck on a dropdown")).toBe(true);
    expect(isSkipRequested(db, id)).toBe(true);
    expect(getSkipRequest(db, id)?.reason).toBe("stuck on a dropdown");
  });

  it("a skip the worker would immediately re-pick is not a skip", () => {
    const id = seedApp();
    requestSkip(db, id);
    // Selection reads automation_excluded — skipping must set it, or the
    // next lap of the loop picks the same stuck job straight back up.
    expect(versions(id)["automation_excluded"]).toBe(true);
  });

  it("clearing the acted-on request KEEPS the exclusion", () => {
    const id = seedApp();
    requestSkip(db, id);
    clearSkipRequest(db, id);
    // The marker is spent so it cannot re-fire...
    expect(isSkipRequested(db, id)).toBe(false);
    // ...but the operator said not this one, and only the operator (via the
    // include toggle) says otherwise.
    expect(versions(id)["automation_excluded"]).toBe(true);
  });

  it("undo re-includes the application", () => {
    const id = seedApp();
    requestSkip(db, id);
    expect(unskip(db, id)).toBe(true);
    expect(isSkipRequested(db, id)).toBe(false);
    expect(versions(id)["automation_excluded"]).toBe(false);
  });

  it("skipping never changes the application's state", () => {
    const id = seedApp();
    const before = (
      db.prepare(`SELECT state FROM applications WHERE id = ?`).get(id) as {
        state: string;
      }
    ).state;
    requestSkip(db, id);
    const after = (
      db.prepare(`SELECT state FROM applications WHERE id = ?`).get(id) as {
        state: string;
      }
    ).state;
    // The app keeps whatever it reached so the operator can inspect it,
    // fix what was wrong, and re-include it later.
    expect(after).toBe(before);
  });

  it("preserves unrelated keys in versions_json", () => {
    const id = seedApp();
    db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(
      JSON.stringify({ resume_version: "v3" }),
      id,
    );
    requestSkip(db, id);
    expect(versions(id)["resume_version"]).toBe("v3");
  });

  it("reports missing applications instead of silently succeeding", () => {
    expect(requestSkip(db, randomUUID())).toBe(false);
    expect(unskip(db, randomUUID())).toBe(false);
    expect(getSkipRequest(db, randomUUID())).toBeNull();
  });
});

/**
 * The pipeline honours the signal at a STEP BOUNDARY — never mid-transition,
 * so a form is never left half-filled and a submit in flight is never
 * abandoned mid-click.
 */
describe("pipeline skip checkpoint (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-skip-pipe-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
  });

  it("stops the walk with stopped=skipped and leaves the state untouched", async () => {
    const { runPipeline } = await import("../../src/pipeline/runPipeline.js");
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      company: "Acme",
      role: "SWE",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = 'QUEUED' WHERE id = ?`).run(app.id);

    const report = await runPipeline({
      db,
      applicationId: app.id,
      shouldSkip: () => true,
    });
    const appReport = report.applications[0];
    expect(appReport?.stopped).toBe("skipped");
    expect(appReport?.stop_reason).toMatch(/operator skipped/);
    // Nothing advanced: the skip fired before the first transition.
    expect(appReport?.end_state).toBe("QUEUED");
    expect(
      (
        db.prepare(`SELECT state FROM applications WHERE id = ?`).get(app.id) as {
          state: string;
        }
      ).state,
    ).toBe("QUEUED");
  }, 30_000);

  it("does not interfere when no skip is requested", async () => {
    const { runPipeline } = await import("../../src/pipeline/runPipeline.js");
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      company: "Acme",
      role: "SWE",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = 'QUEUED' WHERE id = ?`).run(app.id);

    const report = await runPipeline({
      db,
      applicationId: app.id,
      shouldSkip: () => false,
    });
    expect(report.applications[0]?.stopped).not.toBe("skipped");
  }, 30_000);
});
