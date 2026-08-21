import { deriveRolloutStage, getConfig } from "../config/index.js";
import type { Db } from "../storage/db/client.js";
import { listOpenReviewItems } from "../queue/reviewItems.js";
import { listServiceSessionRows } from "../auth/sessionStore.js";
import { getServiceAuthConfig } from "../auth/serviceRegistry.js";
import { describeSessionReadiness } from "../auth/serviceSession.js";
import { sensitiveProfileStatus } from "../candidate/sensitiveProfileIO.js";

/**
 * The single report-summary implementation, shared by the report CLI and the
 * read-only dashboard so the two can never disagree.
 */
export function buildReportSummary(db: Db): Record<string, unknown> {
  const config = getConfig();
  const apps = db
    .prepare(`SELECT state, COUNT(*) AS n FROM applications GROUP BY state`)
    .all();
  const openReviews = listOpenReviewItems(db);
  const sessions = listServiceSessionRows(db);
  const services = ["jobright", "linkedin", "outlook"] as const;
  const auth = services.map((service) => {
    const cfg = getServiceAuthConfig(service);
    const readiness = describeSessionReadiness(service, cfg.defaultMode);
    const row = sessions.find((s) => s.service === service);
    return {
      service,
      mode: cfg.defaultMode,
      ready: readiness.ready,
      detail: readiness.detail,
      last_status: row?.last_status ?? null,
      last_validated_at: row?.last_validated_at ?? null,
    };
  });

  return {
    database: config.databasePath,
    rollout_stage: deriveRolloutStage(config),
    dry_run: config.dryRun,
    form_fill_enabled: config.formFillEnabled,
    submit_enabled: config.submitEnabled,
    outlook_drafts_enabled: config.outlookDraftsEnabled,
    email_generation_enabled: config.emailGenerationEnabled,
    email_send_enabled: config.emailSendEnabled,
    applications_by_state: apps,
    open_review_items: openReviews.length,
    auth,
    sensitive_profile: sensitiveProfileStatus(),
  };
}

export function listApplicationRows(
  db: Db,
  state?: string,
): Array<Record<string, unknown>> {
  const base = `
    SELECT a.id, a.state, a.route, a.attempt, a.updated_at,
           j.company, j.role
    FROM applications a JOIN jobs j ON j.id = a.job_id`;
  if (state) {
    return db
      .prepare(`${base} WHERE a.state = ? ORDER BY a.updated_at DESC LIMIT 200`)
      .all(state) as Array<Record<string, unknown>>;
  }
  return db
    .prepare(`${base} ORDER BY a.updated_at DESC LIMIT 200`)
    .all() as Array<Record<string, unknown>>;
}

export function listSubmissionRows(db: Db): Array<Record<string, unknown>> {
  return db
    .prepare(
      // screenshot_path and confirmation_url are the evidence a submission
      // actually left behind; the console renders the receipt itself rather
      // than a checkmark and a count.
      `SELECT s.id, s.application_id, s.submission_attempt_number, s.status,
              s.submitted, s.submitted_at, s.application_identifier,
              s.screenshot_path, s.confirmation_url,
              j.company, j.role
       FROM submissions s
       JOIN applications a ON a.id = s.application_id
       JOIN jobs j ON j.id = a.job_id
       ORDER BY s.submitted_at DESC LIMIT 200`,
    )
    .all() as Array<Record<string, unknown>>;
}

export function listDraftRows(db: Db): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT d.id, d.application_id, d.recipient_email, d.subject, d.status,
              d.verified, d.created_at
       FROM outlook_drafts d ORDER BY d.created_at DESC LIMIT 200`,
    )
    .all() as Array<Record<string, unknown>>;
}

export function listReviewItemRows(db: Db): Array<Record<string, unknown>> {
  return listOpenReviewItems(db).map((i) => ({
    id: i.id,
    kind: i.kind,
    application_id: i.application_id,
    title: i.title,
    created_at: i.created_at,
  }));
}
