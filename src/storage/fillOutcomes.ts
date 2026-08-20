/**
 * Append-only field-fill outcomes. SQLite is the source of truth for
 * local adaptation / training corpus. Fails open: never break a fill run.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./db/client.js";
import { migrate, openDatabase } from "./db/client.js";
import { codeVersion } from "./codeVersion.js";
import type {
  FieldFillMeta,
  FillResult,
  FormVerificationResult,
  UploadVerification,
} from "../ats/adapter.js";
import type { HealReport } from "../ats/greenhouse/fillHealer.js";
import { maskEmail, maskPhone } from "../logging/redaction.js";
import { logger } from "../logging/logger.js";

export const FILL_OUTCOMES_SCHEMA_VERSION = 1;

export type FillRunSource = "cli_url" | "fixture" | "pipeline" | "submit";

export type FillRunMode = "executed" | "plan_only";

export type ValueClass =
  | "empty"
  | "literal"
  | "option_label"
  | "dial_code"
  | "yes_no"
  | "email"
  | "phone"
  | "work_auth"
  | "url"
  | "unknown";

export type MatchBasis =
  | "exact"
  | "synonym"
  | "unique_substring"
  | "ci_exact"
  | "dial_collapse"
  | "values_match"
  | "mismatch"
  | "skipped"
  | "not_verified"
  | "fill_error";

export type RecordFillRunInput = {
  mode: FillRunMode;
  source: FillRunSource;
  ats: string;
  job_url: string;
  company?: string | null;
  role?: string | null;
  job_id_observed?: string | null;
  application_id?: string | null;
  job_db_id?: string | null;
  mutation_attempted: boolean;
  /** X4: which fill strategy served this run (EXTENSION_FIRST | NATIVE_ONLY). */
  strategy?: string | null;
  /** X4: relpath of the fill-trace.jsonl artifact for this run. */
  trace_relpath?: string | null;
  /** X4: canonical answers the extension satisfied (filled_by attribution). */
  extension_satisfied?: string[] | null;
  validation_level?: string | null;
  fillable_count?: number | null;
  skipped_count?: number | null;
  report_artifact_relpath?: string | null;
  notes?: string[];
  metadata?: Record<string, unknown>;
  plan_entries: Array<{
    field_id: string;
    label: string;
    type: string;
    canonical_field: string | null;
    action: string;
    approved?: boolean;
    value?: unknown;
    reason?: string;
  }>;
  fill?: FillResult | null;
  verify?: FormVerificationResult | null;
  uploads?: UploadVerification[] | null;
  heal?: HealReport | null;
};

export type FillFieldOutcomeRow = {
  id: string;
  fill_run_id: string;
  field_id: string;
  label: string | null;
  field_type: string | null;
  canonical_field: string | null;
  control_kind: string | null;
  plan_action: string | null;
  approved: number | null;
  fill_ok: number | null;
  fill_error: string | null;
  verify_match: number | null;
  expected_redacted: string | null;
  observed_redacted: string | null;
  expected_class: string | null;
  observed_class: string | null;
  value_fingerprint: string | null;
  selected_option: string | null;
  match_basis: string | null;
  filled_by: string | null;
  heal_status: string;
  notes_json: string;
  options_sample_json: string | null;
};

export type FillRunRow = {
  id: string;
  created_at: string;
  mode: string;
  source: string;
  ats: string | null;
  job_url: string;
  job_host: string | null;
  job_id_observed: string | null;
  company: string | null;
  role: string | null;
  application_id: string | null;
  job_db_id: string | null;
  mutation_attempted: number;
  validation_level: string | null;
  verify_passed: number | null;
  fillable_count: number | null;
  skipped_count: number | null;
  upload_resume_verified: number | null;
  heal_attempted: number;
  heal_healed: number;
  heal_still_failing: number;
  report_artifact_relpath: string | null;
  schema_version: number;
  metadata_json: string;
};

function isPiiCanonical(canonical: string | null | undefined): boolean {
  if (!canonical) return false;
  return /email|phone|sponsor|work_authorization/i.test(canonical);
}

function stringifyObserved(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractObservedText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const o = value as { label?: unknown; value?: unknown };
    if (o.label != null && String(o.label).trim() !== "") return String(o.label);
    if (o.value != null) return String(o.value);
  }
  return String(value);
}

