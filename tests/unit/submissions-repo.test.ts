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
import { canTransition } from "../../src/queue/states.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import {
  getLatestUncertainSubmission,
  getSubmission,
  getSubmissionsForApplication,
  insertPendingSubmission,
  markSubmissionFailed,
  markSubmissionUncertain,
  markSubmissionVerified,
  nextSubmissionAttemptNumber,
} from "../../src/queue/submissionsRepo.js";
import {
  assertNoVerifiedSubmission,
  assertSubmissionAllowed,
} from "../../src/applications/submissionGuards.js";
import type { SubmissionReceipt } from "../../src/ats/adapter.js";
import { resetConfigCache } from "../../src/config/index.js";

function receipt(overrides: Partial<SubmissionReceipt> = {}): SubmissionReceipt {
  return {
    submitted: true,
    submitted_at: new Date().toISOString(),
    confirmation_url: "https://boards.greenhouse.io/acme/confirmation",
    confirmation_text: "Thank you for applying",
    application_identifier: "GH-123",
    screenshot_path: "/artifacts/apps/x/submission/receipt.png",
    ...overrides,
  };
}

describe("submissions repo (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let applicationId: string;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-subs-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      role: "Software Engineering Intern",
    });
    applicationId = createApplication(db, { jobId: job.id }).id;
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("attempt numbers are monotonically assigned per application", () => {
    expect(nextSubmissionAttemptNumber(db, applicationId)).toBe(1);
    const first = insertPendingSubmission(db, { applicationId });
    expect(first.submission_attempt_number).toBe(1);
    const second = insertPendingSubmission(db, { applicationId });
    expect(second.submission_attempt_number).toBe(2);
  });

  it("PENDING row exists before any outcome — crash evidence", () => {
    const { id } = insertPendingSubmission(db, {
      applicationId,
      formSnapshotHash: "abc123",
    });
    const row = getSubmission(db, id);
    expect(row?.status).toBe("PENDING");
    expect(row?.submitted).toBe(0);
    expect(row?.form_snapshot_hash).toBe("abc123");
  });

  it("verified receipt persists all receipt fields", () => {
    const { id } = insertPendingSubmission(db, { applicationId });
    const r = receipt();
    markSubmissionVerified(db, id, r);
    const row = getSubmission(db, id);
    expect(row?.status).toBe("VERIFIED");
    expect(row?.submitted).toBe(1);
    expect(row?.confirmation_text).toBe("Thank you for applying");
    expect(row?.application_identifier).toBe("GH-123");
    expect(JSON.parse(row!.receipt_json)).toMatchObject({
      confirmation_url: r.confirmation_url,
    });
  });

  it("second VERIFIED submission for the same application is impossible", () => {
    const a = insertPendingSubmission(db, { applicationId });
    markSubmissionVerified(db, a.id, receipt());
    // Application-layer guard fires first…
    expect(() => assertNoVerifiedSubmission(db, applicationId)).toThrow(
      /already has verified submission/,
    );
    // …and the partial unique index backstops it at the SQLite layer.
    const b = insertPendingSubmission(db, { applicationId });
    expect(() => markSubmissionVerified(db, b.id, receipt())).toThrow();
  });

  it("UNCERTAIN row blocks resubmission via assertSubmissionAllowed", () => {
    const { id } = insertPendingSubmission(db, { applicationId });
    markSubmissionUncertain(db, id, { note: "no confirmation page" });
    expect(() => assertSubmissionAllowed(db, applicationId)).toThrow(
      /uncertain submission/i,
    );
    expect(getLatestUncertainSubmission(db, applicationId)?.id).toBe(id);
  });

  it("FAILED rows do not block a new attempt", () => {
    const { id } = insertPendingSubmission(db, { applicationId });
    markSubmissionFailed(db, id, "network error before click");
    expect(() => assertSubmissionAllowed(db, applicationId)).not.toThrow();
    expect(getSubmissionsForApplication(db, applicationId)).toHaveLength(1);
  });
});

describe("uncertain-resolution state edges (UNIT_CONFIRMED)", () => {
  it("SUBMISSION_VERIFICATION_FAILED can resolve to SUBMITTED or requeue", () => {
    expect(canTransition("SUBMISSION_VERIFICATION_FAILED", "SUBMITTED")).toBe(
      true,
    );
    expect(
      canTransition("SUBMISSION_VERIFICATION_FAILED", "FAILED_RETRYABLE"),
    ).toBe(true);
    expect(
      canTransition("SUBMISSION_VERIFICATION_FAILED", "FAILED_FINAL"),
    ).toBe(true);
  });

  it("does not open illegal shortcuts", () => {
    expect(
      canTransition("SUBMISSION_VERIFICATION_FAILED", "SUBMITTING"),
    ).toBe(false);
    expect(
      canTransition("SUBMISSION_VERIFICATION_FAILED", "READY_TO_SUBMIT"),
    ).toBe(false);
    expect(canTransition("SUBMITTED", "SUBMITTING")).toBe(false);
    expect(canTransition("COMPLETED", "SUBMITTED")).toBe(false);
  });
});
