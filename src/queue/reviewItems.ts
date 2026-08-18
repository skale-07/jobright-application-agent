import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";

export const REVIEW_KINDS = [
  "UNCERTAIN_SUBMISSION",
  "AMBIGUOUS_FIELD",
  "ESSAY",
  "AUTH_REQUIRED",
  "CAPTCHA_REQUIRED",
  "UNSUPPORTED_ATS",
  "DUPLICATE_RISK",
  "MANUAL",
] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type ReviewStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "DISMISSED";

export type ReviewItem = {
  id: string;
  application_id: string | null;
  kind: ReviewKind;
  status: ReviewStatus;
  title: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution_json: string | null;
};

/**
 * Titles that are ADVISORY: a note about one field, not a reason the whole
 * application cannot proceed.
 *
 * The pipeline halts on ANY open review item. That is right for "sign in",
 * "solve the captcha", "this URL is the wrong company" — you genuinely
 * cannot continue. It is wrong for "we could not map one dropdown": the
 * live corpus showed a single Lever form producing 20 such notes, each
 * freezing an application whose other 28 fields were fillable, while the
 * submit-side required-completeness scan already refuses anything
 * genuinely incomplete at the click boundary.
 *
 * Advisory items still appear in the queue and still want an answer — they
 * just stop being a full stop.
 *
 * Completeness-gate items ("N required question(s) unanswered… then requeue")
 * are advisory too. The click-side scan already refuses a genuinely empty
 * form. Halting the pipeline on the leftover item deadlocks retry: Jump
 * 2026-08-17 requeued, then stopped at QUEUED on the prior false miss.
 */
const ADVISORY_TITLE_PREFIXES = [
  "Answer needed:",
  "New question learned:",
  "Submit selector proposal",
];

const COMPLETENESS_UNANSWERED_RE =
  /^\d+ required question\(s\) unanswered\b/;

/** Last submit's completeness refusal — not a wall on the next attempt. */
export function isCompletenessUnansweredReview(item: {
  kind: ReviewKind;
  title: string;
}): boolean {
  return item.kind === "MANUAL" && COMPLETENESS_UNANSWERED_RE.test(item.title);
}

/** Nav parked on an employer sign-in page. Not congruence; not a human captcha. */
export const PORTAL_AUTH_WALL_TITLE =
  "Navigation blocked by employer identity wall";

export function isAdvisoryReviewItem(item: {
  kind: ReviewKind;
  title: string;
}): boolean {
  // Only MANUAL can be advisory. Every other kind names a wall.
  if (item.kind !== "MANUAL") return false;
  if (isCompletenessUnansweredReview(item)) return true;
  return ADVISORY_TITLE_PREFIXES.some((p) => item.title.startsWith(p));
}

/**
 * Standing PORTAL_LOGIN_* credentials are the operator saying "keep trying
 * this sign-in". Without them the wall stays a human gate. With them, an
 * armed session may retry navigation (once per session via the seen-set).
 */
export function isRetryablePortalAuthWall(
  item: { kind: ReviewKind; title: string },
  standingPortalPassword: string | undefined,
): boolean {
  return (
    Boolean(standingPortalPassword) &&
    item.kind === "MANUAL" &&
    item.title === PORTAL_AUTH_WALL_TITLE
  );
}

export function createReviewItem(
  db: Db,
  input: {
    applicationId?: string;
    kind: ReviewKind;
    title: string;
    payload?: Record<string, unknown>;
  },
): ReviewItem {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO review_items (
      id, application_id, kind, status, title, payload_json,
      created_at, updated_at, resolved_at, resolution_json
    ) VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    id,
    input.applicationId ?? null,
    input.kind,
    input.title,
    JSON.stringify(input.payload ?? {}),
    now,
    now,
  );
  return db.prepare(`SELECT * FROM review_items WHERE id = ?`).get(id) as ReviewItem;
}

/**
 * Create or return existing open review with the same kind+title(+application).
 * Prevents auth-expiry spam.
 */
export function upsertOpenReviewItem(
  db: Db,
  input: {
    applicationId?: string;
    kind: ReviewKind;
    title: string;
    payload?: Record<string, unknown>;
  },
): { item: ReviewItem; created: boolean } {
  const existing = (
    input.applicationId
      ? db
          .prepare(
            `SELECT * FROM review_items
             WHERE kind = ? AND application_id = ? AND title = ?
               AND status IN ('OPEN', 'IN_PROGRESS')
             LIMIT 1`,
          )
          .get(input.kind, input.applicationId, input.title)
      : db
          .prepare(
            `SELECT * FROM review_items
             WHERE kind = ? AND application_id IS NULL AND title = ?
               AND status IN ('OPEN', 'IN_PROGRESS')
             LIMIT 1`,
          )
          .get(input.kind, input.title)
  ) as ReviewItem | undefined;

  if (existing) {
    return { item: existing, created: false };
  }

  try {
    return { item: createReviewItem(db, input), created: true };
  } catch {
    // Unique index race — re-read
    const raced = (
      input.applicationId
        ? db
            .prepare(
              `SELECT * FROM review_items
               WHERE kind = ? AND application_id = ? AND title = ?
                 AND status IN ('OPEN', 'IN_PROGRESS') LIMIT 1`,
            )
            .get(input.kind, input.applicationId, input.title)
        : db
            .prepare(
              `SELECT * FROM review_items
               WHERE kind = ? AND application_id IS NULL AND title = ?
                 AND status IN ('OPEN', 'IN_PROGRESS') LIMIT 1`,
            )
            .get(input.kind, input.title)
    ) as ReviewItem | undefined;
    if (raced) return { item: raced, created: false };
    throw new Error("Failed to upsert review item");
  }
}

/** Shallow-merge a patch into an OPEN item's payload (drafts, annotations). */
export function updateReviewItemPayload(
  db: Db,
  reviewItemId: string,
  patch: Record<string, unknown>,
): ReviewItem | null {
  const row = db
    .prepare(
      `SELECT * FROM review_items WHERE id = ? AND status IN ('OPEN','IN_PROGRESS')`,
    )
    .get(reviewItemId) as ReviewItem | undefined;
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse((row as unknown as { payload_json: string }).payload_json ?? "{}");
  } catch {
    payload = {};
  }
  const merged = { ...payload, ...patch };
  db.prepare(`UPDATE review_items SET payload_json = ? WHERE id = ?`).run(
    JSON.stringify(merged),
    reviewItemId,
  );
  return db.prepare(`SELECT * FROM review_items WHERE id = ?`).get(reviewItemId) as ReviewItem;
}

export function listOpenReviewItems(db: Db): ReviewItem[] {
  return db
    .prepare(
      `SELECT * FROM review_items WHERE status IN ('OPEN', 'IN_PROGRESS')
       ORDER BY created_at`,
    )
    .all() as ReviewItem[];
}

export function resolveReviewItem(
  db: Db,
  id: string,
  resolution: Record<string, unknown>,
  status: "RESOLVED" | "DISMISSED" = "RESOLVED",
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE review_items
     SET status = ?, resolved_at = ?, updated_at = ?, resolution_json = ?
     WHERE id = ?`,
  ).run(status, now, now, JSON.stringify(resolution), id);
}
