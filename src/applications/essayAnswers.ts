import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import type { DiscoveredField } from "../ats/adapter.js";
import { essayFieldsOnly, type EssayClassification } from "./essayDetector.js";
import {
  listOpenReviewItems,
  resolveReviewItem,
  upsertOpenReviewItem,
  type ReviewItem,
} from "../queue/reviewItems.js";
import { getApplication, transitionApplication } from "../queue/stateMachine.js";

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
  // Only REQUIRED essay fields are asked for — optional textareas are left
  // blank by policy, so listing them here would hold the item (and the
  // application) open forever waiting for answers nobody owes.
  const requiredIds = new Set(
    input.fields.filter((f) => f.required).map((f) => f.id),
  );
  const essays = essayFieldsOnly(input.fields).filter(
    (e) => e.is_essay && requiredIds.has(e.field_id),
  );
  const { item, created } = upsertOpenReviewItem(db, {
    applicationId: input.applicationId,
    kind: "ESSAY",
    title: ESSAY_REVIEW_TITLE,
    payload: { essays },
  });
  return { item, created, essays };
}

/**
 * Record one human essay answer and settle the surrounding workflow:
 * resolve the ESSAY review item once every asked-for field has an answer,
 * and move ESSAY_REQUIRED → FIELD_VERIFICATION when that happens. This is
 * the shared body behind the resume-essay CLI and the console endpoint —
 * extracted so the two can never diverge.
 */
export function recordEssayAnswer(
  db: Db,
  input: {
    applicationId: string;
    fieldKey: string;
    text: string;
    /** Where the text came from, for the answer row (file path or "console"). */
    sourceFile?: string;
    resolvedBy?: string;
  },
): {
  answerId: string;
  reviewResolved: boolean;
  unansweredFields: string[];
  applicationState: string | undefined;
} {
  const saved = saveHumanEssayAnswer(db, {
    applicationId: input.applicationId,
    fieldKey: input.fieldKey,
    text: input.text,
    ...(input.sourceFile ? { sourceFile: input.sourceFile } : {}),
  });

  const essayItems = listOpenReviewItems(db).filter(
    (i) => i.kind === "ESSAY" && i.application_id === input.applicationId,
  );
  let resolved = false;
  let remaining: string[] = [];
  for (const item of essayItems) {
    remaining = unansweredEssayFieldKeys(db, input.applicationId, item);
    if (remaining.length === 0) {
      resolveReviewItem(db, item.id, {
        resolved_by: input.resolvedBy ?? "resume-essay",
        answers: listHumanEssayAnswers(db, input.applicationId).map((a) => ({
          field_key: a.field_key,
          chars: a.text.length,
        })),
      });
      resolved = true;
    }
  }
  if (
    resolved &&
    getApplication(db, input.applicationId)?.state === "ESSAY_REQUIRED"
  ) {
    transitionApplication(db, {
      applicationId: input.applicationId,
      nextState: "FIELD_VERIFICATION",
      reason: `all essay answers provided via ${input.resolvedBy ?? "resume-essay"}`,
    });
  }

  return {
    answerId: saved.id,
    reviewResolved: resolved,
    unansweredFields: remaining,
    applicationState: getApplication(db, input.applicationId)?.state,
  };
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
