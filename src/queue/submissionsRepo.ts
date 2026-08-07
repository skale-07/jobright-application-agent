import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import type { SubmissionReceipt } from "../ats/adapter.js";

export type SubmissionStatus = "PENDING" | "VERIFIED" | "UNCERTAIN" | "FAILED";

export type SubmissionRow = {
  id: string;
  application_id: string;
  submission_attempt_number: number;
  status: SubmissionStatus;
  submitted: number;
  submitted_at: string | null;
  confirmation_url: string | null;
  confirmation_text: string | null;
  application_identifier: string | null;
  screenshot_path: string | null;
  form_snapshot_hash: string | null;
  receipt_json: string;
};

/**
 * The submissions writer. Every row starts PENDING before any click happens,
 * so a crash mid-submit leaves evidence that an attempt was in flight.
 * The partial unique index submissions_verified_unique enforces at most one
 * VERIFIED+submitted row per application at the SQLite layer.
 */
export function nextSubmissionAttemptNumber(
  db: Db,
  applicationId: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(submission_attempt_number), 0) AS max_attempt
       FROM submissions WHERE application_id = ?`,
    )
    .get(applicationId) as { max_attempt: number };
  return row.max_attempt + 1;
}

export function insertPendingSubmission(
  db: Db,
  input: {
    applicationId: string;
    formSnapshotHash?: string;
  },
): { id: string; submission_attempt_number: number } {
  const id = randomUUID();
  const attempt = nextSubmissionAttemptNumber(db, input.applicationId);
  db.prepare(
    `INSERT INTO submissions (
      id, application_id, submission_attempt_number, status, submitted,
      form_snapshot_hash, receipt_json
    ) VALUES (?, ?, ?, 'PENDING', 0, ?, '{}')`,
  ).run(id, input.applicationId, attempt, input.formSnapshotHash ?? null);
  return { id, submission_attempt_number: attempt };
}

export function markSubmissionVerified(
  db: Db,
  id: string,
  receipt: SubmissionReceipt,
): void {
  db.prepare(
    `UPDATE submissions SET
      status = 'VERIFIED',
      submitted = 1,
      submitted_at = ?,
      confirmation_url = ?,
      confirmation_text = ?,
      application_identifier = ?,
      screenshot_path = ?,
      receipt_json = ?
     WHERE id = ?`,
  ).run(
    receipt.submitted_at,
    receipt.confirmation_url,
    receipt.confirmation_text,
    receipt.application_identifier,
    receipt.screenshot_path,
    JSON.stringify(receipt),
    id,
  );
}

export function markSubmissionUncertain(
  db: Db,
  id: string,
  evidence: Record<string, unknown>,
): void {
  db.prepare(
    `UPDATE submissions SET
      status = 'UNCERTAIN',
      submitted = 0,
      receipt_json = ?
     WHERE id = ?`,
  ).run(JSON.stringify(evidence), id);
}

export function markSubmissionFailed(db: Db, id: string, reason: string): void {
  db.prepare(
    `UPDATE submissions SET
      status = 'FAILED',
      submitted = 0,
      receipt_json = ?
     WHERE id = ?`,
  ).run(JSON.stringify({ reason }), id);
}

export function getSubmission(db: Db, id: string): SubmissionRow | undefined {
  return db.prepare(`SELECT * FROM submissions WHERE id = ?`).get(id) as
    | SubmissionRow
    | undefined;
}

export function getSubmissionsForApplication(
  db: Db,
  applicationId: string,
): SubmissionRow[] {
  return db
    .prepare(
      `SELECT * FROM submissions
       WHERE application_id = ?
       ORDER BY submission_attempt_number ASC`,
    )
    .all(applicationId) as SubmissionRow[];
}

/** Latest UNCERTAIN row for operator resolution (review:resolve). */
export function getLatestUncertainSubmission(
  db: Db,
  applicationId: string,
): SubmissionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM submissions
       WHERE application_id = ? AND status = 'UNCERTAIN'
       ORDER BY submission_attempt_number DESC
       LIMIT 1`,
    )
    .get(applicationId) as SubmissionRow | undefined;
}
