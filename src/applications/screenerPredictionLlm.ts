/**
 * Screener answer PREDICTION — predict-into-review with one-click promote.
 *
 * The gap this closes: a required question that no registry key, custom
 * bank entry, or profile rule covers today just parks, every single time.
 * Now the question is captured at plan time, the LLM proposes an answer
 * from the operator's OWN context (about-me.md + their existing bank
 * answers), and the proposal lands in a review item. The operator approves
 * or edits ONCE; the approved answer joins screeners.json as a custom
 * entry and every future occurrence fills deterministically — the model's
 * role shrinks as the bank compounds.
 *
 * Trust boundaries (unchanged from the rest of the screener system):
 *   - A prediction NEVER fills a form. Ever. It exists only inside the
 *     review item until the human promotes it.
 *   - The promote resolver (reviewResolvers.ts) is the single write path
 *     into the bank's custom section.
 *   - Choice questions are validated at prediction time: the proposed
 *     answer must literally match one of the captured page options
 *     (exact → case-insensitive) or the prediction is rejected.
 *   - Demographic questions never reach this module (filtered upstream,
 *     same as the bank path).
 *
 * Gated by SCREENER_PREDICT_LLM_ENABLED (fail closed) + an LLM key (Anthropic preferred, OpenAI fallback).
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import { migrate, openDatabase } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  hasLlmKey,
  LLM_KEY_HINT,
  makeLlmClient,
  type EmailLlmClient,
} from "../contacts/emailLlm.js";
import { normalizeScreenerLabel } from "../candidate/screenerMatch.js";
import { labelFingerprint } from "./screenerLlmMap.js";
import { tryLoadScreenerBank } from "../candidate/screenersIO.js";
import { tryLoadAboutMe } from "./essayDraft.js";
import { upsertOpenReviewItem } from "../queue/reviewItems.js";

let migratedFor: Db | null = null;
function ensureMigrated(db: Db): void {
  if (migratedFor !== db) {
    migrate(db);
    migratedFor = db;
  }
}

export type UnmappedScreenerQuestion = {
  label: string;
  type: string;
  options?: string[] | undefined;
};

/**
 * Plan-time capture: remember questions nothing could answer. Local-only
 * (no LLM here), deduped by label fingerprint, and flag-gated so a
 * disabled install never even opens the queue table.
 */
export function recordUnmappedScreenerQuestions(input: {
  questions: UnmappedScreenerQuestion[];
  ats?: string | null;
  applicationId?: string | null;
  db?: Db;
}): number {
  const cfg = getConfig();
  if (!cfg.screenerPredictLlmEnabled || input.questions.length === 0) return 0;
  let ownedDb = false;
  const db =
    input.db ??
    (() => {
      ownedDb = true;
      return openDatabase();
    })();
  try {
    ensureMigrated(db);
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO screener_predictions
         (id, label_fingerprint, label, raw_label, control, options_json, ats,
          first_seen_application_id, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
    );
    const now = new Date().toISOString();
    let recorded = 0;
    for (const q of input.questions) {
      const norm = normalizeScreenerLabel(q.label);
      if (norm.length < 8) continue; // too short to be a real question
      const r = stmt.run(
        randomUUID(),
        labelFingerprint(q.label),
        norm,
        q.label.slice(0, 300),
        q.type,
        q.options && q.options.length > 0
          ? JSON.stringify(q.options.slice(0, 20))
          : null,
        input.ats ?? null,
        input.applicationId ?? null,
        now,
        now,
      );
      recorded += r.changes;
    }
    return recorded;
  } finally {
    if (ownedDb) db.close();
  }
}

const SYSTEM_PROMPT = `You predict a job-application screener ANSWER for a candidate, using ONLY the facts in their context (an about-me document and their existing saved answers). One entry per input question, in order.
Rules:
- The answer must be short (a value, not an essay): max 100 characters.
- For a question with "options", the answer MUST be copied verbatim from that options list. If none fits the candidate's facts, use null.
- Never guess facts the context doesn't state. Unknown ⇒ null.
- Never answer demographic/self-ID questions (gender, race, veteran, disability): always null.
- Also propose a short snake_case key naming the question (e.g. "expected_graduation"), and a one-sentence basis citing which context fact the answer comes from.
Output STRICT JSON: {"predictions":[{"label": string, "answer": string|null, "key": string, "basis": string}]}`;

export type ScreenerPredictionBatchReport = {
  questions_considered: number;
  predicted: number;
  rejected: number;
  notes: string[];
};

