import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";

/**
 * automation_runs rows persist the unattended-submission cap per run, so a
 * crash cannot reset the counter mid-batch. Cap 0 (the default) means
 * unattended submission is always refused.
 */
export function createAutomationRun(
  db: Db,
  input: {
    stage: string;
    metadata?: Record<string, unknown>;
    /**
     * Explicit unattended-submission cap for this run. Defaults to the
     * config snapshot (unchanged behavior). An armed L3 session passes its
     * per-session budget here so the counter is scoped to the arm row.
     */
    maxUnattendedSubmissions?: number;
  },
): { id: string } {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO automation_runs (
      id, stage, status, started_at, max_unattended_submissions,
      unattended_submissions_count, metadata_json
    ) VALUES (?, ?, 'RUNNING', ?, ?, 0, ?)`,
  ).run(
    id,
    input.stage,
    new Date().toISOString(),
    input.maxUnattendedSubmissions ?? getConfig().maxUnattendedSubmissionsPerRun,
    JSON.stringify(input.metadata ?? {}),
  );
  return { id };
}

export type AutomationRunRow = {
  id: string;
  stage: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  max_unattended_submissions: number;
  unattended_submissions_count: number;
  metadata_json: string;
};

/** The latest RUNNING row for a stage — the arm session helpers use this. */
export function getLatestRunningByStage(
  db: Db,
  stage: string,
): AutomationRunRow | undefined {
  return db
    .prepare(
      `SELECT id, stage, status, started_at, ended_at,
              max_unattended_submissions, unattended_submissions_count, metadata_json
       FROM automation_runs
       WHERE stage = ? AND status = 'RUNNING'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(stage) as AutomationRunRow | undefined;
}

/**
 * Atomically consume one unattended-submission slot. Returns false when the
 * cap is reached (or is 0) — the caller must then refuse to submit.
 */
export function tryConsumeUnattendedSubmission(
  db: Db,
  automationRunId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE automation_runs
       SET unattended_submissions_count = unattended_submissions_count + 1
       WHERE id = ? AND status = 'RUNNING'
         AND unattended_submissions_count < max_unattended_submissions`,
    )
    .run(automationRunId);
  return result.changes === 1;
}

export function completeAutomationRun(db: Db, automationRunId: string): void {
  db.prepare(
    `UPDATE automation_runs SET status = 'COMPLETED', ended_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), automationRunId);
}

export function getAutomationRun(
  db: Db,
  automationRunId: string,
):
  | {
      id: string;
      stage: string;
      status: string;
      max_unattended_submissions: number;
      unattended_submissions_count: number;
    }
  | undefined {
  return db
    .prepare(
      `SELECT id, stage, status, max_unattended_submissions, unattended_submissions_count
       FROM automation_runs WHERE id = ?`,
    )
    .get(automationRunId) as ReturnType<typeof getAutomationRun>;
}
