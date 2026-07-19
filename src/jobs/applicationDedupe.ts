import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import {
  createApplication,
  getApplication,
  type ApplicationRow,
} from "../queue/stateMachine.js";
import {
  assertNoVerifiedSubmission,
  hasUncertainSubmission,
} from "../applications/submissionGuards.js";

/** States that are not "active" — a new application may be created for the same job. */
export const TERMINAL_APPLICATION_STATES = [
  "COMPLETED",
  "FAILED_FINAL",
  "FILTERED_OUT",
] as const;

export type ApplicationDeduplicationResult =
  | { kind: "CREATED"; applicationId: string; application: ApplicationRow }
  | { kind: "EXISTING_ACTIVE"; applicationId: string; application: ApplicationRow }
  | {
      kind: "ALREADY_VERIFIED_SUBMITTED";
      applicationId: string;
      application: ApplicationRow;
    }
  | {
      kind: "UNCERTAIN_SUBMISSION";
      applicationId: string;
      application: ApplicationRow;
    };

function findActiveApplication(
  db: Db,
  jobId: string,
): ApplicationRow | undefined {
  return db
    .prepare(
      `SELECT * FROM applications
       WHERE job_id = ?
         AND state NOT IN ('COMPLETED', 'FAILED_FINAL', 'FILTERED_OUT')
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(jobId) as ApplicationRow | undefined;
}

function findLatestApplication(
  db: Db,
  jobId: string,
): ApplicationRow | undefined {
  return db
    .prepare(
      `SELECT * FROM applications WHERE job_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(jobId) as ApplicationRow | undefined;
}

function hasVerifiedSubmission(db: Db, applicationId: string): boolean {
  try {
    assertNoVerifiedSubmission(db, applicationId);
    return false;
  } catch {
    return true;
  }
}

/**
 * Transactional get-or-create for discovery.
 * Enforced by partial unique index applications_one_active_per_job.
 */
export function getOrCreateApplicationForJob(
  db: Db,
  input: {
    jobId: string;
    versions?: Record<string, unknown>;
  },
): ApplicationDeduplicationResult {
  const run = db.transaction(() => {
    const active = findActiveApplication(db, input.jobId);
    if (active) {
      if (hasVerifiedSubmission(db, active.id)) {
        return {
          kind: "ALREADY_VERIFIED_SUBMITTED" as const,
          applicationId: active.id,
          application: active,
        };
      }
      if (hasUncertainSubmission(db, active.id)) {
        return {
          kind: "UNCERTAIN_SUBMISSION" as const,
          applicationId: active.id,
          application: active,
        };
      }
      return {
        kind: "EXISTING_ACTIVE" as const,
        applicationId: active.id,
        application: active,
      };
    }

    // Also block if latest terminal app has verified/uncertain submission
    const latest = findLatestApplication(db, input.jobId);
    if (latest) {
      if (hasVerifiedSubmission(db, latest.id)) {
        return {
          kind: "ALREADY_VERIFIED_SUBMITTED" as const,
          applicationId: latest.id,
          application: latest,
        };
      }
      if (hasUncertainSubmission(db, latest.id)) {
        return {
          kind: "UNCERTAIN_SUBMISSION" as const,
          applicationId: latest.id,
          application: latest,
        };
      }
    }

    try {
      const app = createApplication(db, {
        jobId: input.jobId,
        ...(input.versions ? { versions: input.versions } : {}),
      });
      return {
        kind: "CREATED" as const,
        applicationId: app.id,
        application: app,
      };
    } catch (err) {
      // Race: another worker inserted an active row
      const raced = findActiveApplication(db, input.jobId);
      if (raced) {
        return {
          kind: "EXISTING_ACTIVE" as const,
          applicationId: raced.id,
          application: raced,
        };
      }
      throw err;
    }
  });

  return run();
}

export function jobHasVerifiedSubmission(db: Db, jobId: string): boolean {
  const apps = db
    .prepare(`SELECT id FROM applications WHERE job_id = ?`)
    .all(jobId) as Array<{ id: string }>;
  return apps.some((a) => hasVerifiedSubmission(db, a.id));
}

/** Stable owner id for discovery lease. */
export function newDiscoveryRunId(): string {
  return `discovery:${randomUUID()}`;
}

export function getApplicationOrThrow(db: Db, id: string): ApplicationRow {
  const row = getApplication(db, id);
  if (!row) throw new Error(`Application not found: ${id}`);
  return row;
}
