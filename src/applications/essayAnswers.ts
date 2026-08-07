import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import type { DiscoveredField } from "../ats/adapter.js";
import { essayFieldsOnly, type EssayClassification } from "./essayDetector.js";
import { upsertOpenReviewItem, type ReviewItem } from "../queue/reviewItems.js";

export const ESSAY_ANSWER_PREFIX = "essay:";
export const ESSAY_REVIEW_TITLE = "Essay answers required";

export type EssayAnswerRow = {
  id: string;
  application_id: string;
  canonical_field: string;
  /** The bare field key without the essay: prefix. */
  field_key: string;
  text: string;
  source: string;
};

/**
 * Store an operator-authored essay answer. source is always 'human' —
 * there is no other legal producer of essay text in this codebase.
 */
export function saveHumanEssayAnswer(
  db: Db,
  input: {
    applicationId: string;
    fieldKey: string;
    text: string;
    sourceFile?: string;
  },
): { id: string } {
  const text = input.text.trim();
  if (text === "") {
    throw new Error("Refusing to save an empty essay answer");
  }
  const canonical = `${ESSAY_ANSWER_PREFIX}${input.fieldKey}`;
  const existing = db
    .prepare(
      `SELECT id FROM application_answers
       WHERE application_id = ? AND canonical_field = ?`,
    )
    .get(input.applicationId, canonical) as { id: string } | undefined;

  const valueJson = JSON.stringify({
    text,
    source_file: input.sourceFile ?? null,
    saved_at: new Date().toISOString(),
  });

  if (existing) {
    db.prepare(
      `UPDATE application_answers SET value_json = ?, source = 'human', confidence = 1
       WHERE id = ?`,
    ).run(valueJson, existing.id);
    return { id: existing.id };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO application_answers (
      id, application_id, canonical_field, value_json, source, confidence
    ) VALUES (?, ?, ?, ?, 'human', 1)`,
  ).run(id, input.applicationId, canonical, valueJson);
  return { id };
}

export function listHumanEssayAnswers(
  db: Db,
  applicationId: string,
): EssayAnswerRow[] {
  const rows = db
    .prepare(
      `SELECT id, application_id, canonical_field, value_json, source
       FROM application_answers
       WHERE application_id = ? AND source = 'human'
         AND canonical_field LIKE '${ESSAY_ANSWER_PREFIX}%'`,
    )
    .all(applicationId) as Array<{
    id: string;
    application_id: string;
    canonical_field: string;
    value_json: string;
    source: string;
  }>;
  return rows.map((r) => {
    const parsed = JSON.parse(r.value_json) as { text?: unknown };
    return {
      id: r.id,
      application_id: r.application_id,
      canonical_field: r.canonical_field,
      field_key: r.canonical_field.slice(ESSAY_ANSWER_PREFIX.length),
      text: typeof parsed.text === "string" ? parsed.text : "",
      source: r.source,
    };
  });
}

export function getHumanEssayAnswer(
  db: Db,
  applicationId: string,
  fieldKey: string,
): EssayAnswerRow | undefined {
  return listHumanEssayAnswers(db, applicationId).find(
    (r) => r.field_key === fieldKey,
  );
}

/**
 * Open (or return the existing) ESSAY review item listing what the human
 * still needs to write. Payload carries the essay classifications so the
 * operator sees labels and estimated lengths without reopening the page.
 */
export function openEssayReviewItem(
  db: Db,
  input: {
    applicationId: string;
    fields: DiscoveredField[];
  },
): { item: ReviewItem; created: boolean; essays: EssayClassification[] } {
  const essays = essayFieldsOnly(input.fields).filter((e) => e.is_essay);
  const { item, created } = upsertOpenReviewItem(db, {
    applicationId: input.applicationId,
    kind: "ESSAY",
    title: ESSAY_REVIEW_TITLE,
    payload: { essays },
  });
  return { item, created, essays };
}

/** Field keys from an ESSAY review item's payload that still lack answers. */
export function unansweredEssayFieldKeys(
  db: Db,
  applicationId: string,
  item: ReviewItem,
): string[] {
  const payload = JSON.parse(item.payload_json) as {
    essays?: Array<{ field_id?: string }>;
  };
  const required = (payload.essays ?? [])
    .map((e) => e.field_id)
    .filter((v): v is string => typeof v === "string");
  const answered = new Set(
    listHumanEssayAnswers(db, applicationId).map((r) => r.field_key),
  );
  return required.filter((k) => !answered.has(k));
}
