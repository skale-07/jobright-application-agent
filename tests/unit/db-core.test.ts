import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createApplication, transitionApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import {
  computeJobFingerprint,
  normalizeApplicationUrl,
} from "../../src/jobs/fingerprint.js";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  IdempotencyConflictError,
  markIdempotencyUncertain,
} from "../../src/queue/idempotency.js";
import { acquireLease, LeaseError, purgeExpiredLeases, releaseLease } from "../../src/queue/leases.js";
import { createReviewItem, listOpenReviewItems, resolveReviewItem } from "../../src/queue/reviewItems.js";
import {
  assertSubmissionAllowed,
} from "../../src/applications/submissionGuards.js";
import { randomUUID } from "node:crypto";
import { resetConfigCache } from "../../src/config/index.js";

describe("phase1 database core", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-test-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const wal = `${dbPath}-wal`;
    const shm = `${dbPath}-shm`;
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
  });

  it("applies initial migration once", () => {
    const again = migrate(db);
    expect(again).toEqual([]);
    const versions = db
      .prepare("SELECT version FROM schema_migrations")
      .all() as Array<{ version: string }>;
    expect(versions.some((v) => v.version === "001_initial.sql")).toBe(true);
  });

  it("computes stable job fingerprints and upserts uniquely", () => {
    const fp1 = computeJobFingerprint({
      jobrightJobId: "jr-123",
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1?utm_source=x",
      company: "Acme",
      role: "Software Engineering Intern",
    });
    const fp2 = computeJobFingerprint({
      jobrightJobId: "jr-123",
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      role: "Software Engineering Intern",
    });
    // URL normalization drops utm — fingerprints match when other fields match
    expect(normalizeApplicationUrl("https://boards.greenhouse.io/acme/jobs/1?utm_source=x")).toBe(
      normalizeApplicationUrl("https://boards.greenhouse.io/acme/jobs/1"),
    );
    expect(fp1).toBe(fp2);

    const job = upsertJobByFingerprint(db, {
      jobrightJobId: "jr-123",
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1?utm_source=x",
      company: "Acme",
      role: "Software Engineering Intern",
    });
    const again = upsertJobByFingerprint(db, {
      jobrightJobId: "jr-123",
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      role: "Software Engineering Intern",
    });
    expect(again.id).toBe(job.id);
    const count = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("transitions application state transactionally", () => {
    const job = upsertJobByFingerprint(db, {
      company: "Acme",
      role: "Intern",
      jobrightJobId: "j1",
    });
    const app = createApplication(db, { jobId: job.id });
    expect(app.state).toBe("DISCOVERED");
    const next = transitionApplication(db, {
      applicationId: app.id,
      nextState: "DUPLICATE_CHECK",
      reason: "start",
    });
    expect(next.state).toBe("DUPLICATE_CHECK");
    expect(() =>
      transitionApplication(db, {
        applicationId: app.id,
        nextState: "SUBMITTED",
      }),
    ).toThrow(/Invalid state transition/);
  });

  it("enforces idempotency including uncertain block", () => {
    const key = "submission:{application_id=a1;form=abc}";
    const claim = claimIdempotencyKey(db, key, { holderRunId: "run-1" });
    expect(claim.action).toBe("execute");
    completeIdempotencyKey(db, key, "sub-1");
    const skip = claimIdempotencyKey(db, key, { holderRunId: "run-2" });
    expect(skip.action).toBe("skip");

    const key2 = "submission:{application_id=a2;form=def}";
    claimIdempotencyKey(db, key2, { holderRunId: "run-1" });
    markIdempotencyUncertain(db, key2, "maybe");
    expect(() => claimIdempotencyKey(db, key2, { holderRunId: "run-2" })).toThrow(
      IdempotencyConflictError,
    );
  });

  it("acquires and expires leases", () => {
    const lease = acquireLease(db, {
      resourceType: "application",
      resourceId: "app-1",
      holderRunId: "run-a",
      ttlMs: 60_000,
    });
    expect(lease.holder_run_id).toBe("run-a");
    expect(() =>
      acquireLease(db, {
        resourceType: "application",
        resourceId: "app-1",
        holderRunId: "run-b",
        ttlMs: 60_000,
      }),
    ).toThrow(LeaseError);

    releaseLease(db, {
      resourceType: "application",
      resourceId: "app-1",
      holderRunId: "run-a",
    });

    acquireLease(db, {
      resourceType: "application",
      resourceId: "app-1",
      holderRunId: "run-b",
      ttlMs: 1,
    });
    // force expiry
    db.prepare(`UPDATE leases SET expires_at = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(purgeExpiredLeases(db)).toBeGreaterThanOrEqual(1);
  });

  it("tracks review items", () => {
    const item = createReviewItem(db, {
      kind: "UNCERTAIN_SUBMISSION",
      title: "Need human confirmation",
      payload: { note: "test" },
    });
    expect(listOpenReviewItems(db).some((r) => r.id === item.id)).toBe(true);
    resolveReviewItem(db, item.id, { ok: true });
    expect(listOpenReviewItems(db).some((r) => r.id === item.id)).toBe(false);
  });

  it("blocks auto-submit when verified or uncertain submission exists", () => {
    const job = upsertJobByFingerprint(db, {
      company: "Acme",
      role: "Intern",
      jobrightJobId: "j2",
    });
    const app = createApplication(db, { jobId: job.id });
    assertSubmissionAllowed(db, app.id);

    db.prepare(
      `INSERT INTO submissions (
        id, application_id, submission_attempt_number, status, submitted,
        receipt_json
      ) VALUES (?, ?, 1, 'UNCERTAIN', 0, '{}')`,
    ).run(randomUUID(), app.id);

    expect(() => assertSubmissionAllowed(db, app.id)).toThrow(/uncertain/i);

    db.prepare(`DELETE FROM submissions WHERE application_id = ?`).run(app.id);
    db.prepare(
      `INSERT INTO submissions (
        id, application_id, submission_attempt_number, status, submitted,
        receipt_json
      ) VALUES (?, ?, 1, 'VERIFIED', 1, '{}')`,
    ).run(randomUUID(), app.id);

    expect(() => assertSubmissionAllowed(db, app.id)).toThrow(/already has verified/);

    // Second verified insert must fail unique index
    expect(() =>
      db
        .prepare(
          `INSERT INTO submissions (
            id, application_id, submission_attempt_number, status, submitted,
            receipt_json
          ) VALUES (?, ?, 2, 'VERIFIED', 1, '{}')`,
        )
        .run(randomUUID(), app.id),
    ).toThrow();
  });
});
