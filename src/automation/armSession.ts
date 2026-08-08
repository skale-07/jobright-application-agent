import { createHash } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import {
  completeAutomationRun,
  createAutomationRun,
  getLatestRunningByStage,
  type AutomationRunRow,
} from "../queue/automationRuns.js";

/**
 * An L3 "armed session" is an `automation_runs` row with stage
 * `l3_session`. Reusing that machinery is deliberate: the unattended
 * submission budget is the row's persisted `unattended_submissions_count`
 * (consumed atomically by `tryConsumeUnattendedSubmission`), and disarming
 * is `completeAutomationRun`, after which the row can never be consumed
 * again — so disarm is fail-closed by construction and a crash cannot reset
 * the counter. Session metadata (expiry, app cap and count, the token hash
 * that armed it) lives in `metadata_json`; no schema migration is needed.
 *
 * Only ONE session may be armed at a time. A row that is still RUNNING but
 * past its `armed_until` reads as disarmed everywhere and is swept to
 * COMPLETED (console restart sweeps all of them — restart = disarmed).
 */

export const L3_SESSION_STAGE = "l3_session";

const DURATION_MIN = 15;
const DURATION_MAX = 240;
const DEFAULT_DURATION = 120;
const DEFAULT_MAX_SUBMITS = 10;
const DEFAULT_MAX_APPS = 25;
const DEFAULT_DISCOVER_MAX = 10;
const DEFAULT_REDISCOVER_EVERY = 5;

export type ArmMetadata = {
  armed_until: string;
  max_apps: number;
  apps_started: number;
  discover_max: number;
  rediscover_every: number;
  armed_by_token_hash: string;
};

export type ArmStatus = {
  armed: boolean;
  arm_run_id: string | null;
  armed_until: string | null;
  seconds_remaining: number;
  max_submits: number;
  submits_used: number;
  max_apps: number;
  apps_started: number;
  discover_max: number;
  rediscover_every: number;
};

export class ArmConflictError extends Error {
  readonly statusCode = 409;
  constructor() {
    super("a session is already armed — disarm it before arming a new one");
    this.name = "ArmConflictError";
  }
}

/** Never store the raw bearer token; a short hash is enough to attribute. */
export function hashArmToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function clampDuration(minutes: number | undefined): number {
  const v = Math.round(minutes ?? DEFAULT_DURATION);
  if (!Number.isFinite(v)) return DEFAULT_DURATION;
  return Math.min(DURATION_MAX, Math.max(DURATION_MIN, v));
}

