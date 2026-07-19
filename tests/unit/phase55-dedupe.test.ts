import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resetConfigCache } from "../../src/config/index.js";
import { closeDatabase, migrate, openDatabase } from "../../src/storage/db/client.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { getOrCreateApplicationForJob } from "../../src/jobs/applicationDedupe.js";
import { runJobRightDiscovery } from "../../src/jobright/discoveryRun.js";
import { acquireLease, releaseLease, LeaseError } from "../../src/queue/leases.js";

const feedFixture = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "jobright",
  "job-feed",
  "dom.sanitized.html",
);

describe("Phase 5.5 application dedupe", () => {
  let dbPath: string;
  let prevDb: string | undefined;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-dedupe-${randomUUID()}.sqlite`);
    prevDb = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
  });

  afterEach(() => {
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    resetConfigCache();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(`${dbPath}-wal`);
      fs.unlinkSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it("creates one application then reuses on second discovery", async () => {
    const first = await runJobRightDiscovery({
      feedHtmlPath: feedFixture,
      maxJobs: 3,
    });
    expect(first.applications.length).toBeGreaterThan(0);
    const created = first.applications.filter((a) => a.dedupe_kind === "CREATED");
    expect(created.length).toBeGreaterThan(0);

    const second = await runJobRightDiscovery({
      feedHtmlPath: feedFixture,
      maxJobs: 3,
    });
    expect(second.jobs_reused).toBeGreaterThan(0);
    expect(second.applications.every((a) => a.dedupe_kind !== "CREATED")).toBe(
      true,
    );

    const db = openDatabase(dbPath);
    migrate(db);
    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM applications`).get() as { n: number }
    ).n;
    closeDatabase(db);
    expect(count).toBe(first.applications.length);
  });

  it("getOrCreateApplicationForJob returns EXISTING_ACTIVE", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      company: "Acme",
      role: "Intern",
      jobrightJobId: "abc123",
      applicationUrl: "https://example.com/jobs/1",
    });
    const a = getOrCreateApplicationForJob(db, { jobId: job.id });
    expect(a.kind).toBe("CREATED");
    const b = getOrCreateApplicationForJob(db, { jobId: job.id });
    expect(b.kind).toBe("EXISTING_ACTIVE");
    expect(b.applicationId).toBe(a.applicationId);
    closeDatabase(db);
  });

  it("lease blocks duplicate worker", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    acquireLease(db, {
      resourceType: "application",
      resourceId: "app1:fill",
      holderRunId: "worker-a",
      ttlMs: 60_000,
    });
    expect(() =>
      acquireLease(db, {
        resourceType: "application",
        resourceId: "app1:fill",
        holderRunId: "worker-b",
        ttlMs: 60_000,
      }),
    ).toThrow(LeaseError);
    releaseLease(db, {
      resourceType: "application",
      resourceId: "app1:fill",
      holderRunId: "worker-a",
    });
    const again = acquireLease(db, {
      resourceType: "application",
      resourceId: "app1:fill",
      holderRunId: "worker-b",
      ttlMs: 60_000,
    });
    expect(again.holder_run_id).toBe("worker-b");
    closeDatabase(db);
  });
});
