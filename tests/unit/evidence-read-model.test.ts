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
  insertPendingSubmission,
  markSubmissionVerified,
} from "../../src/queue/submissionsRepo.js";
import { listSubmissionRows } from "../../src/dashboard/reportData.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * The console renders the receipt, not a checkmark — which only works if
 * the read model carries the evidence. This is the contract behind
 * Home's submitted list: the screenshot path and the confirmation URL
 * travel with every submission row. Drop either column and the UI
 * silently degrades back to "we submitted, trust us". UNIT_CONFIRMED.
 */

describe("submission read model carries its evidence (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let applicationId: string;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-evidence-${randomUUID()}.sqlite`);
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

  it("a verified submission row reaches the console with its receipt", () => {
    const pending = insertPendingSubmission(db, { applicationId });
    markSubmissionVerified(db, pending.id, {
      submitted: true,
      submitted_at: new Date().toISOString(),
      confirmation_url: "https://boards.greenhouse.io/acme/confirmation",
      confirmation_text: "Thank you for applying",
      application_identifier: "GH-123",
      screenshot_path: "artifacts/ats-submit/generic/receipt-attempt-1.png",
    });

    const rows = listSubmissionRows(db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row["screenshot_path"]).toBe(
      "artifacts/ats-submit/generic/receipt-attempt-1.png",
    );
    expect(row["confirmation_url"]).toBe(
      "https://boards.greenhouse.io/acme/confirmation",
    );
    // The identity the operator reads on the receipt line.
    expect(row["company"]).toBe("Acme");
    expect(row["role"]).toBe("Software Engineering Intern");
  });

  it("a submission with no receipt yet returns the column as null, not missing", () => {
    // A pending attempt has no screenshot. Absence of evidence is a fact
    // about the evidence, not about whether anything was sent, so the UI
    // has to be able to tell the two apart — which needs the key present
    // and null rather than the column absent from the row.
    insertPendingSubmission(db, { applicationId });
    const row = listSubmissionRows(db)[0]!;
    expect(row["submitted"]).toBe(0);
    expect(row).toHaveProperty("screenshot_path");
    expect(row["screenshot_path"]).toBeNull();
    expect(row).toHaveProperty("confirmation_url");
  });
});
