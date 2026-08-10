import type { Db } from "../storage/db/client.js";
import { transitionApplication } from "../queue/stateMachine.js";

/**
 * Second-chance navigation for agent-starved apps. Session edc4d38f
 * (2026-08-10 21:59) reported queue_drained while seven applications sat
 * in FAILED_RETRYABLE — parked by the PREVIOUS session only because its
 * agent leg was down ("navigation unresolved (budget)") — invisible to
 * pickNextApplication forever. When a session starts WITH the agent leg
 * available, those apps deserve exactly one more navigation attempt.
 *
 * Bounded twice over: at most `cap` requeues per sweep, and at most ONE
 * agent-leg retry per application ever (versions_json.nav_agent_requeued
 * — a permanent marker, so this can never become a park/requeue loop).
 * Apps with open review items or automation_excluded are never touched.
 */
export function requeueNavStarvedApplications(
  db: Db,
  input: { cap?: number } = {},
): { requeued: number; notes: string[] } {
  const cap = Math.max(0, input.cap ?? 10);
  const notes: string[] = [];
  let requeued = 0;

  const candidates = db
    .prepare(
      `SELECT a.id, a.versions_json FROM applications a
       WHERE a.state = 'FAILED_RETRYABLE'
         AND NOT EXISTS (
           SELECT 1 FROM review_items r
           WHERE r.application_id = a.id
             AND r.status IN ('OPEN', 'IN_PROGRESS'))
       ORDER BY a.created_at ASC`,
    )
    .all() as Array<{ id: string; versions_json: string }>;

  for (const row of candidates) {
    if (requeued >= cap) {
      notes.push(`nav requeue: cap ${cap} reached — remaining apps wait for the next session`);
      break;
    }
    let versions: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.versions_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        versions = parsed as Record<string, unknown>;
      }
    } catch {
      versions = {};
    }
    if (versions["automation_excluded"] === true) continue;
    if (versions["nav_agent_requeued"] === true) continue;

    // The app is CURRENTLY in FAILED_RETRYABLE, so its newest event is the
    // one that parked it — requeue only when that park was nav starvation.
    const lastEvent = db
      .prepare(
        `SELECT next_state, reason FROM application_events
         WHERE application_id = ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(row.id) as { next_state: string; reason: string | null } | undefined;
    if (
      !lastEvent ||
      lastEvent.next_state !== "FAILED_RETRYABLE" ||
      !/^navigation unresolved \(budget\)/.test(lastEvent.reason ?? "")
    ) {
      continue;
    }

    versions["nav_agent_requeued"] = true;
    db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(
      JSON.stringify(versions),
      row.id,
    );
    transitionApplication(db, {
      applicationId: row.id,
      nextState: "QUEUED",
      reason: "agent leg available — one retry for navigation-starved app",
    });
    requeued += 1;
  }
  return { requeued, notes };
}
