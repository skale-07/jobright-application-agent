import type { Db } from "../storage/db/client.js";
import { redactObject } from "../logging/redaction.js";
import { REVIEW_KINDS, type ReviewItem } from "../queue/reviewItems.js";
import { summarizeFillOutcomes } from "../storage/fillOutcomes.js";

/**
 * Console read models. Richer than the dashboard's (paging, search, full
 * review items, per-application detail) but the same discipline: SELECTs
 * only, payloads parsed + redacted before they leave the process.
 */

function parseJsonSafe(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function redactedRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return redactObject(value as Record<string, unknown>);
}

export function listApplicationRowsPaged(
  db: Db,
  options: { state?: string; q?: string; limit?: number; offset?: number },
): { rows: Array<Record<string, unknown>>; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.state) {
    where.push(`a.state = ?`);
    params.push(options.state);
  }
  if (options.q) {
    where.push(`(j.company LIKE ? OR j.role LIKE ? OR a.id LIKE ?)`);
    const like = `%${options.q}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM applications a JOIN jobs j ON j.id = a.job_id ${whereSql}`,
      )
      .get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT a.id, a.state, a.route, a.attempt, a.updated_at, a.created_at,
              a.versions_json,
              j.company, j.role, j.location,
              EXISTS(
                SELECT 1 FROM review_items r
                WHERE r.application_id = a.id
                  AND r.status IN ('OPEN', 'IN_PROGRESS')
              ) AS has_open_review
       FROM applications a JOIN jobs j ON j.id = a.job_id
       ${whereSql}
       ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const versions = parseJsonSafe(row["versions_json"] as string);
    row["automation_excluded"] =
      versions !== null &&
      typeof versions === "object" &&
      (versions as Record<string, unknown>)["automation_excluded"] === true;
    row["has_open_review"] = row["has_open_review"] === 1;
    delete row["versions_json"];
  }
  return { rows, total };
}

export type ReviewItemView = {
  id: string;
  application_id: string | null;
  kind: string;
  status: string;
  title: string;
  payload: Record<string, unknown> | null;
  resolution: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  /** Job identity so lists can say "Cohere — ML Intern", not a UUID. */
  company: string | null;
  role: string | null;
};

function toReviewItemView(
  item: ReviewItem & { company?: string | null; role?: string | null },
): ReviewItemView {
  return {
    id: item.id,
    application_id: item.application_id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    payload: redactedRecord(parseJsonSafe(item.payload_json)),
    resolution: redactedRecord(parseJsonSafe(item.resolution_json)),
    created_at: item.created_at,
    updated_at: item.updated_at,
    resolved_at: item.resolved_at,
    company: item.company ?? null,
    role: item.role ?? null,
  };
}

