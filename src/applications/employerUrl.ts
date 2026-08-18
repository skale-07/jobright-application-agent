import type { Db } from "../storage/db/client.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import {
  listOpenReviewItems,
  resolveReviewItem,
} from "../queue/reviewItems.js";

export const MISSING_EMPLOYER_URL_REVIEW_TITLE =
  "Employer application URL missing — resolve navigation or re-enqueue with --url";

/** Close the self-block the fill stage writes when the URL later comes back. */
export function resolveMissingEmployerUrlReviews(
  db: Db,
  applicationId: string,
): void {
  for (const item of listOpenReviewItems(db)) {
    if (
      item.application_id === applicationId &&
      item.kind === "MANUAL" &&
      item.title.startsWith("Employer application URL missing")
    ) {
      resolveReviewItem(
        db,
        item.id,
        { reason: "employer URL is present" },
        "RESOLVED",
      );
    }
  }
}

/**
 * Employer-URL persistence on the job row. Lives outside runPipeline so
 * navigation modules can store resolved URLs without importing the
 * pipeline (which imports navigation — a module cycle otherwise).
 * runPipeline re-exports both helpers for its existing callers.
 */

export function getEmployerApplicationUrl(
  db: Db,
  applicationId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT j.raw_json FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as { raw_json: string } | undefined;
  if (!row) return null;
  const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
  const url = raw["employer_application_url"];
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Remove a stored employer URL (nav-audit repair path: the URL failed the
 * company-congruence check, so the application must re-navigate). Keeps
 * the ATS tag out too — a cleared URL means "nothing is known".
 */
export function clearEmployerApplicationUrl(
  db: Db,
  applicationId: string,
): void {
  const row = db
    .prepare(
      `SELECT j.id, j.raw_json FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as { id: string; raw_json: string } | undefined;
  if (!row) throw new Error(`Unknown application: ${applicationId}`);
  const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
  delete raw["employer_application_url"];
  delete raw["employer_application_ats"];
  db.prepare(`UPDATE jobs SET raw_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(raw),
    new Date().toISOString(),
    row.id,
  );
}

/** Persist the employer ATS URL on the job so submit and re-runs find it. */
export function setEmployerApplicationUrl(
  db: Db,
  applicationId: string,
  url: string,
): void {
  const detected = detectAtsFromUrl(url);
  if (detected.ats === null) {
    throw new Error(`Refusing to store employer URL: ${detected.failureReason}`);
  }
  const row = db
    .prepare(
      `SELECT j.id, j.raw_json FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as { id: string; raw_json: string } | undefined;
  if (!row) throw new Error(`Unknown application: ${applicationId}`);
  const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
  raw["employer_application_url"] = detected.normalizedUrl;
  raw["employer_application_ats"] = detected.ats;
  db.prepare(`UPDATE jobs SET raw_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(raw),
    new Date().toISOString(),
    row.id,
  );
  resolveMissingEmployerUrlReviews(db, applicationId);
}
