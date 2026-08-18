import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import {
  computeJobFingerprint,
  normalizeApplicationUrl,
  type JobIdentityInput,
} from "./fingerprint.js";

export type UpsertJobInput = JobIdentityInput & {
  location?: string | null;
  employmentType?: string | null;
  descriptionText?: string | null;
  descriptionHash?: string | null;
  sourceAts?: string | null;
  raw?: Record<string, unknown>;
};

export type JobRow = {
  id: string;
  jobright_job_id: string | null;
  normalized_application_url: string | null;
  company: string;
  role: string;
  job_fingerprint: string;
};

/** Navigation writes these onto job.raw_json. Discovery upserts must not wipe them. */
const NAV_OWNED_RAW_KEYS = [
  "employer_application_url",
  "employer_application_ats",
  "nav_run_id",
  "nav_session",
] as const;

function mergeJobRaw(
  existingRawJson: string | undefined,
  incoming: Record<string, unknown> | undefined,
): string {
  const prev = existingRawJson
    ? (JSON.parse(existingRawJson) as Record<string, unknown>)
    : {};
  const nextIn = incoming ?? {};
  const merged: Record<string, unknown> = { ...prev, ...nextIn };
  for (const key of NAV_OWNED_RAW_KEYS) {
    const kept = prev[key];
    const want = nextIn[key];
    const keptOk = typeof kept === "string" && kept.length > 0;
    const wantOk = typeof want === "string" && want.length > 0;
    if (keptOk && !wantOk) merged[key] = kept;
  }
  return JSON.stringify(merged);
}

export function upsertJobByFingerprint(db: Db, input: UpsertJobInput): JobRow {
  const fingerprint = computeJobFingerprint(input);
  const now = new Date().toISOString();
  const normalizedUrl = input.applicationUrl
    ? normalizeApplicationUrl(input.applicationUrl)
    : null;

  const existing =
    (db
      .prepare(`SELECT * FROM jobs WHERE job_fingerprint = ?`)
      .get(fingerprint) as (JobRow & { raw_json: string }) | undefined) ??
    (input.jobrightJobId
      ? (db
          .prepare(`SELECT * FROM jobs WHERE jobright_job_id = ?`)
          .get(input.jobrightJobId) as (JobRow & { raw_json: string }) | undefined)
      : undefined) ??
    (normalizedUrl
      ? (db
          .prepare(`SELECT * FROM jobs WHERE normalized_application_url = ?`)
          .get(normalizedUrl) as (JobRow & { raw_json: string }) | undefined)
      : undefined);

  if (existing) {
    db.prepare(
      `UPDATE jobs SET
        jobright_job_id = COALESCE(?, jobright_job_id),
        normalized_application_url = COALESCE(?, normalized_application_url),
        company = ?, role = ?, location = ?, employment_type = ?,
        description_text = ?, description_hash = ?, source_ats = ?,
        job_fingerprint = ?, raw_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.jobrightJobId ?? null,
      normalizedUrl,
      input.company,
      input.role,
      input.location ?? null,
      input.employmentType ?? null,
      input.descriptionText ?? null,
      input.descriptionHash ?? null,
      input.sourceAts ?? null,
      fingerprint,
      mergeJobRaw(existing.raw_json, input.raw),
      now,
      existing.id,
    );
    return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(existing.id) as JobRow;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO jobs (
      id, jobright_job_id, normalized_application_url, company, role,
      location, employment_type, description_text, description_hash,
      source_ats, job_fingerprint, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.jobrightJobId ?? null,
    normalizedUrl,
    input.company,
    input.role,
    input.location ?? null,
    input.employmentType ?? null,
    input.descriptionText ?? null,
    input.descriptionHash ?? null,
    input.sourceAts ?? null,
    fingerprint,
    JSON.stringify(input.raw ?? {}),
    now,
    now,
  );

  return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow;
}

export function findJobByFingerprint(
  db: Db,
  fingerprint: string,
): JobRow | undefined {
  return db
    .prepare(`SELECT * FROM jobs WHERE job_fingerprint = ?`)
    .get(fingerprint) as JobRow | undefined;
}
