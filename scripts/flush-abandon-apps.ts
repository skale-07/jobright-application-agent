/**
 * Operator tool: mark every non-terminal application FAILED_FINAL (abandon)
 * so discovery can CREATED a new row for the same job fingerprints.
 *
 * Usage: npx tsx scripts/flush-abandon-apps.ts [--delete]
 *   default: transition → FAILED_FINAL (preferred)
 *   --delete: hard-delete applications + children (like a mini queue flush)
 */
import { closeDatabase, migrate, openDatabase } from "../src/storage/db/client.js";
import { transitionApplication } from "../src/queue/stateMachine.js";
import { canTransition, type ApplicationState } from "../src/queue/states.js";

const TERMINAL = new Set(["COMPLETED", "FAILED_FINAL", "FILTERED_OUT"]);
const hardDelete = process.argv.includes("--delete");

const db = openDatabase();
migrate(db);

const rows = db
  .prepare(`SELECT id, state FROM applications ORDER BY created_at`)
  .all() as Array<{ id: string; state: ApplicationState }>;

const active = rows.filter((r) => !TERMINAL.has(r.state));
console.log(
  JSON.stringify(
    {
      total: rows.length,
      active: active.length,
      by_state: Object.fromEntries(
        [...new Set(rows.map((r) => r.state))].map((s) => [
          s,
          rows.filter((r) => r.state === s).length,
        ]),
      ),
      mode: hardDelete ? "delete" : "abandon→FAILED_FINAL",
    },
    null,
    2,
  ),
);

if (active.length === 0) {
  console.log("Nothing to flush.");
  closeDatabase(db);
  process.exit(0);
}

if (hardDelete) {
  const run = db.transaction(() => {
    db.prepare(
      `DELETE FROM linkedin_profiles WHERE contact_id IN (SELECT id FROM contacts)`,
    ).run();
    for (const sql of [
      `DELETE FROM email_generations`,
      `DELETE FROM outlook_drafts`,
      `DELETE FROM contacts`,
      `DELETE FROM submissions`,
      `DELETE FROM application_answers`,
      `DELETE FROM form_fields`,
      `DELETE FROM materials`,
      `DELETE FROM application_events`,
      `DELETE FROM review_items WHERE application_id IS NOT NULL`,
      `DELETE FROM leases WHERE resource_type = 'application' OR resource_id LIKE '%:pipeline' OR resource_id LIKE '%:submit'`,
      `DELETE FROM applications WHERE state NOT IN ('COMPLETED','FAILED_FINAL','FILTERED_OUT')`,
    ]) {
      const r = db.prepare(sql).run();
      console.log(`${sql.slice(0, 50)}… → ${r.changes}`);
    }
  });
  run();
} else {
  let abandoned = 0;
  let skipped = 0;
  for (const row of active) {
    if (!canTransition(row.state, "FAILED_FINAL")) {
      // Force via SQL only if edge missing — should be rare for FAILED_RETRYABLE.
      console.warn(`no FAILED_FINAL edge from ${row.state}: ${row.id} — deleting row children+app`);
      db.prepare(`DELETE FROM application_events WHERE application_id = ?`).run(row.id);
      db.prepare(`DELETE FROM materials WHERE application_id = ?`).run(row.id);
      db.prepare(`DELETE FROM review_items WHERE application_id = ?`).run(row.id);
      db.prepare(`DELETE FROM submissions WHERE application_id = ?`).run(row.id);
      db.prepare(`DELETE FROM applications WHERE id = ?`).run(row.id);
      skipped += 1;
      continue;
    }
    transitionApplication(db, {
      applicationId: row.id,
      nextState: "FAILED_FINAL",
      reason: "operator flush/abandon (scripts/flush-abandon-apps.ts)",
      route: "FAILED_FINAL",
    });
    // clear open reviews so nothing blocks tooling
    db.prepare(
      `UPDATE review_items SET status = 'DISMISSED', resolved_at = ?, updated_at = ?,
         resolution_json = ?
       WHERE application_id = ? AND status IN ('OPEN','IN_PROGRESS')`,
    ).run(
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify({ action: "dismissed", by: "flush-abandon-apps" }),
      row.id,
    );
    abandoned += 1;
  }
  console.log(JSON.stringify({ abandoned, forced_deleted: skipped }, null, 2));
}

const after = db
  .prepare(
    `SELECT state, count(*) AS c FROM applications GROUP BY state ORDER BY c DESC`,
  )
  .all();
console.log("after:", after);
closeDatabase(db);
console.log("Done. Re-arm L3 so discover can CREATE new QUEUED apps for the same jobs.");