function positiveInt(value: number | undefined, fallback: number): number {
  const v = Math.round(value ?? fallback);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function parseMeta(row: AutomationRunRow): ArmMetadata {
  const raw = JSON.parse(row.metadata_json) as Partial<ArmMetadata>;
  return {
    armed_until: typeof raw.armed_until === "string" ? raw.armed_until : "",
    max_apps: typeof raw.max_apps === "number" ? raw.max_apps : 0,
    apps_started: typeof raw.apps_started === "number" ? raw.apps_started : 0,
    discover_max: typeof raw.discover_max === "number" ? raw.discover_max : 0,
    rediscover_every:
      typeof raw.rediscover_every === "number" ? raw.rediscover_every : 0,
    armed_by_token_hash:
      typeof raw.armed_by_token_hash === "string" ? raw.armed_by_token_hash : "",
  };
}

/** True when the row is RUNNING and not past its armed_until. */
function isLive(row: AutomationRunRow, meta: ArmMetadata, nowMs: number): boolean {
  if (row.status !== "RUNNING") return false;
  const until = Date.parse(meta.armed_until);
  return Number.isFinite(until) && nowMs < until;
}

/**
 * The active arm row, or undefined. An expired-but-RUNNING row is swept to
 * COMPLETED here (lazy sweep) and treated as no active session.
 */
export function getActiveArmSession(
  db: Db,
  now: Date = new Date(),
): { row: AutomationRunRow; meta: ArmMetadata } | undefined {
  const row = getLatestRunningByStage(db, L3_SESSION_STAGE);
  if (!row) return undefined;
  const meta = parseMeta(row);
  if (!isLive(row, meta, now.getTime())) {
    completeAutomationRun(db, row.id);
    return undefined;
  }
  return { row, meta };
}

export function armSession(
  db: Db,
  input: {
    durationMinutes?: number;
    maxSubmits?: number;
    maxApps?: number;
    discoverMax?: number;
    rediscoverEvery?: number;
    armedByTokenHash: string;
  },
  now: Date = new Date(),
): ArmStatus {
  if (getActiveArmSession(db, now)) {
    throw new ArmConflictError();
  }
  const durationMinutes = clampDuration(input.durationMinutes);
  const maxSubmits = positiveInt(input.maxSubmits, DEFAULT_MAX_SUBMITS);
  const maxApps = positiveInt(input.maxApps, DEFAULT_MAX_APPS);
  const discoverMax = Math.max(0, Math.round(input.discoverMax ?? DEFAULT_DISCOVER_MAX));
  const rediscoverEvery = positiveInt(input.rediscoverEvery, DEFAULT_REDISCOVER_EVERY);
  const armedUntil = new Date(now.getTime() + durationMinutes * 60_000).toISOString();

  const meta: ArmMetadata = {
    armed_until: armedUntil,
    max_apps: maxApps,
    apps_started: 0,
    discover_max: discoverMax,
    rediscover_every: rediscoverEvery,
    armed_by_token_hash: input.armedByTokenHash,
  };
  createAutomationRun(db, {
    stage: L3_SESSION_STAGE,
    maxUnattendedSubmissions: maxSubmits,
    metadata: meta as unknown as Record<string, unknown>,
  });
  return getArmStatus(db, now);
}

export function disarmSession(db: Db, now: Date = new Date()): ArmStatus {
  const active = getActiveArmSession(db, now);
  if (active) completeAutomationRun(db, active.row.id);
  return getArmStatus(db, now);
}

export function getArmStatus(db: Db, now: Date = new Date()): ArmStatus {
  const active = getActiveArmSession(db, now);
  if (!active) {
    return {
      armed: false,
      arm_run_id: null,
      armed_until: null,
      seconds_remaining: 0,
      max_submits: 0,
      submits_used: 0,
      max_apps: 0,
      apps_started: 0,
      discover_max: 0,
      rediscover_every: 0,
    };
  }
  const { row, meta } = active;
  const secondsRemaining = Math.max(
    0,
    Math.round((Date.parse(meta.armed_until) - now.getTime()) / 1000),
  );
  return {
    armed: true,
    arm_run_id: row.id,
    armed_until: meta.armed_until,
    seconds_remaining: secondsRemaining,
    max_submits: row.max_unattended_submissions,
    submits_used: row.unattended_submissions_count,
    max_apps: meta.max_apps,
    apps_started: meta.apps_started,
    discover_max: meta.discover_max,
    rediscover_every: meta.rediscover_every,
  };
}

/**
 * Atomically claim one application slot against `max_apps`. Read-modify-write
 * inside a transaction (apps_started lives in metadata_json, so there is no
 * single-column UPDATE); the console is single-writer, and the transaction
 * still guards against a concurrent disarm. Returns false when the cap is
 * reached or the session is no longer live.
 */
export function consumeArmApplication(
  db: Db,
  armRunId: string,
  now: Date = new Date(),
): boolean {
  const claim = db.transaction((): boolean => {
    const row = db
      .prepare(
        `SELECT id, stage, status, started_at, ended_at,
                max_unattended_submissions, unattended_submissions_count, metadata_json
         FROM automation_runs WHERE id = ? AND status = 'RUNNING'`,
      )
      .get(armRunId) as AutomationRunRow | undefined;
    if (!row) return false;
    const meta = parseMeta(row);
    if (!isLive(row, meta, now.getTime())) return false;
    if (meta.apps_started >= meta.max_apps) return false;
    meta.apps_started += 1;
    db.prepare(`UPDATE automation_runs SET metadata_json = ? WHERE id = ?`).run(
      JSON.stringify(meta),
      armRunId,
    );
    return true;
  });
  return claim();
}

/**
 * Complete every RUNNING l3_session row. Called on console boot so a
 * restart always starts disarmed, and safe to call when none exist.
 */
export function sweepStaleArmSessions(db: Db): number {
  const result = db
    .prepare(
      `UPDATE automation_runs SET status = 'COMPLETED', ended_at = ?
       WHERE stage = ? AND status = 'RUNNING'`,
    )
    .run(new Date().toISOString(), L3_SESSION_STAGE);
  return result.changes;
}
