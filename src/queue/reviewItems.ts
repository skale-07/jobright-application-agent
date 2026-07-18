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
