import type { Db } from "../storage/db/client.js";

/**
 * "add functionality to add a skip button if the agent is stuck on the
 *  current job" — operator, 2026-08-14.
 *
 * Excluding an application from automation already existed, but exclusion
 * is only read when the worker PICKS an app. Once a pipeline is running,
 * nothing could redirect it — an app stuck behind a slow typeahead or a
 * portal that will not load held the whole armed session until its own
 * timeouts expired. Watching that happen and being unable to say "not this
 * one, move on" is the gap this closes.
 *
 * The mechanism is a cooperative signal, not a kill:
 *
 *   - The request is a marker on the application (`skip_requested_at` in
 *     versions_json — same place, and same no-migration approach, as
 *     `automation_excluded`).
 *   - `runPipeline` checks it at the top of each step iteration, so a skip
 *     lands between transitions — never in the middle of one. A form is
 *     never left half-filled and a submit in flight is never abandoned
 *     mid-click.
 *   - The app is also excluded from future selection, so skipping means
 *     skipping — the worker does not pick it up again on the next lap.
 *
 * Skipping is not a state change: the application keeps whatever state it
 * had reached, so the operator can inspect it, fix what was wrong, and
 * re-include it later.
 */

export type SkipRequest = {
  application_id: string;
  requested_at: string;
  reason: string | null;
};

function readVersions(db: Db, applicationId: string): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT versions_json FROM applications WHERE id = ?`)
    .get(applicationId) as { versions_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.versions_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — a corrupt blob is replaced, never a reason to refuse
  }
  return {};
}

function writeVersions(
  db: Db,
  applicationId: string,
  versions: Record<string, unknown>,
): void {
  db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(
    JSON.stringify(versions),
    applicationId,
  );
}

/**
 * Ask the worker to stop working this application at its next step
 * boundary and move on. Also excludes it from selection so the skip
 * sticks. Returns false when the application does not exist.
 */
export function requestSkip(
  db: Db,
  applicationId: string,
  reason?: string,
): boolean {
  const versions = readVersions(db, applicationId);
  if (versions === null) return false;
  versions["skip_requested_at"] = new Date().toISOString();
  versions["skip_reason"] = reason ?? null;
  // A skip the worker would immediately re-pick is not a skip.
  versions["automation_excluded"] = true;
  writeVersions(db, applicationId, versions);
  return true;
}

/** Is a skip pending for this application? Read-only — safe to poll. */
export function isSkipRequested(db: Db, applicationId: string): boolean {
  const versions = readVersions(db, applicationId);
  return typeof versions?.["skip_requested_at"] === "string";
}

/** The pending skip, for reporting what the operator asked and when. */
export function getSkipRequest(
  db: Db,
  applicationId: string,
): SkipRequest | null {
  const versions = readVersions(db, applicationId);
  const at = versions?.["skip_requested_at"];
  if (typeof at !== "string") return null;
  const reason = versions?.["skip_reason"];
  return {
    application_id: applicationId,
    requested_at: at,
    reason: typeof reason === "string" ? reason : null,
  };
}

/**
 * Clear the pending skip (the worker has acted on it) while KEEPING the
 * exclusion — the operator said not this one, and only the operator says
 * otherwise, via the include toggle.
 */
export function clearSkipRequest(db: Db, applicationId: string): void {
  const versions = readVersions(db, applicationId);
  if (versions === null) return;
  delete versions["skip_requested_at"];
  writeVersions(db, applicationId, versions);
}

/** Undo a skip: clears the marker AND re-includes the app in automation. */
export function unskip(db: Db, applicationId: string): boolean {
  const versions = readVersions(db, applicationId);
  if (versions === null) return false;
  delete versions["skip_requested_at"];
  delete versions["skip_reason"];
  versions["automation_excluded"] = false;
  writeVersions(db, applicationId, versions);
  return true;
}