export function classifyValue(
  raw: unknown,
  canonical: string | null | undefined,
): ValueClass {
  const text = extractObservedText(raw).trim();
  if (text === "") return "empty";
  if (canonical && /email/i.test(canonical)) return "email";
  if (canonical && /phone/i.test(canonical)) return "phone";
  if (canonical && /sponsor|work_authorization/i.test(canonical)) return "work_auth";
  if (/^\+\d+$/.test(text)) return "dial_code";
  if (/^(yes|no|y|n|true|false)$/i.test(text)) return "yes_no";
  if (/^https?:\/\//i.test(text)) return "url";
  if (/option_label|Select\.\.\./i.test(text)) return "option_label";
  return "literal";
}

export function redactOutcomeValue(
  raw: unknown,
  canonical: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const text = extractObservedText(raw);
  if (text === "") return "";

  if (canonical && /email/i.test(canonical)) {
    return typeof raw === "string" ? maskEmail(raw) : maskEmail(text);
  }
  if (canonical && /phone/i.test(canonical)) {
    return typeof raw === "string" ? maskPhone(raw) : maskPhone(text);
  }
  if (canonical && /sponsor|work_authorization/i.test(canonical)) {
    return "[REDACTED_SPONSORSHIP]";
  }
  // Object observed (select): store label/value compact without path leakage
  if (typeof raw === "object" && raw !== null) {
    const o = raw as { label?: unknown; value?: unknown };
    if (o.label != null || o.value != null) {
      return stringifyObserved({
        ...(o.value !== undefined ? { value: o.value } : {}),
        ...(o.label !== undefined ? { label: o.label } : {}),
      });
    }
  }
  return text;
}

/** Non-invertible fingerprint for non-PII free text (training join key). */
export function valueFingerprint(
  raw: unknown,
  canonical: string | null | undefined,
): string | null {
  const text = extractObservedText(raw).trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return null;
  if (isPiiCanonical(canonical)) {
    // Class-only fingerprint — not reversible to full value
    const cls = classifyValue(raw, canonical);
    return createHash("sha256").update(`class:${cls}`).digest("hex").slice(0, 16);
  }
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function jobHostFromUrl(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function parseMatchViaFromNotes(notes: string[]): MatchBasis | null {
  for (const n of notes) {
    const m = n.match(/picked\s+".+?"\s+\((\w+)\)/i);
    if (m?.[1]) {
      const via = m[1].toLowerCase();
      if (via === "exact") return "exact";
      if (via === "synonym") return "synonym";
      if (via === "unique_substring") return "unique_substring";
      if (via === "ci_exact") return "ci_exact";
    }
    if (/dial code|collapsed/i.test(n)) return "dial_collapse";
  }
  return null;
}

function indexFieldMeta(
  fill: FillResult | null | undefined,
): Map<string, FieldFillMeta> {
  const map = new Map<string, FieldFillMeta>();
  for (const m of fill?.field_meta ?? []) {
    map.set(m.field_id, m);
    if (m.canonical_field) map.set(m.canonical_field, m);
  }
  return map;
}

function fillErrorForField(
  errors: string[],
  fieldId: string,
): string | null {
  const hit = errors.find(
    (e) => e.startsWith(`${fieldId}:`) || e.includes(`${fieldId}:`),
  );
  return hit ?? null;
}

/**
 * Build outcome rows from a completed fill report. Pure — no DB IO.
 * Exported for unit tests.
 */
export function buildFillFieldOutcomes(
  fillRunId: string,
  input: RecordFillRunInput,
): Omit<FillFieldOutcomeRow, "id">[] {
  const metaById = indexFieldMeta(input.fill);
  const filledSet = new Set(input.fill?.filled ?? []);
  const skippedSet = new Set(input.fill?.skipped ?? []);
  const errors = input.fill?.errors ?? [];

  const verifyByCanonical = new Map(
    (input.verify?.fields ?? []).map((f) => [f.canonical_field, f]),
  );

  const extSatisfied = new Set(input.extension_satisfied ?? []);
  const healStill = new Set(input.heal?.still_failing ?? []);
  const healHealed = new Set(input.heal?.healed ?? []);
  const healNotesByField = new Map<string, string[]>();
  for (const a of input.heal?.attempts ?? []) {
    healNotesByField.set(a.field_id, a.notes ?? []);
  }

  const rows: Omit<FillFieldOutcomeRow, "id">[] = [];

  for (const entry of input.plan_entries) {
    const canonical = entry.canonical_field;
    const fillKey = canonical ?? entry.field_id;
    const meta =
      metaById.get(entry.field_id) ??
      (canonical ? metaById.get(canonical) : undefined);

    const planAction = entry.action;
    const isFillAction =
      planAction === "FILL" ||
      planAction === "fill" ||
      entry.approved === true;

    let fill_ok: number | null = null;
    let fill_error: string | null = null;
    if (isFillAction && input.fill) {
      const err = fillErrorForField(errors, entry.field_id);
      if (err) {
        fill_ok = 0;
        fill_error = err;
      } else if (
        filledSet.has(fillKey) ||
        filledSet.has(entry.field_id) ||
        (canonical != null && filledSet.has(canonical))
      ) {
        fill_ok = 1;
      } else if (skippedSet.has(entry.field_id)) {
        fill_ok = null;
      } else if (entry.approved) {
        // Approved but neither filled nor errored — treat as incomplete
        fill_ok = 0;
        fill_error = "not in fill.filled and no error";
      }
    }

    const verify = canonical
      ? verifyByCanonical.get(canonical)
      : undefined;
    // Also try field_id as verify key (rare)
    const verifyField =
      verify ??
      verifyByCanonical.get(entry.field_id) ??
      null;

    let verify_match: number | null = null;
    if (verifyField) {
      verify_match = verifyField.match ? 1 : 0;
    }

    const expectedRaw = verifyField?.expected ?? entry.value ?? null;
    const observedRaw = verifyField?.observed ?? null;

    const expected_redacted = redactOutcomeValue(expectedRaw, canonical);
    const observed_redacted = redactOutcomeValue(observedRaw, canonical);
    const expected_class = classifyValue(expectedRaw, canonical);
    const observed_class = classifyValue(observedRaw, canonical);

    let match_basis: MatchBasis | null = null;
    if (!isFillAction || planAction === "SKIP" || /^skip/i.test(planAction)) {
      match_basis = "skipped";
    } else if (fill_ok === 0) {
      match_basis = "fill_error";
    } else if (verify_match === null) {
      match_basis = input.fill ? "not_verified" : "skipped";
    } else if (verify_match === 1) {
      const via =
        meta?.match_via ?? parseMatchViaFromNotes(meta?.notes ?? []) ?? null;
      if (
        via === "exact" ||
        via === "synonym" ||
        via === "unique_substring" ||
        via === "ci_exact" ||
        via === "dial_collapse"
      ) {
        match_basis = via;
      } else if (observed_class === "dial_code") {
        match_basis = "dial_collapse";
      } else {
        match_basis = "values_match";
      }
    } else {
      match_basis = "mismatch";
    }

    // X4 training label: who put the value on the page. Extension wins
    // when the pre-fill verify matched this canonical; native when our
    // fill filled it; skipped otherwise.
    let filled_by: string | null = null;
    if (input.mode === "executed") {
      if (canonical != null && extSatisfied.has(canonical)) filled_by = "extension";
      else if (fill_ok === 1) filled_by = "native";
      else filled_by = "skipped";
    }

    let heal_status = "none";
    if (healHealed.has(entry.field_id)) heal_status = "healed";
    else if (healStill.has(entry.field_id)) heal_status = "still_failing";

    const notes: string[] = [];
    if (entry.reason) notes.push(entry.reason);
    if (meta?.notes?.length) notes.push(...meta.notes);
    const hNotes = healNotesByField.get(entry.field_id);
    if (hNotes?.length) notes.push(...hNotes);

    rows.push({
      fill_run_id: fillRunId,
      field_id: entry.field_id,
      label: entry.label,
      field_type: entry.type,
      canonical_field: canonical,
      control_kind: meta?.control_kind ?? null,
      plan_action: planAction,
      approved: entry.approved === true ? 1 : entry.approved === false ? 0 : null,
      fill_ok,
      fill_error,
      verify_match,
      expected_redacted,
      observed_redacted,
      expected_class,
      observed_class,
      value_fingerprint: valueFingerprint(expectedRaw, canonical),
      selected_option: meta?.selected_option ?? null,
      match_basis,
      filled_by,
      heal_status,
      notes_json: JSON.stringify(notes),
      options_sample_json: meta?.options_sample
        ? JSON.stringify(meta.options_sample.slice(0, 20))
        : null,
    });
  }

  return rows;
}

function ensureMigrated(db: Db): void {
  migrate(db);
}

/**
 * Persist a fill run + field outcomes. Fail-open: returns null on error.
 * Default: only record executed mutation runs (plan_only skipped unless force).
 */
export function recordFillRun(
  input: RecordFillRunInput,
  opts: { db?: Db; recordPlanOnly?: boolean } = {},
): { fill_run_id: string } | null {
  if (input.mode === "plan_only" && !opts.recordPlanOnly) {
    return null;
  }

  let ownedDb = false;
  const db = opts.db ?? (() => {
    ownedDb = true;
    return openDatabase();
  })();

  try {
    ensureMigrated(db);
    const fill_run_id = randomUUID();
    const created_at = new Date().toISOString();
    const job_host = jobHostFromUrl(input.job_url);

    const resumeUpload = (input.uploads ?? []).find((u) => u.field === "resume");
    const upload_resume_verified =
      resumeUpload == null ? null : resumeUpload.verified ? 1 : 0;

    const heal = input.heal;
    const fieldRows = buildFillFieldOutcomes(fill_run_id, input);

    const insertRun = db.prepare(`
      INSERT INTO fill_runs (
        id, created_at, mode, source, ats, job_url, job_host, job_id_observed,
        company, role, application_id, job_db_id, mutation_attempted,
        validation_level, verify_passed, fillable_count, skipped_count,
        upload_resume_verified, heal_attempted, heal_healed, heal_still_failing,
        report_artifact_relpath, schema_version, metadata_json, code_version,
        strategy, trace_relpath
      ) VALUES (
        @id, @created_at, @mode, @source, @ats, @job_url, @job_host, @job_id_observed,
        @company, @role, @application_id, @job_db_id, @mutation_attempted,
        @validation_level, @verify_passed, @fillable_count, @skipped_count,
        @upload_resume_verified, @heal_attempted, @heal_healed, @heal_still_failing,
        @report_artifact_relpath, @schema_version, @metadata_json, @code_version,
        @strategy, @trace_relpath
      )
    `);

    const insertField = db.prepare(`
      INSERT INTO fill_field_outcomes (
        id, fill_run_id, field_id, label, field_type, canonical_field,
        control_kind, plan_action, approved, fill_ok, fill_error, verify_match,
        expected_redacted, observed_redacted, expected_class, observed_class,
        value_fingerprint, selected_option, match_basis, filled_by, heal_status,
        notes_json, options_sample_json
      ) VALUES (
        @id, @fill_run_id, @field_id, @label, @field_type, @canonical_field,
        @control_kind, @plan_action, @approved, @fill_ok, @fill_error, @verify_match,
        @expected_redacted, @observed_redacted, @expected_class, @observed_class,
        @value_fingerprint, @selected_option, @match_basis, @filled_by, @heal_status,
        @notes_json, @options_sample_json
      )
    `);

    const tx = db.transaction(() => {
      insertRun.run({
        id: fill_run_id,
        created_at,
        code_version: codeVersion(),
        mode: input.mode,
        source: input.source,
        ats: input.ats,
        job_url: input.job_url,
        job_host,
        job_id_observed: input.job_id_observed ?? null,
        company: input.company ?? null,
        role: input.role ?? null,
        application_id: input.application_id ?? null,
        job_db_id: input.job_db_id ?? null,
        mutation_attempted: input.mutation_attempted ? 1 : 0,
        validation_level: input.validation_level ?? null,
        verify_passed:
          input.verify == null ? null : input.verify.passed ? 1 : 0,
        fillable_count: input.fillable_count ?? null,
        skipped_count: input.skipped_count ?? null,
        upload_resume_verified,
        heal_attempted: heal?.attempted ?? 0,
        heal_healed: heal?.healed?.length ?? 0,
        heal_still_failing: heal?.still_failing?.length ?? 0,
        report_artifact_relpath: input.report_artifact_relpath ?? null,
        strategy: input.strategy ?? null,
        trace_relpath: input.trace_relpath ?? null,
        schema_version: FILL_OUTCOMES_SCHEMA_VERSION,
        metadata_json: JSON.stringify({
          notes: input.notes ?? [],
          ...(input.metadata ?? {}),
        }),
      });

      for (const row of fieldRows) {
        insertField.run({
          id: randomUUID(),
          ...row,
        });
      }
    });

    tx();

    logger.info("fill outcomes recorded", {
      service: "fill_outcomes",
      action: "record",
      metadata: {
        fill_run_id,
        field_count: fieldRows.length,
        verify_passed: input.verify?.passed ?? null,
      },
    });

    return { fill_run_id };
  } catch (err) {
    logger.info("fill outcomes record failed (fail-open)", {
      service: "fill_outcomes",
      action: "record",
      metadata: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  } finally {
    if (ownedDb) db.close();
  }
}

export type FillOutcomeExportRow = Record<string, unknown>;

export function exportFillOutcomesJsonl(
  db: Db = openDatabase(),
): FillOutcomeExportRow[] {
  ensureMigrated(db);
  const rows = db
    .prepare(
      `
      SELECT
        r.id AS fill_run_id,
        r.created_at,
        r.mode,
        r.source,
        r.ats,
        r.job_url,
        r.job_host,
        r.job_id_observed,
        r.company,
        r.role,
        r.application_id,
        r.mutation_attempted,
        r.validation_level,
        r.verify_passed AS run_verify_passed,
        r.upload_resume_verified,
        r.heal_attempted,
        r.heal_healed,
        r.heal_still_failing,
        o.field_id,
        o.label,
        o.field_type,
        o.canonical_field,
        o.control_kind,
        o.plan_action,
        o.approved,
        o.fill_ok,
        o.fill_error,
        o.verify_match,
        o.expected_redacted,
        o.observed_redacted,
        o.expected_class,
        o.observed_class,
        o.value_fingerprint,
        o.selected_option,
        o.match_basis,
        o.heal_status,
        o.notes_json,
        o.options_sample_json
      FROM fill_field_outcomes o
      JOIN fill_runs r ON r.id = o.fill_run_id
      ORDER BY r.created_at ASC, o.field_id ASC
    `,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => {
    let notes: unknown = [];
    let options_sample: unknown = null;
    try {
      notes = JSON.parse(String(row.notes_json ?? "[]"));
    } catch {
      notes = [];
    }
    try {
      options_sample =
        row.options_sample_json == null
          ? null
          : JSON.parse(String(row.options_sample_json));
    } catch {
      options_sample = null;
    }
    return {
      ...row,
      notes,
      options_sample,
      notes_json: undefined,
      options_sample_json: undefined,
    };
  });
}

export type FillOutcomesSummary = {
  run_count: number;
  field_outcome_count: number;
  verify_fail_rate: number | null;
  top_failing_labels: Array<{ label: string; fails: number; attempts: number }>;
  top_failing_canonicals: Array<{
    canonical_field: string;
    fails: number;
    attempts: number;
  }>;
  match_basis_counts: Array<{ match_basis: string; count: number }>;
  synonym_picks: number;
};

export function summarizeFillOutcomes(db: Db = openDatabase()): FillOutcomesSummary {
  ensureMigrated(db);

  const run_count = (
    db.prepare(`SELECT COUNT(*) AS n FROM fill_runs`).get() as { n: number }
  ).n;

  const field_outcome_count = (
    db.prepare(`SELECT COUNT(*) AS n FROM fill_field_outcomes`).get() as {
      n: number;
    }
  ).n;

  const verifyStats = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN verify_match IS NOT NULL THEN 1 ELSE 0 END) AS checked,
        SUM(CASE WHEN verify_match = 0 THEN 1 ELSE 0 END) AS fails
      FROM fill_field_outcomes
    `,
    )
    .get() as { checked: number | null; fails: number | null };

  const checked = verifyStats.checked ?? 0;
  const fails = verifyStats.fails ?? 0;

  const top_failing_labels = db
    .prepare(
      `
      SELECT label, COUNT(*) AS attempts,
        SUM(CASE WHEN verify_match = 0 THEN 1 ELSE 0 END) AS fails
      FROM fill_field_outcomes
      WHERE label IS NOT NULL
      GROUP BY label
      HAVING fails > 0
      ORDER BY fails DESC, attempts DESC
      LIMIT 15
    `,
    )
    .all() as Array<{ label: string; fails: number; attempts: number }>;

  const top_failing_canonicals = db
    .prepare(
      `
      SELECT canonical_field, COUNT(*) AS attempts,
        SUM(CASE WHEN verify_match = 0 THEN 1 ELSE 0 END) AS fails
      FROM fill_field_outcomes
      WHERE canonical_field IS NOT NULL
      GROUP BY canonical_field
      HAVING fails > 0
      ORDER BY fails DESC, attempts DESC
      LIMIT 15
    `,
    )
    .all() as Array<{
    canonical_field: string;
    fails: number;
    attempts: number;
  }>;

  const match_basis_counts = db
    .prepare(
      `
      SELECT COALESCE(match_basis, 'null') AS match_basis, COUNT(*) AS count
      FROM fill_field_outcomes
      GROUP BY match_basis
      ORDER BY count DESC
    `,
    )
    .all() as Array<{ match_basis: string; count: number }>;

  const synonym_picks = (
    db
      .prepare(
        `
        SELECT COUNT(*) AS n FROM fill_field_outcomes
        WHERE match_basis IN ('synonym', 'unique_substring', 'ci_exact')
          AND verify_match = 1
      `,
      )
      .get() as { n: number }
  ).n;

  return {
    run_count,
    field_outcome_count,
    verify_fail_rate: checked > 0 ? fails / checked : null,
    top_failing_labels,
    top_failing_canonicals,
    match_basis_counts,
    synonym_picks,
  };
}