/** Deterministic gate every model proposal must survive. */
export function validatePrediction(
  answer: unknown,
  options: string[] | null,
): { ok: boolean; value: string; reason: string } {
  if (typeof answer !== "string" || answer.trim() === "") {
    return { ok: false, value: "", reason: "no answer" };
  }
  const value = answer.trim();
  if (value.length > 100) return { ok: false, value, reason: "too long" };
  if (/\[(insert|your|todo|placeholder)/i.test(value)) {
    return { ok: false, value, reason: "placeholder text" };
  }
  if (options && options.length > 0) {
    const exact = options.find((o) => o === value);
    if (exact !== undefined) return { ok: true, value: exact, reason: "exact_option" };
    const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
    const ci = options.filter((o) => norm(o) === norm(value));
    if (ci.length === 1) return { ok: true, value: ci[0]!, reason: "ci_option" };
    return { ok: false, value, reason: "answer matches no page option" };
  }
  return { ok: true, value, reason: "free_text" };
}

/**
 * Post-session batch (worker-called, like essay drafts): predict answers
 * for PENDING questions and open ONE review item per newly-predicted
 * question. Fail-open — errors become notes, never session failures.
 * Rows are one-shot: once PREDICTED (item opened) or REJECTED (2 tries),
 * they never resurface, so a dismissed suggestion stays dismissed.
 */
export async function generateScreenerPredictions(input: {
  db: Db;
  client?: EmailLlmClient;
  limit?: number;
}): Promise<ScreenerPredictionBatchReport> {
  const cfg = getConfig();
  const report: ScreenerPredictionBatchReport = {
    questions_considered: 0,
    predicted: 0,
    rejected: 0,
    notes: [],
  };
  if (!cfg.screenerPredictLlmEnabled) {
    report.notes.push("screener predictions skipped: SCREENER_PREDICT_LLM_ENABLED off");
    return report;
  }
  if (!input.client && !hasLlmKey(cfg)) {
    report.notes.push(`screener predictions skipped: no LLM key (${LLM_KEY_HINT})`);
    return report;
  }
  const about = tryLoadAboutMe();
  const bank = tryLoadScreenerBank();
  if (!about && !bank) {
    report.notes.push(
      "screener predictions skipped: no context (about-me.md and screeners.json both missing)",
    );
    return report;
  }

  const { db } = input;
  ensureMigrated(db);
  const rows = db
    .prepare(
      `SELECT id, label, raw_label, control, options_json, first_seen_application_id, attempts
       FROM screener_predictions
       WHERE status = 'PENDING' AND attempts < 2
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(Math.min(input.limit ?? 12, 25)) as Array<{
    id: string;
    label: string;
    raw_label: string;
    control: string;
    options_json: string | null;
    first_seen_application_id: string | null;
    attempts: number;
  }>;
  if (rows.length === 0) return report;
  report.questions_considered = rows.length;

  const bump = db.prepare(
    `UPDATE screener_predictions SET attempts = attempts + 1, updated_at = ? WHERE id = ?`,
  );
  const now = new Date().toISOString();
  for (const r of rows) bump.run(now, r.id);

  const client = input.client ?? makeLlmClient();
  let parsed: { predictions?: Array<Record<string, unknown>> };
  try {
    const { text } = await client.generateJson({
      system: SYSTEM_PROMPT,
      user: JSON.stringify({
        candidate_context: about ?? "",
        saved_answers: bank?.answers ?? {},
        questions: rows.map((r) => ({
          label: r.raw_label,
          options: r.options_json ? (JSON.parse(r.options_json) as string[]) : undefined,
        })),
      }),
    });
    parsed = JSON.parse(text) as { predictions?: Array<Record<string, unknown>> };
  } catch (err) {
    report.notes.push(
      `screener prediction call failed (will retry next session): ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    );
    return report;
  }

  const byLabel = new Map<string, Record<string, unknown>>();
  for (const p of parsed.predictions ?? []) {
    if (typeof p["label"] === "string") {
      byLabel.set(normalizeScreenerLabel(p["label"]), p);
    }
  }

  const markPredicted = db.prepare(
    `UPDATE screener_predictions
     SET status = 'PREDICTED', prediction_json = ?, review_item_id = ?, updated_at = ?
     WHERE id = ?`,
  );
  const markRejected = db.prepare(
    `UPDATE screener_predictions
     SET status = CASE WHEN attempts >= 2 THEN 'REJECTED' ELSE 'PENDING' END,
         prediction_json = ?, updated_at = ?
     WHERE id = ?`,
  );

  for (const row of rows) {
    const p = byLabel.get(row.label);
    const options = row.options_json ? (JSON.parse(row.options_json) as string[]) : null;
    const check = validatePrediction(p?.["answer"] ?? null, options);
    if (!p || !check.ok) {
      markRejected.run(
        JSON.stringify({ rejected: check.reason }),
        new Date().toISOString(),
        row.id,
      );
      report.rejected += 1;
      report.notes.push(
        `prediction rejected "${row.raw_label.slice(0, 50)}": ${check.reason}`,
      );
      continue;
    }
    const key = suggestKey(p["key"], row.label);
    const basis = typeof p["basis"] === "string" ? p["basis"].slice(0, 200) : "";
    const prediction = { answer: check.value, key, basis, match: check.reason };
    const { item } = upsertOpenReviewItem(db, {
      ...(row.first_seen_application_id
        ? { applicationId: row.first_seen_application_id }
        : {}),
      kind: "MANUAL",
      title: `New question learned: "${row.raw_label.slice(0, 80)}"`,
      payload: {
        source: "screener_prediction",
        prediction_id: row.id,
        question: row.raw_label,
        control: row.control,
        options,
        predicted_answer: check.value,
        suggested_key: key,
        basis,
        validation_level: "UNVERIFIED",
        hint: "Approve (or edit) once and this answer joins your bank — future forms fill it automatically.",
      },
    });
    markPredicted.run(
      JSON.stringify(prediction),
      item.id,
      new Date().toISOString(),
      row.id,
    );
    report.predicted += 1;
  }

  logger.info("screener predictions generated (suggestions only)", {
    service: "screeners",
    action: "predict_batch",
    metadata: {
      considered: report.questions_considered,
      predicted: report.predicted,
      rejected: report.rejected,
    },
  });
  return report;
}

/** Safe snake_case key from the model suggestion or the label itself. */
export function suggestKey(raw: unknown, normalizedLabel: string): string {
  const fromModel =
    typeof raw === "string"
      ? raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
      : "";
  if (/^[a-z0-9_]{2,60}$/.test(fromModel)) return fromModel;
  const fromLabel = normalizedLabel
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 5)
    .join("_")
    .replace(/[^a-z0-9_]/g, "");
  return /^[a-z0-9_]{2,60}$/.test(fromLabel) ? fromLabel : `question_${Date.now() % 100000}`;
}
