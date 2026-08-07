-- 003_fill_outcomes.sql
-- Append-only field-fill outcomes for local training / adaptation corpus.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fill_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  source TEXT NOT NULL,
  ats TEXT,
  job_url TEXT NOT NULL,
  job_host TEXT,
  job_id_observed TEXT,
  company TEXT,
  role TEXT,
  application_id TEXT,
  job_db_id TEXT,
  mutation_attempted INTEGER NOT NULL DEFAULT 0,
  validation_level TEXT,
  verify_passed INTEGER,
  fillable_count INTEGER,
  skipped_count INTEGER,
  upload_resume_verified INTEGER,
  heal_attempted INTEGER NOT NULL DEFAULT 0,
  heal_healed INTEGER NOT NULL DEFAULT 0,
  heal_still_failing INTEGER NOT NULL DEFAULT 0,
  report_artifact_relpath TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS fill_runs_ats_host_idx
  ON fill_runs(ats, job_host);
CREATE INDEX IF NOT EXISTS fill_runs_created_at_idx
  ON fill_runs(created_at);
CREATE INDEX IF NOT EXISTS fill_runs_application_id_idx
  ON fill_runs(application_id);
CREATE INDEX IF NOT EXISTS fill_runs_verify_passed_idx
  ON fill_runs(verify_passed);

CREATE TABLE IF NOT EXISTS fill_field_outcomes (
  id TEXT PRIMARY KEY,
  fill_run_id TEXT NOT NULL REFERENCES fill_runs(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL,
  label TEXT,
  field_type TEXT,
  canonical_field TEXT,
  control_kind TEXT,
  plan_action TEXT,
  approved INTEGER,
  fill_ok INTEGER,
  fill_error TEXT,
  verify_match INTEGER,
  expected_redacted TEXT,
  observed_redacted TEXT,
  expected_class TEXT,
  observed_class TEXT,
  value_fingerprint TEXT,
  selected_option TEXT,
  match_basis TEXT,
  heal_status TEXT NOT NULL DEFAULT 'none',
  notes_json TEXT NOT NULL DEFAULT '[]',
  options_sample_json TEXT
);

CREATE INDEX IF NOT EXISTS fill_field_outcomes_run_idx
  ON fill_field_outcomes(fill_run_id);
CREATE INDEX IF NOT EXISTS fill_field_outcomes_canonical_idx
  ON fill_field_outcomes(canonical_field);
CREATE INDEX IF NOT EXISTS fill_field_outcomes_label_idx
  ON fill_field_outcomes(label);
CREATE INDEX IF NOT EXISTS fill_field_outcomes_verify_match_idx
  ON fill_field_outcomes(verify_match);
CREATE INDEX IF NOT EXISTS fill_field_outcomes_control_kind_idx
  ON fill_field_outcomes(control_kind);

CREATE VIEW IF NOT EXISTS fill_field_success_rates AS
SELECT
  r.ats AS ats,
  r.job_host AS job_host,
  o.label AS label,
  o.canonical_field AS canonical_field,
  o.control_kind AS control_kind,
  COUNT(*) AS attempts,
  SUM(CASE WHEN o.fill_ok = 1 THEN 1 ELSE 0 END) AS fill_ok_count,
  SUM(CASE WHEN o.verify_match = 1 THEN 1 ELSE 0 END) AS verify_match_count,
  SUM(CASE WHEN o.verify_match = 0 THEN 1 ELSE 0 END) AS verify_fail_count,
  SUM(CASE WHEN o.heal_status = 'healed' THEN 1 ELSE 0 END) AS heal_healed_count,
  SUM(CASE WHEN o.heal_status = 'still_failing' THEN 1 ELSE 0 END) AS heal_still_failing_count
FROM fill_field_outcomes o
JOIN fill_runs r ON r.id = o.fill_run_id
GROUP BY r.ats, r.job_host, o.label, o.canonical_field, o.control_kind;
