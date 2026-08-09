-- 005_screener_mappings.sql
-- Cache + training corpus for screener label→key mappings. A label is the
-- COMPANY'S question text (not candidate PII); caching means each novel
-- label costs at most one LLM call ever, and the deterministic/llm split
-- is itself feature data for retiring the model per docs/llm-agent-surfaces.md.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS screener_label_mappings (
  label_fingerprint TEXT PRIMARY KEY,   -- sha256 of the normalized label
  label TEXT NOT NULL,                  -- normalized label text
  ats TEXT,
  screener_key TEXT,                    -- NULL = confidently no mapping
  source TEXT NOT NULL,                 -- 'deterministic' | 'llm'
  confidence TEXT NOT NULL DEFAULT 'high',
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS screener_label_mappings_key_idx
  ON screener_label_mappings(screener_key);
CREATE INDEX IF NOT EXISTS screener_label_mappings_source_idx
  ON screener_label_mappings(source);
