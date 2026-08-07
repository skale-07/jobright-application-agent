import type { Db } from "../storage/db/client.js";
import type { DiscoveredField } from "../ats/adapter.js";
import {
  essayFieldsOnly,
  isDemographicsField,
} from "./essayDetector.js";
import {
  ESSAY_ANSWER_PREFIX,
  listHumanEssayAnswers,
} from "./essayAnswers.js";

/**
 * The narrow, auditable exception to "never fill textarea".
 *
 * The main fill path (approvedFillPlan / assertExecutableApprovedEntry)
 * continues to reject every textarea unconditionally — that guard is not
 * weakened. Essay text may reach a page only through this module, and only
 * when it originates from an application_answers row written by a human via
 * resume-essay. Provenance is re-read from the database at execution time so
 * a tampered in-memory entry cannot smuggle generated text.
 */
export type HumanEssayEntry = {
  field_id: string;
  label: string;
  type: "textarea";
  action: "ESSAY_HUMAN";
  value: string;
  answer_row_id: string;
  provenance: "human";
};

/**
 * Join discovered essay fields to stored human answers. Fields without an
 * answer are simply absent from the result — they stay unfilled.
 */
export function buildHumanEssayEntries(
  db: Db,
  applicationId: string,
  fields: DiscoveredField[],
): HumanEssayEntry[] {
  const essays = essayFieldsOnly(fields).filter((e) => e.is_essay);
  const answers = listHumanEssayAnswers(db, applicationId);
  const byKey = new Map(answers.map((a) => [a.field_key, a]));

  const entries: HumanEssayEntry[] = [];
  for (const essay of essays) {
    const field = fields.find((f) => f.id === essay.field_id);
    if (!field || field.type !== "textarea") continue;
    if (isDemographicsField(field)) continue;
    const answer = byKey.get(essay.field_id);
    if (!answer || answer.text.trim() === "") continue;
    entries.push({
      field_id: field.id,
      label: field.label,
      type: "textarea",
      action: "ESSAY_HUMAN",
      value: answer.text,
      answer_row_id: answer.id,
      provenance: "human",
    });
  }
  return entries;
}

/**
 * Execution-time guard. Re-reads the answer row so the only way essay text
 * reaches the page is a human-sourced database row that still exists.
 */
export function assertExecutableHumanEssayEntry(
  db: Db,
  entry: HumanEssayEntry,
): void {
  if (entry.action !== "ESSAY_HUMAN" || entry.provenance !== "human") {
    throw new Error(
      `Refusing essay fill for ${entry.field_id}: not a human essay entry`,
    );
  }
  if (entry.type !== "textarea") {
    throw new Error(
      `Refusing essay fill for ${entry.field_id}: not a textarea`,
    );
  }
  if (typeof entry.value !== "string" || entry.value.trim() === "") {
    throw new Error(`Refusing essay fill for ${entry.field_id}: empty text`);
  }
  if (
    isDemographicsField({
      id: entry.field_id,
      label: entry.label,
      type: entry.type,
      required: false,
    })
  ) {
    throw new Error(
      `Refusing essay fill for ${entry.field_id}: demographics field`,
    );
  }

  const row = db
    .prepare(
      `SELECT source, canonical_field, value_json FROM application_answers WHERE id = ?`,
    )
    .get(entry.answer_row_id) as
    | { source: string; canonical_field: string; value_json: string }
    | undefined;
  if (!row) {
    throw new Error(
      `Refusing essay fill for ${entry.field_id}: answer row missing`,
    );
  }
  if (row.source !== "human") {
    throw new Error(
      `Refusing essay fill for ${entry.field_id}: answer source is "${row.source}", not human`,
    );
  }
  if (!row.canonical_field.startsWith(ESSAY_ANSWER_PREFIX)) {
    throw new Error(
      `Refusing essay fill for ${entry.field_id}: answer row is not an essay answer`,
    );
  }
  const stored = JSON.parse(row.value_json) as { text?: unknown };
  if (stored.text !== entry.value) {
    throw new Error(
      `Refusing essay fill for ${entry.field_id}: entry text does not match stored answer`,
    );
  }
}
