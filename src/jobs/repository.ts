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

export function upsertJobByFingerprint(db: Db, input: UpsertJobInput): JobRow {
  const fingerprint = computeJobFingerprint(input);
  const now = new Date().toISOString();
  const normalizedUrl = input.applicationUrl
    ? normalizeApplicationUrl(input.applicationUrl)
    : null;

  const existing =
    (db
      .prepare(`SELECT * FROM jobs WHERE job_fingerprint = ?`)
      .get(fingerprint) as JobRow | undefined) ??
    (input.jobrightJobId
      ? (db
          .prepare(`SELECT * FROM jobs WHERE jobright_job_id = ?`)
          .get(input.jobrightJobId) as JobRow | undefined)
      : undefined) ??
    (normalizedUrl
      ? (db
          .prepare(`SELECT * FROM jobs WHERE normalized_application_url = ?`)
          .get(normalizedUrl) as JobRow | undefined)
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
      JSON.stringify(input.raw ?? {}),
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
