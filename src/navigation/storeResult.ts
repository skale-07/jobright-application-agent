import type { Db } from "../storage/db/client.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { setEmployerApplicationUrl } from "../pipeline/runPipeline.js";

export type StoredEmployerUrl = {
  url: string;
  ats: string | null;
};

/**
 * Persist a navigation-resolved employer URL. Policy mirrors enqueue's
 * --employer-url handling: a supported-ATS URL is normalized + tagged (via
 * the existing setEmployerApplicationUrl); a well-formed https URL on an
 * UNSUPPORTED ATS is stored verbatim with ats:null so the pipeline routes
 * it to UNSUPPORTED_ATS with a review item (the tracked path); anything
 * else is refused. Also records how nav reached it (session kind + run id)
 * for the fill-stage session handoff.
 */
export function storeResolvedEmployerUrl(
  db: Db,
  applicationId: string,
  url: string,
  nav: { runId: string; session: "cdp" | "ephemeral" },
): StoredEmployerUrl {
  const detected = detectAtsFromUrl(url);
  if (detected.ats !== null) {
    setEmployerApplicationUrl(db, applicationId, url);
    annotateNav(db, applicationId, nav);
    return { url: detected.normalizedUrl, ats: detected.ats };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to store nav result: malformed URL (${url.slice(0, 64)})`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to store nav result: non-https URL (${parsed.protocol})`);
  }

  const row = db
    .prepare(
      `SELECT j.id, j.raw_json FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as { id: string; raw_json: string } | undefined;
  if (!row) throw new Error(`Unknown application: ${applicationId}`);
  const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
  raw["employer_application_url"] = url;
  raw["employer_application_ats"] = null;
  db.prepare(`UPDATE jobs SET raw_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(raw),
    new Date().toISOString(),
    row.id,
  );
  annotateNav(db, applicationId, nav);
  return { url, ats: null };
}

function annotateNav(
  db: Db,
  applicationId: string,
  nav: { runId: string; session: "cdp" | "ephemeral" },
): void {
  const row = db
    .prepare(
      `SELECT j.id, j.raw_json FROM jobs j
       JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as { id: string; raw_json: string } | undefined;
  if (!row) return;
  const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
  raw["nav_run_id"] = nav.runId;
  raw["nav_session"] = nav.session;
  db.prepare(`UPDATE jobs SET raw_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(raw),
    new Date().toISOString(),
    row.id,
  );
}
