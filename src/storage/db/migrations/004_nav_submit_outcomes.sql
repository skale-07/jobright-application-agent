-- 004_nav_submit_outcomes.sql
-- Extends the fill-outcomes training corpus (003) to the other two
-- attempt domains: navigation and submit. Same discipline as 003:
-- append-only, PII-safe (hosts and classes, never raw values), indexed
-- for both debugging joins and feature/label export. Every row carries
-- run_id + application_id so a logs.jsonl line, an artifacts/ report,
-- and a DB row can be joined on the same correlation ids.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS navigation_attempts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  run_id TEXT NOT NULL,                -- nav-<uuid> (matches artifacts/navigation/<run_id>/)
  application_id TEXT NOT NULL,
  arm_run_id TEXT,                     -- armed session, when driven by the worker
  session_kind TEXT NOT NULL,          -- cdp | ephemeral
  method TEXT,                         -- anchor_href | apply_click_popup | apply_click_same_tab | agent | NULL
  wall TEXT NOT NULL,                  -- none | jobright_auth | auth | captcha | phone_otp | budget | submit_risk
  resolved INTEGER NOT NULL DEFAULT 0, -- label: did this attempt produce a stored employer URL
  resolved_ats TEXT,
  start_host TEXT,
  end_host TEXT,
  phase_trace_json TEXT NOT NULL DEFAULT '[]',
  agent_turns INTEGER,
  agent_steps INTEGER,
  agent_domains_json TEXT,
  gmail_polls INTEGER,
  duration_ms INTEGER,
  report_artifact_relpath TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS navigation_attempts_app_idx
  ON navigation_attempts(application_id);
CREATE INDEX IF NOT EXISTS navigation_attempts_wall_idx
  ON navigation_attempts(wall);
CREATE INDEX IF NOT EXISTS navigation_attempts_resolved_idx
  ON navigation_attempts(resolved);
CREATE INDEX IF NOT EXISTS navigation_attempts_created_idx
  ON navigation_attempts(created_at);
CREATE INDEX IF NOT EXISTS navigation_attempts_host_idx
  ON navigation_attempts(start_host, end_host);

CREATE TABLE IF NOT EXISTS submit_attempts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  run_id TEXT NOT NULL,                -- automation_runs id the submission drew from
  application_id TEXT NOT NULL,
  submission_id TEXT,
  ats TEXT NOT NULL,
  outcome TEXT NOT NULL,               -- SUBMITTED_VERIFIED | UNCERTAIN | REFUSED | FAILED_BEFORE_CLICK
  clicked INTEGER NOT NULL DEFAULT 0,
  control_resolved_via TEXT,           -- role-name | page-role-name | css | selector | NULL (miss)
  cap_hit_at_click INTEGER NOT NULL DEFAULT 0,
  verify_recovery_used INTEGER NOT NULL DEFAULT 0,
  url_host TEXT,
  reason TEXT,                         -- short failure/refusal reason (already redaction-safe)
  cta_inventory_count INTEGER,
  duration_ms INTEGER,
  report_artifact_relpath TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS submit_attempts_app_idx
  ON submit_attempts(application_id);
CREATE INDEX IF NOT EXISTS submit_attempts_outcome_idx
  ON submit_attempts(outcome);
CREATE INDEX IF NOT EXISTS submit_attempts_ats_outcome_idx
  ON submit_attempts(ats, outcome);
CREATE INDEX IF NOT EXISTS submit_attempts_created_idx
  ON submit_attempts(created_at);

-- Debug/export views: one row per (ats/host, outcome-ish bucket) with
-- counts — the first thing to read after any session.
CREATE VIEW IF NOT EXISTS navigation_wall_rates AS
SELECT
  start_host,
  session_kind,
  wall,
  COUNT(*) AS attempts,
  SUM(resolved) AS resolved_count
FROM navigation_attempts
GROUP BY start_host, session_kind, wall;

CREATE VIEW IF NOT EXISTS submit_outcome_rates AS
SELECT
  ats,
  url_host,
  outcome,
  COUNT(*) AS attempts,
  SUM(clicked) AS clicked_count,
  SUM(cap_hit_at_click) AS cap_hits
FROM submit_attempts
GROUP BY ats, url_host, outcome;
