-- 002_phase55_hardening.sql
-- One active application per job. Terminal states may be followed by a new attempt.

PRAGMA foreign_keys = ON;

-- Collapse duplicate active applications created before this migration.
-- Keep the newest row per job_id; mark older active duplicates terminal.
UPDATE applications
SET state = 'FAILED_FINAL',
    error_summary = 'phase55_dedupe_cleanup_duplicate_active',
    updated_at = datetime('now')
WHERE state NOT IN ('COMPLETED', 'FAILED_FINAL', 'FILTERED_OUT')
  AND id IN (
    SELECT a.id
    FROM applications a
    WHERE a.state NOT IN ('COMPLETED', 'FAILED_FINAL', 'FILTERED_OUT')
      AND EXISTS (
        SELECT 1
        FROM applications b
        WHERE b.job_id = a.job_id
          AND b.state NOT IN ('COMPLETED', 'FAILED_FINAL', 'FILTERED_OUT')
          AND (
            b.created_at > a.created_at
            OR (b.created_at = a.created_at AND b.id > a.id)
          )
      )
  );

-- Terminal = COMPLETED | FAILED_FINAL | FILTERED_OUT (re-discovery may create a new row).
CREATE UNIQUE INDEX IF NOT EXISTS applications_one_active_per_job
  ON applications(job_id)
  WHERE state NOT IN ('COMPLETED', 'FAILED_FINAL', 'FILTERED_OUT');

-- Dedupe key for open review items (auth expiry, ambiguous fields, etc.)
CREATE UNIQUE INDEX IF NOT EXISTS review_items_open_dedupe_uq
  ON review_items(kind, application_id, title)
  WHERE status IN ('OPEN', 'IN_PROGRESS') AND application_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS review_items_open_service_dedupe_uq
  ON review_items(kind, title)
  WHERE status IN ('OPEN', 'IN_PROGRESS') AND application_id IS NULL;
