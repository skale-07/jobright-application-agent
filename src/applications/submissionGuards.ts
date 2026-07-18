import type { Db } from "../storage/db/client.js";

/**
 * Enforces verified-submission uniqueness at the application layer
 * in addition to the partial unique index.
 */
export function assertNoVerifiedSubmission(
  db: Db,
  applicationId: string,
): void {
  const row = db
    .prepare(
      `SELECT id FROM submissions
       WHERE application_id = ? AND status = 'VERIFIED' AND submitted = 1
       LIMIT 1`,
    )
    .get(applicationId) as { id: string } | undefined;
  if (row) {
    throw new Error(
      `Application ${applicationId} already has verified submission ${row.id}`,
    );
  }
}

export function hasUncertainSubmission(
  db: Db,
  applicationId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT id FROM submissions
       WHERE application_id = ? AND status = 'UNCERTAIN'
       LIMIT 1`,
    )
    .get(applicationId) as { id: string } | undefined;
  return Boolean(row);
}

export function assertSubmissionAllowed(
  db: Db,
  applicationId: string,
): void {
  assertNoVerifiedSubmission(db, applicationId);
  if (hasUncertainSubmission(db, applicationId)) {
    throw new Error(
      `Application ${applicationId} has an uncertain submission — human review required; auto-resubmit blocked`,
    );
  }
}
