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
 * Trust boundaries:
 *   - Post-session batch: a prediction NEVER fills a form. It exists only
 *     inside the review item until the human promotes it.
 *   - Plan-time (`predictAnswersForQuestions`, same flag): a prediction
 *     MAY fill when `validatePrediction` passes — option answers must
 *     match the page verbatim; free-text must appear in about-me or
 *     public profile facts (length ≥ 12). Ungrounded invention parks.
 *     Predictions are not written into screeners.json.
 *   - The promote resolver (reviewResolvers.ts) is the single write path
 *     into the bank's custom section.
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
import { loadPublicProfile } from "../candidate/publicProfileIO.js";
import { tryLoadAboutMe } from "./essayDraft.js";
import { isApplicationConsentField } from "./consentFields.js";
import { isDemographicsField } from "./essayDetector.js";
import {
  resolveReviewItem,
  updateReviewItemPayload,
  upsertOpenReviewItem,
} from "../queue/reviewItems.js";

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
 * Plan-time capture: remember questions nothing could answer, and open a
 * review item for each NEW one immediately — the operator sees "this form
 * asked X and Dispatch left it blank" in the console right away and can
 * type the answer in place, whether or not the LLM prediction batch ever
 * runs. Local-only (no LLM here, no spend), deduped by label fingerprint.
 * Only the PREDICTION batch below stays behind SCREENER_PREDICT_LLM_ENABLED;
 * capture is telemetry-class and always on when a caller provides context.
 */
export function recordUnmappedScreenerQuestions(input: {
  questions: UnmappedScreenerQuestion[];
  ats?: string | null;
  applicationId?: string | null;
  db?: Db;
}): number {
  if (input.questions.length === 0) return 0;
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
    const setItem = db.prepare(
      `UPDATE screener_predictions SET review_item_id = ?, updated_at = ? WHERE id = ?`,
    );
    const now = new Date().toISOString();
    let recorded = 0;
    for (const q of input.questions) {
      const norm = normalizeScreenerLabel(q.label);
      if (!isCaptureWorthyQuestion(q)) continue;
      const rowId = randomUUID();
      const options =
        q.options && q.options.length > 0 ? q.options.slice(0, 20) : null;
      const r = stmt.run(
        rowId,
        labelFingerprint(q.label),
        norm,
        q.label.slice(0, 300),
        q.type,
        options ? JSON.stringify(options) : null,
        input.ats ?? null,
        input.applicationId ?? null,
        now,
        now,
      );
      recorded += r.changes;
      if (r.changes === 0) continue; // known question — an item exists or was handled
      // Surface immediately: the operator answers in the console and the
      // answer joins the bank via the promote resolver (sole write path).
      // Best-effort — a review-item failure must never break a fill plan.
      try {
        const raw = q.label.slice(0, 300);
        const { item } = upsertOpenReviewItem(db, {
          ...(input.applicationId ? { applicationId: input.applicationId } : {}),
          kind: "MANUAL",
          title: `Answer needed: "${raw.slice(0, 80)}"`,
          payload: {
            source: "screener_question",
            prediction_id: rowId,
            question: raw,
            control: q.type,
            options,
            predicted_answer: null,
            suggested_key: suggestKey(undefined, norm),
            validation_level: "UNVERIFIED",
            hint: "Dispatch left this blank on the form. Answer once and it joins your bank — every future form fills it automatically.",
          },
        });
        setItem.run(item.id, new Date().toISOString(), rowId);
      } catch {
        // queue row still exists; the prediction batch can open an item later
      }
    }
    return recorded;
  } finally {
    if (ownedDb) db.close();
  }
}

const SYSTEM_PROMPT = `You predict a job-application screener ANSWER for a candidate, using ONLY the facts in their context (an about-me document, their existing saved answers, and profile_facts from their structured profile). One entry per input question, in order.
Rules:
- The answer must be short (a value, not an essay): max 100 characters.
- For a question with "options", the answer MUST be copied verbatim from that options list. If none fits the candidate's facts, use null.
- READ THE QUESTION'S OWN INSTRUCTIONS. If the label instructs a fallback — e.g. 'Select "Other" if not listed' — and the candidate's true answer (e.g. their university from profile_facts) is NOT among the options while that fallback option IS, answer the fallback option verbatim (e.g. "Other"). This is following the form, not guessing.
- Office/location-preference questions with options: pick the option consistent with the candidate's location and relocation facts (e.g. nearest listed office). If the context gives no basis to prefer one, use null. NEVER answer with a city that is not among the options.
- Never guess facts the context doesn't state. Unknown ⇒ null.
- Never answer demographic/self-ID questions (gender, race, veteran, disability): always null.
- Also propose a short snake_case key naming the question (e.g. "expected_graduation"), and a one-sentence basis citing which context fact the answer comes from.
Output STRICT JSON: {"predictions":[{"label": string, "answer": string|null, "key": string, "basis": string}]}`;

