-- 001_initial.sql
-- Phase 1 operational schema: SQLite is source of truth.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  stop_after_current INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  max_unattended_submissions INTEGER NOT NULL DEFAULT 0,
  unattended_submissions_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  jobright_job_id TEXT,
  normalized_application_url TEXT,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  location TEXT,
  employment_type TEXT,
  description_text TEXT,
  description_hash TEXT,
  source_ats TEXT,
  -- Stable duplicate key: sha256 over normalized identity parts
  job_fingerprint TEXT NOT NULL UNIQUE,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_jobright_job_id_uq
  ON jobs(jobright_job_id)
  WHERE jobright_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_normalized_application_url_uq
  ON jobs(normalized_application_url)
  WHERE normalized_application_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  state TEXT NOT NULL,
  route TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  versions_json TEXT NOT NULL DEFAULT '{}',
  eligibility_json TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS applications_state_idx ON applications(state);
CREATE INDEX IF NOT EXISTS applications_job_id_idx ON applications(job_id);

CREATE TABLE IF NOT EXISTS application_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  previous_state TEXT,
  next_state TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  reason TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  run_id TEXT REFERENCES automation_runs(id)
);

CREATE INDEX IF NOT EXISTS application_events_app_idx
  ON application_events(application_id, timestamp);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  kind TEXT NOT NULL,
  path TEXT,
  sha256 TEXT,
  size_bytes INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(application_id, kind)
);

CREATE TABLE IF NOT EXISTS form_fields (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  options_json TEXT,
  current_value_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(application_id, field_key)
);

CREATE TABLE IF NOT EXISTS application_answers (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  canonical_field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL,
  UNIQUE(application_id, canonical_field)
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  submission_attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  -- PENDING | VERIFIED | UNCERTAIN | FAILED
  submitted INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  confirmation_url TEXT,
  confirmation_text TEXT,
  application_identifier TEXT,
  screenshot_path TEXT,
  form_snapshot_hash TEXT,
  receipt_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(application_id, submission_attempt_number)
);

-- At most one verified successful submission per application
CREATE UNIQUE INDEX IF NOT EXISTS submissions_verified_unique
  ON submissions(application_id)
  WHERE status = 'VERIFIED' AND submitted = 1;

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  name TEXT,
  title TEXT,
  company TEXT,
  email TEXT,
  linkedin_url TEXT,
  source_category TEXT,
  jobright_contact_id TEXT,
  jobright_context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS contacts_app_email_uq
  ON contacts(application_id, email)
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_app_jobright_contact_uq
  ON contacts(application_id, jobright_contact_id)
  WHERE jobright_contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS linkedin_profiles (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  linkedin_url TEXT NOT NULL,
  scrape_version INTEGER,
  profile_json TEXT NOT NULL DEFAULT '{}',
  coverage_json TEXT NOT NULL DEFAULT '{}',
  scraped_at TEXT,
  UNIQUE(contact_id)
);

CREATE TABLE IF NOT EXISTS email_generations (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  prompt_version TEXT NOT NULL,
  model TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  validation_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(application_id, contact_id, prompt_version)
);

CREATE TABLE IF NOT EXISTS outlook_drafts (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  recipient_email TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(application_id, recipient_email)
);

CREATE TABLE IF NOT EXISTS service_sessions (
  service TEXT PRIMARY KEY,
  persistence_mode TEXT NOT NULL,
  storage_state_path TEXT,
  persistent_profile_path TEXT,
  last_validated_at TEXT,
  last_status TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  -- in_progress | completed | uncertain | failed
  resource_type TEXT,
  resource_id TEXT,
  result_ref TEXT,
  holder_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  holder_run_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS leases_expires_idx ON leases(expires_at);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(id),
  kind TEXT NOT NULL,
  -- UNCERTAIN_SUBMISSION | AMBIGUOUS_FIELD | ESSAY | AUTH_REQUIRED |
  -- CAPTCHA_REQUIRED | UNSUPPORTED_ATS | DUPLICATE_RISK | MANUAL
  status TEXT NOT NULL,
  -- OPEN | IN_PROGRESS | RESOLVED | DISMISSED
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_json TEXT
);

CREATE INDEX IF NOT EXISTS review_items_status_idx ON review_items(status);
CREATE INDEX IF NOT EXISTS review_items_app_idx ON review_items(application_id);
