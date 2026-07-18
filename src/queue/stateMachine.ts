import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import {
  assertTransition,
  type ApplicationState,
  type ApplicationRoute,
} from "./states.js";

export type TransitionInput = {
  applicationId: string;
  nextState: ApplicationState;
  reason?: string;
  attempt?: number;
  artifacts?: string[];
  warnings?: string[];
  runId?: string;
  route?: ApplicationRoute;
};

export type ApplicationRow = {
  id: string;
  job_id: string;
  state: ApplicationState;
  route: ApplicationRoute | null;
  attempt: number;
  versions_json: string;
  created_at: string;
  updated_at: string;
};

export function getApplication(
  db: Db,
  applicationId: string,
): ApplicationRow | undefined {
  return db
    .prepare("SELECT * FROM applications WHERE id = ?")
    .get(applicationId) as ApplicationRow | undefined;
}

export function transitionApplication(
  db: Db,
  input: TransitionInput,
): ApplicationRow {
  const current = getApplication(db, input.applicationId);
  if (!current) {
    throw new Error(`Application not found: ${input.applicationId}`);
  }

  const previous = current.state;
  assertTransition(previous, input.nextState);

  const now = new Date().toISOString();
  const eventId = randomUUID();
  const attempt = input.attempt ?? current.attempt;

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE applications
       SET state = ?, route = COALESCE(?, route), attempt = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.nextState,
      input.route ?? null,
      attempt,
      now,
      input.applicationId,
    );

    db.prepare(
      `INSERT INTO application_events (
        id, application_id, previous_state, next_state, timestamp,
        reason, attempt, artifacts_json, warnings_json, run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      input.applicationId,
      previous,
      input.nextState,
      now,
      input.reason ?? null,
      attempt,
      JSON.stringify(input.artifacts ?? []),
      JSON.stringify(input.warnings ?? []),
      input.runId ?? null,
    );
  });

  run();

  const updated = getApplication(db, input.applicationId);
  if (!updated) {
    throw new Error(`Application missing after transition: ${input.applicationId}`);
  }
  return updated;
}

export type CreateApplicationInput = {
  id?: string;
  jobId: string;
  state?: ApplicationState;
  versions?: Record<string, unknown>;
};

export function createApplication(
  db: Db,
  input: CreateApplicationInput,
): ApplicationRow {
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  const state = input.state ?? "DISCOVERED";

  db.prepare(
    `INSERT INTO applications (
      id, job_id, state, route, attempt, versions_json, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, 1, ?, ?, ?)`,
  ).run(id, input.jobId, state, JSON.stringify(input.versions ?? {}), now, now);

  db.prepare(
    `INSERT INTO application_events (
      id, application_id, previous_state, next_state, timestamp,
      reason, attempt, artifacts_json, warnings_json, run_id
    ) VALUES (?, ?, NULL, ?, ?, ?, 1, '[]', '[]', NULL)`,
  ).run(randomUUID(), id, state, now, "created");

  const row = getApplication(db, id);
  if (!row) throw new Error("Failed to create application");
  return row;
}

/** Readable export — not canonical. */
export function exportApplicationStateJson(
  db: Db,
  applicationId: string,
): Record<string, unknown> {
  const app = getApplication(db, applicationId);
  if (!app) {
    throw new Error(`Application not found: ${applicationId}`);
  }
  const events = db
    .prepare(
      `SELECT previous_state, next_state, timestamp, reason, attempt
       FROM application_events WHERE application_id = ? ORDER BY timestamp`,
    )
    .all(applicationId);

  return {
    application_id: app.id,
    job_id: app.job_id,
    state: app.state,
    route: app.route,
    attempt: app.attempt,
    versions: JSON.parse(app.versions_json) as unknown,
    events,
    exported_at: new Date().toISOString(),
    note: "Export only — SQLite is the source of truth",
  };
}