/**
 * Non-sensitive profile facts for the prediction context. The live batch
 * (cc02e067) nulled 12/12 questions — including "Which university are you
 * currently attending? Select \"Other\" if not listed" — because the model
 * only ever saw about-me.md (absent on the operator's machine) and the
 * bank. The structured profile already knows school/degree/major/city.
 * Contact and street-address fields stay out; demographic/self-ID facts
 * live in sensitive-profile and are never loaded here.
 */
export function tryLoadProfileFacts(): Record<string, unknown> | null {
  try {
    const p = loadPublicProfile() as unknown as Record<string, unknown>;
    const addr = (p["address"] ?? {}) as Record<string, unknown>;
    const facts: Record<string, unknown> = {};
    const take = (key: string, value: unknown): void => {
      if (value !== undefined && value !== null && value !== "") facts[key] = value;
    };
    take("school", p["school"]);
    take("degree", p["degree"]);
    take("major", p["major"]);
    take("additional_fields_of_study", p["additional_fields_of_study"]);
    take("graduation_month", p["graduation_month"]);
    take("graduation_year", p["graduation_year"]);
    take("start_month", p["start_month"]);
    take("start_year", p["start_year"]);
    take("gpa", p["gpa"]);
    take("work_authorization", p["work_authorization"]);
    take("requires_sponsorship", p["requires_sponsorship"]);
    take("relocation", p["relocation"]);
    take("current_company", p["current_company"]);
    take("city", addr["city"]);
    take("state", addr["state"]);
    take("country", addr["country"]);
    return Object.keys(facts).length > 0 ? facts : null;
  } catch {
    return null;
  }
}

/** Inspector-placeholder labels ("field_12" / "field 12") carry no question text. */
export function isUnusableLabel(label: string): boolean {
  return /^(?:field|f)[_ ]?\d+$/i.test(label.trim());
}

function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Whether this discovered control is a real question the operator (or
 * predictor) should see. Live queue was drowned in major-option checkboxes
 * ("Electrical Engineering"), UUID labels, and `field_12` inspector misses.
 */
export function isCaptureWorthyQuestion(q: {
  label: string;
  type: string;
}): boolean {
  const label = decodeBasicHtmlEntities(q.label).replace(/\s+/g, " ").trim();
  if (label.length < 8) return false;
  if (isUnusableLabel(label)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(label)) return false;
  if (
    isDemographicsField({
      id: "_",
      label,
      type: "text",
      required: false,
    })
  ) {
    return false;
  }
  if (q.type === "checkbox") {
    if (isApplicationConsentField({ type: "checkbox", label })) return false;
    return /\?|(do you|have you|are you|i (agree|certify|acknowledge|confirm)|please (select|indicate|check|confirm))/i.test(
      label,
    );
  }
  return true;
}

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

function answerGroundedInContext(
  answer: string,
  about: string | null,
  facts: Record<string, unknown> | null,
): boolean {
  const a = answer.toLowerCase().trim();
  if (a.length < 12) return false;
  const blob = `${about ?? ""} ${JSON.stringify(facts ?? {})}`.toLowerCase();
  return blob.includes(a);
}

/**
 * Plan-time fill from operator context. Option answers must match the
 * page verbatim. Free-text must appear in about-me or profile facts —
 * ungrounded invention still parks as Answer needed. Does not write
 * screeners.json.
 */
