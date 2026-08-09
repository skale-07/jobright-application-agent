/**
 * Append-only navigation + submit attempt outcomes — the two training/debug
 * domains 003's fill corpus doesn't cover. Same discipline as
 * fillOutcomes.ts: fail open (telemetry must never break a run), PII-safe
 * (hosts and short reasons only, never form values or credentials), and
 * every row joinable to logs.jsonl and artifacts/ via run_id +
 * application_id.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./db/client.js";
import { migrate, openDatabase } from "./db/client.js";
import { logger } from "../logging/logger.js";
import type { NavigationReport } from "../navigation/runNavigation.js";

let migratedFor: Db | null = null;
function ensureMigrated(db: Db): void {
  if (migratedFor !== db) {
    migrate(db);
    migratedFor = db;
  }
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export type RecordNavigationAttemptInput = {
  report: NavigationReport;
  startUrl?: string | null;
  armRunId?: string | null;
  durationMs?: number | null;
};

export function recordNavigationAttempt(
  input: RecordNavigationAttemptInput,
  opts: { db?: Db } = {},
): { id: string } | null {
  let ownedDb = false;
  const db =
    opts.db ??
    (() => {
      ownedDb = true;
      return openDatabase();
    })();
  try {
    ensureMigrated(db);
    const r = input.report;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO navigation_attempts (
         id, created_at, run_id, application_id, arm_run_id, session_kind,
         method, wall, resolved, resolved_ats, start_host, end_host,
         phase_trace_json, agent_turns, agent_steps, agent_domains_json,
         gmail_polls, duration_ms, report_artifact_relpath
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      new Date().toISOString(),
      r.run_id,
      r.application_id,
      input.armRunId ?? null,
      r.session,
      r.method,
      r.wall,
      r.resolved_url ? 1 : 0,
      r.resolved_ats,
      hostOf(input.startUrl),
      hostOf(r.resolved_url),
      JSON.stringify(r.phase_trace),
      r.agent?.turns_used ?? null,
      r.agent?.steps_used ?? null,
      r.agent ? JSON.stringify(r.agent.domains_visited) : null,
      r.gmail?.polls_used ?? null,
      input.durationMs ?? null,
      r.report_path ?? null,
    );
    return { id };
  } catch (err) {
    logger.warn("navigation attempt telemetry failed (fail-open)", {
      service: "telemetry",
      action: "nav_attempt_record_error",
      metadata: {
        application_id: input.report.application_id,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  } finally {
    if (ownedDb) db.close();
  }
}

export type RecordSubmitAttemptInput = {
  runId: string;
  applicationId: string;
  submissionId?: string | null;
  ats: string;
  outcome: string;
  clicked: boolean;
  controlResolvedVia?: string | null;
  capHitAtClick?: boolean;
  verifyRecoveryUsed?: boolean;
  urlHost?: string | null;
  reason?: string | null;
  ctaInventoryCount?: number | null;
  durationMs?: number | null;
  reportArtifactRelpath?: string | null;
};

export function recordSubmitAttempt(
  input: RecordSubmitAttemptInput,
  opts: { db?: Db } = {},
): { id: string } | null {
  let ownedDb = false;
  const db =
    opts.db ??
    (() => {
      ownedDb = true;
      return openDatabase();
    })();
  try {
    ensureMigrated(db);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO submit_attempts (
         id, created_at, run_id, application_id, submission_id, ats,
         outcome, clicked, control_resolved_via, cap_hit_at_click,
         verify_recovery_used, url_host, reason, cta_inventory_count,
         duration_ms, report_artifact_relpath
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      new Date().toISOString(),
      input.runId,
      input.applicationId,
      input.submissionId ?? null,
      input.ats,
      input.outcome,
      input.clicked ? 1 : 0,
      input.controlResolvedVia ?? null,
      input.capHitAtClick ? 1 : 0,
      input.verifyRecoveryUsed ? 1 : 0,
      input.urlHost ?? null,
      input.reason?.slice(0, 300) ?? null,
      input.ctaInventoryCount ?? null,
      input.durationMs ?? null,
      input.reportArtifactRelpath ?? null,
    );
    return { id };
  } catch (err) {
    logger.warn("submit attempt telemetry failed (fail-open)", {
      service: "telemetry",
      action: "submit_attempt_record_error",
      metadata: {
        application_id: input.applicationId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  } finally {
    if (ownedDb) db.close();
  }
}

/** Derive control_resolved_via + inventory count from a submit attempt's notes. */
export function parseSubmitNotes(notes: string[]): {
  via: string | null;
  ctaInventoryCount: number | null;
} {
  const joined = notes.join("\n");
  const via = /resolved via ([a-z-]+)/.exec(joined)?.[1] ?? null;
  let ctaInventoryCount: number | null = null;
  const inv = /cta inventory: (\[.*\])/.exec(joined)?.[1];
  if (inv) {
    try {
      ctaInventoryCount = (JSON.parse(inv) as unknown[]).length;
    } catch {
      ctaInventoryCount = null;
    }
  }
  return { via, ctaInventoryCount };
}

export function exportNavigationAttemptsJsonl(
  db: Db = openDatabase(),
): Array<Record<string, unknown>> {
  ensureMigrated(db);
  return db
    .prepare(`SELECT * FROM navigation_attempts ORDER BY created_at ASC`)
    .all() as Array<Record<string, unknown>>;
}

export function exportSubmitAttemptsJsonl(
  db: Db = openDatabase(),
): Array<Record<string, unknown>> {
  ensureMigrated(db);
  return db
    .prepare(`SELECT * FROM submit_attempts ORDER BY created_at ASC`)
    .all() as Array<Record<string, unknown>>;
}