export function listReviewItemViews(
  db: Db,
  options: { status?: "open" | "all"; kind?: string },
): ReviewItemView[] {
  if (options.kind && !REVIEW_KINDS.includes(options.kind as never)) {
    throw new Error(`unknown review kind: ${options.kind}`);
  }
  const where: string[] = [];
  const params: unknown[] = [];
  if ((options.status ?? "open") === "open") {
    where.push(`r.status IN ('OPEN', 'IN_PROGRESS')`);
  }
  if (options.kind) {
    where.push(`r.kind = ?`);
    params.push(options.kind);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const items = db
    .prepare(
      `SELECT r.*, j.company, j.role
       FROM review_items r
       LEFT JOIN applications a ON a.id = r.application_id
       LEFT JOIN jobs j ON j.id = a.job_id
       ${whereSql} ORDER BY r.created_at DESC LIMIT 500`,
    )
    .all(...params) as Array<ReviewItem & { company: string | null; role: string | null }>;
  return items.map(toReviewItemView);
}

export type ApplicationDetail = {
  application: Record<string, unknown>;
  job: Record<string, unknown>;
  timeline: Array<Record<string, unknown>>;
  review_items: ReviewItemView[];
  submissions: Array<Record<string, unknown>>;
  materials: Array<Record<string, unknown>>;
  fill_runs: Array<Record<string, unknown>>;
  drafts: Array<Record<string, unknown>>;
  /** X6: gmail_drafts rows (source-tagged separately from Outlook). */
  gmail_drafts: Array<Record<string, unknown>>;
  /** X6: contact rows for the Outreach card — local console, own data. */
  contacts: Array<Record<string, unknown>>;
  /** X6: generated outreach emails (operator's own drafts, full text). */
  email_generations: Array<Record<string, unknown>>;
  contacts_count: number;
  email_generations_count: number;
  artifact_links: string[];
};

export function getApplicationDetail(
  db: Db,
  applicationId: string,
): ApplicationDetail | undefined {
  const application = db
    .prepare(
      `SELECT id, job_id, state, route, attempt, error_summary, created_at, updated_at,
              versions_json
       FROM applications WHERE id = ?`,
    )
    .get(applicationId) as Record<string, unknown> | undefined;
  if (!application) return undefined;
  const versions = parseJsonSafe(application["versions_json"] as string);
  application["automation_excluded"] =
    versions !== null &&
    typeof versions === "object" &&
    (versions as Record<string, unknown>)["automation_excluded"] === true;
  delete application["versions_json"];

  const jobRow = db
    .prepare(
      `SELECT id, jobright_job_id, company, role, location, employment_type,
              normalized_application_url, source_ats, raw_json
       FROM jobs WHERE id = ?`,
    )
    .get(application["job_id"]) as Record<string, unknown> | undefined;
  const rawJob = (parseJsonSafe(jobRow?.["raw_json"] as string) ?? {}) as Record<
    string,
    unknown
  >;
  const job: Record<string, unknown> = {
    id: jobRow?.["id"] ?? null,
    jobright_job_id: jobRow?.["jobright_job_id"] ?? null,
    company: jobRow?.["company"] ?? null,
    role: jobRow?.["role"] ?? null,
    location: jobRow?.["location"] ?? null,
    employment_type: jobRow?.["employment_type"] ?? null,
    normalized_application_url: jobRow?.["normalized_application_url"] ?? null,
    source_ats: jobRow?.["source_ats"] ?? null,
    employer_application_url: rawJob["employer_application_url"] ?? null,
    employer_application_ats: rawJob["employer_application_ats"] ?? null,
    nav_run_id: rawJob["nav_run_id"] ?? null,
    nav_session: rawJob["nav_session"] ?? null,
    job_url: rawJob["job_url"] ?? null,
  };

  const events = db
    .prepare(
      `SELECT previous_state, next_state, timestamp, reason, attempt, run_id,
              artifacts_json, warnings_json
       FROM application_events WHERE application_id = ?
       ORDER BY timestamp ASC`,
    )
    .all(applicationId) as Array<Record<string, unknown>>;
  const timeline = events.map((e) => ({
    previous_state: e["previous_state"],
    next_state: e["next_state"],
    timestamp: e["timestamp"],
    reason: e["reason"],
    attempt: e["attempt"],
    run_id: e["run_id"],
    artifacts: (parseJsonSafe(e["artifacts_json"] as string) as string[]) ?? [],
    warnings: (parseJsonSafe(e["warnings_json"] as string) as string[]) ?? [],
  }));

  const reviewItems = (
    db
      .prepare(
        `SELECT * FROM review_items WHERE application_id = ? ORDER BY created_at DESC`,
      )
      .all(applicationId) as ReviewItem[]
  ).map(toReviewItemView);

  const submissions = db
    .prepare(
      `SELECT id, submission_attempt_number, status, submitted, submitted_at,
              confirmation_url, application_identifier, screenshot_path
       FROM submissions WHERE application_id = ?
       ORDER BY submission_attempt_number DESC`,
    )
    .all(applicationId) as Array<Record<string, unknown>>;

  const materials = db
    .prepare(
      `SELECT id, kind, path, sha256, size_bytes, verified, created_at
       FROM materials WHERE application_id = ? ORDER BY created_at DESC`,
    )
    .all(applicationId) as Array<Record<string, unknown>>;

  const fillRuns = db
    .prepare(
      `SELECT id, created_at, mode, ats, validation_level, verify_passed,
              fillable_count, skipped_count, heal_attempted, heal_healed,
              report_artifact_relpath
       FROM fill_runs WHERE application_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
    .all(applicationId) as Array<Record<string, unknown>>;

  const drafts = db
    .prepare(
      `SELECT id, contact_id, recipient_email, subject, status, verified, created_at
       FROM outlook_drafts WHERE application_id = ? ORDER BY created_at DESC`,
    )
    .all(applicationId) as Array<Record<string, unknown>>;

  // X6 Outreach card data. The console is loopback-only and this is the
  // operator's own outreach data — names/emails/subjects render so the
  // operator can review before anything is drafted. jobright_context_json
  // stays out (raw scrape payload, no UI value).
  const contacts = db
    .prepare(
      `SELECT id, name, title, company, email, source_category, created_at
       FROM contacts WHERE application_id = ? ORDER BY created_at ASC`,
    )
    .all(applicationId) as Array<Record<string, unknown>>;
  const emailGenerations = db
    .prepare(
      `SELECT id, contact_id, prompt_version, model, subject, body_text,
              validation_status, created_at
       FROM email_generations WHERE application_id = ?
       ORDER BY created_at DESC LIMIT 25`,
    )
    .all(applicationId) as Array<Record<string, unknown>>;
  const gmailDrafts = db
    .prepare(
      `SELECT id, contact_id, recipient_email, subject, status, verified, created_at
       FROM gmail_drafts WHERE application_id = ? ORDER BY created_at DESC`,
    )
    .all(applicationId) as Array<Record<string, unknown>>;
  const contactsCount = contacts.length;
  const emailGenCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM email_generations WHERE application_id = ?`,
      )
      .get(applicationId) as { n: number }
  ).n;

  const artifactLinks = new Set<string>();
  for (const t of timeline) {
    for (const a of t["artifacts"] as string[]) {
      if (typeof a === "string" && a.length > 0) artifactLinks.add(a);
    }
  }
  for (const f of fillRuns) {
    const rel = f["report_artifact_relpath"];
    if (typeof rel === "string" && rel.length > 0) artifactLinks.add(rel);
  }
  for (const s of submissions) {
    const shot = s["screenshot_path"];
    if (typeof shot === "string" && shot.length > 0) artifactLinks.add(shot);
  }

  return {
    application,
    job,
    timeline,
    review_items: reviewItems,
    submissions,
    materials,
    fill_runs: fillRuns,
    drafts,
    gmail_drafts: gmailDrafts,
    contacts,
    email_generations: emailGenerations,
    contacts_count: contactsCount,
    email_generations_count: emailGenCount,
    artifact_links: [...artifactLinks].sort(),
  };
}

export function buildFillOutcomesView(db: Db): Record<string, unknown> {
  const rates = db
    .prepare(`SELECT * FROM fill_field_success_rates ORDER BY attempts DESC LIMIT 500`)
    .all() as Array<Record<string, unknown>>;
  return { summary: summarizeFillOutcomes(db), success_rates: rates };
}