export async function predictAnswersForQuestions(
  questions: Array<{
    id: string;
    label: string;
    options?: string[] | undefined;
  }>,
  client?: EmailLlmClient,
): Promise<Map<string, { value: string; basis: string }>> {
  const out = new Map<string, { value: string; basis: string }>();
  const cfg = getConfig();
  if (!cfg.screenerPredictLlmEnabled) return out;
  if (!client && !hasLlmKey(cfg)) return out;
  const askable = questions
    .filter((q) => isCaptureWorthyQuestion({ label: q.label, type: "text" }))
    .slice(0, 12);
  if (askable.length === 0) return out;
  const about = tryLoadAboutMe();
  const bank = tryLoadScreenerBank();
  const profileFacts = tryLoadProfileFacts();
  if (!about && !bank && !profileFacts) return out;
  try {
    const llm = client ?? makeLlmClient();
    const { text } = await llm.generateJson({
      system: SYSTEM_PROMPT,
      user: JSON.stringify({
        candidate_context: about ?? "",
        saved_answers: bank?.answers ?? {},
        profile_facts: profileFacts ?? {},
        questions: askable.map((q) => ({
          label: q.label,
          options: q.options,
        })),
      }),
    });
    const parsed = JSON.parse(text) as {
      predictions?: Array<Record<string, unknown>>;
    };
    const byLabel = new Map<string, Record<string, unknown>>();
    for (const p of parsed.predictions ?? []) {
      if (typeof p["label"] === "string") {
        byLabel.set(normalizeScreenerLabel(p["label"]), p);
      }
    }
    for (const q of askable) {
      const p = byLabel.get(normalizeScreenerLabel(q.label));
      const options = q.options && q.options.length > 0 ? q.options : null;
      const check = validatePrediction(p?.["answer"] ?? null, options);
      if (!check.ok) continue;
      if (!options && !answerGroundedInContext(check.value, about, profileFacts)) {
        continue;
      }
      const basis =
        typeof p?.["basis"] === "string" ? p["basis"].slice(0, 200) : "predicted";
      out.set(q.id, { value: check.value, basis });
    }
  } catch {
    return out;
  }
  return out;
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
  const profileFacts = tryLoadProfileFacts();
  if (!about && !bank && !profileFacts) {
    report.notes.push(
      "screener predictions skipped: no context (about-me.md, screeners.json, and public-profile.json all missing)",
    );
    return report;
  }

  const { db } = input;
  ensureMigrated(db);

  const rejectUnusable = db.prepare(
    `UPDATE screener_predictions
     SET status = 'REJECTED', prediction_json = ?, updated_at = ?
     WHERE id = ?`,
  );
  const junk = db
    .prepare(
      `SELECT id, label, raw_label, control, review_item_id
       FROM screener_predictions
       WHERE status = 'PENDING'
       LIMIT 200`,
    )
    .all() as Array<{
    id: string;
    label: string;
    raw_label: string;
    control: string;
    review_item_id: string | null;
  }>;
  let drained = 0;
  for (const r of junk) {
    const unusable =
      isUnusableLabel(r.raw_label) || isUnusableLabel(r.label);
    const unworthy = !isCaptureWorthyQuestion({
      label: r.raw_label,
      type: r.control,
    });
    if (!unusable && !unworthy) continue;
    const reason = unusable
      ? "unusable label — inspector could not read the question text"
      : "not a capture-worthy question";
    rejectUnusable.run(
      JSON.stringify({ rejected: reason }),
      new Date().toISOString(),
      r.id,
    );
    if (r.review_item_id) {
      try {
        resolveReviewItem(
          db,
          r.review_item_id,
          { rejected: reason },
          "DISMISSED",
        );
      } catch {
        // queue row is already REJECTED
      }
    }
    drained += 1;
  }
  if (drained > 0) {
    report.rejected += drained;
    report.notes.push(
      `drained ${drained} junk Answer-needed rows (majors / field_N / terms / pronouns)`,
    );
  }

  const rows = db
    .prepare(
      `SELECT id, label, raw_label, control, options_json, first_seen_application_id,
              attempts, review_item_id
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
    review_item_id: string | null;
  }>;
  if (rows.length === 0) return report;
  report.questions_considered = rows.length;

  // Placeholder labels carry no question text — the model CANNOT answer
  // "field_12" (cc02e067 burned attempts on twelve of them). Reject them
  // outright with the real cause named: the inspector failed to read the
  // label, which is a capture bug, not a prediction failure.
  const askable: typeof rows = [];
  for (const r of rows) {
    if (isUnusableLabel(r.raw_label) || isUnusableLabel(r.label)) {
      rejectUnusable.run(
        JSON.stringify({ rejected: "unusable label — inspector could not read the question text" }),
        new Date().toISOString(),
        r.id,
      );
      report.rejected += 1;
      report.notes.push(
        `prediction rejected "${r.raw_label.slice(0, 30)}": unusable label (inspector could not read the question text)`,
      );
      continue;
    }
    if (!isCaptureWorthyQuestion({ label: r.raw_label, type: r.control })) {
      rejectUnusable.run(
        JSON.stringify({ rejected: "not a capture-worthy question" }),
        new Date().toISOString(),
        r.id,
      );
      report.rejected += 1;
      report.notes.push(
        `prediction rejected "${r.raw_label.slice(0, 40)}": not a real question`,
      );
      continue;
    }
    askable.push(r);
  }
  if (askable.length === 0) return report;

  const bump = db.prepare(
    `UPDATE screener_predictions SET attempts = attempts + 1, updated_at = ? WHERE id = ?`,
  );
  const now = new Date().toISOString();
  for (const r of askable) bump.run(now, r.id);

  const client = input.client ?? makeLlmClient();
  let parsed: { predictions?: Array<Record<string, unknown>> };
  try {
    const { text } = await client.generateJson({
      system: SYSTEM_PROMPT,
      user: JSON.stringify({
        candidate_context: about ?? "",
        saved_answers: bank?.answers ?? {},
        profile_facts: profileFacts ?? {},
        questions: askable.map((r) => ({
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

  for (const row of askable) {
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
    // Capture already opened an "Answer needed" item — enrich it in place
    // with the suggestion rather than opening a duplicate. A capture item
    // the operator already resolved/dismissed stays resolved: the
    // suggestion is recorded on the row but never resurrects the item.
    let itemId: string | null = row.review_item_id;
    const enriched = itemId
      ? updateReviewItemPayload(db, itemId, {
          source: "screener_prediction",
          predicted_answer: check.value,
          suggested_key: key,
          basis,
          hint: "Approve (or edit) once and this answer joins your bank — future forms fill it automatically.",
        })
      : null;
    if (!enriched && !itemId) {
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
      itemId = item.id;
    } else if (!enriched && itemId) {
      report.notes.push(
        `suggestion for "${row.raw_label.slice(0, 50)}" recorded, but its review item was already closed — not reopened`,
      );
    }
    markPredicted.run(
      JSON.stringify(prediction),
      itemId,
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
