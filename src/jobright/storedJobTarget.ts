import type { Db } from "../storage/db/client.js";
import {
  isValidJobrightJobId,
  resolveCanonicalInspectionUrl,
} from "./jobInspectionUrl.js";

export type StoredJobInspectionTarget = {
  jobDbId: string;
  jobrightJobId: string;
  jobUrl: string;
  jobPath: string | null;
  company: string | null;
  role: string | null;
  applicationId: string | null;
  applicationState: string | null;
};

export type StoredJobResolveFailure =
  | { ok: false; code: "INVALID_ID"; message: string }
  | { ok: false; code: "NOT_FOUND"; message: string }
  | { ok: false; code: "AMBIGUOUS"; message: string }
  | { ok: false; code: "UNSAFE_URL"; message: string };

export type StoredJobResolveResult =
  | { ok: true; target: StoredJobInspectionTarget }
  | StoredJobResolveFailure;

type JobRowFull = {
  id: string;
  jobright_job_id: string | null;
  normalized_application_url: string | null;
  company: string;
  role: string;
  raw_json: string;
};

function parseRawCard(rawJson: string): {
  job_url?: string;
  job_path?: string;
} {
  try {
    const raw = JSON.parse(rawJson) as Record<string, unknown>;
    const out: { job_url?: string; job_path?: string } = {};
    if (typeof raw.job_url === "string") out.job_url = raw.job_url;
    if (typeof raw.job_path === "string") out.job_path = raw.job_path;
    return out;
  } catch {
    return {};
  }
}

function findApplicationForJob(
  db: Db,
  jobDbId: string,
): { id: string; state: string } | null {
  const active = db
    .prepare(
      `SELECT id, state FROM applications
       WHERE job_id = ?
         AND state NOT IN ('COMPLETED', 'FAILED_FINAL', 'FILTERED_OUT')
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(jobDbId) as { id: string; state: string } | undefined;
  if (active) return active;

  const latest = db
    .prepare(
      `SELECT id, state FROM applications
       WHERE job_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(jobDbId) as { id: string; state: string } | undefined;
  return latest ?? null;
}

function targetFromJobRow(
  db: Db,
  row: JobRowFull,
  requestedId: string,
): StoredJobResolveResult {
  const card = parseRawCard(row.raw_json);
  const persistedUrl =
    card.job_url ?? row.normalized_application_url ?? null;
  const jobPath = card.job_path ?? null;

  const urlResult = resolveCanonicalInspectionUrl({
    jobrightJobId: requestedId,
    persistedUrl,
    jobPath,
  });
  if (!urlResult.ok) {
    return {
      ok: false,
      code: "UNSAFE_URL",
      message: urlResult.reason,
    };
  }

  const app = findApplicationForJob(db, row.id);
  return {
    ok: true,
    target: {
      jobDbId: row.id,
      jobrightJobId: requestedId,
      jobUrl: urlResult.url,
      jobPath: urlResult.jobPath,
      company: row.company || null,
      role: row.role || null,
      applicationId: app?.id ?? null,
      applicationState: app?.state ?? null,
    },
  };
}

/**
 * Resolve a persisted JobRight job for read-only inspection.
 * Does not create jobs or applications; does not mutate state.
 */
export function getStoredJobInspectionTarget(
  db: Db,
  jobrightJobId: string,
): StoredJobResolveResult {
  const id = jobrightJobId.trim();
  if (!isValidJobrightJobId(id)) {
    return {
      ok: false,
      code: "INVALID_ID",
      message: `Invalid JobRight job id: ${id}`,
    };
  }

  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE lower(jobright_job_id) = lower(?)`,
    )
    .get(id) as { n: number };
  if (countRow.n > 1) {
    return {
      ok: false,
      code: "AMBIGUOUS",
      message: `Ambiguous duplicate jobs for jobright_job_id=${id} (count=${countRow.n})`,
    };
  }

  const row = db
    .prepare(
      `SELECT id, jobright_job_id, normalized_application_url, company, role, raw_json
       FROM jobs WHERE lower(jobright_job_id) = lower(?)`,
    )
    .get(id) as JobRowFull | undefined;

  if (!row || !row.jobright_job_id) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Stored JobRight job not found: ${id}`,
    };
  }

  return targetFromJobRow(db, row, row.jobright_job_id);
}

/**
 * Resolve via application UUID → associated job.
 */
export function getStoredJobInspectionTargetByApplicationId(
  db: Db,
  applicationId: string,
): StoredJobResolveResult {
  const appId = applicationId.trim();
  if (!/^[0-9a-f-]{36}$/i.test(appId)) {
    return {
      ok: false,
      code: "INVALID_ID",
      message: `Invalid application UUID: ${appId}`,
    };
  }

  const joined = db
    .prepare(
      `SELECT j.id, j.jobright_job_id, j.normalized_application_url, j.company, j.role, j.raw_json,
              a.id AS application_id, a.state AS application_state
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       WHERE a.id = ?`,
    )
    .get(appId) as
    | (JobRowFull & {
        application_id: string;
        application_state: string;
      })
    | undefined;

  if (!joined) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Stored application not found: ${appId}`,
    };
  }
  if (!joined.jobright_job_id) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Application ${appId} has no JobRight job id`,
    };
  }

  const base = targetFromJobRow(db, joined, joined.jobright_job_id);
  if (!base.ok) return base;
  return {
    ok: true,
    target: {
      ...base.target,
      applicationId: joined.application_id,
      applicationState: joined.application_state,
    },
  };
}
