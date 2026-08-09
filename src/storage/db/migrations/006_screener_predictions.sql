-- Screener prediction queue: questions no registry key or custom bank
-- entry covered, captured at plan time (flag-gated), predicted by the LLM
-- post-session, and promoted into the operator's bank only through the
-- one-click review approval. One row per normalized label — the label
-- fingerprint dedupes across applications and sessions.
CREATE TABLE IF NOT EXISTS screener_predictions (
  id TEXT PRIMARY KEY,
  label_fingerprint TEXT NOT NULL UNIQUE,   -- sha256(normalized label), 32 hex
  label TEXT NOT NULL,                       -- normalized label
  raw_label TEXT NOT NULL,                   -- as seen on the page
  control TEXT NOT NULL,                     -- text | select | radio | combobox | ...
  options_json TEXT,                         -- page options when discovered
  ats TEXT,
  first_seen_application_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',    -- PENDING | PREDICTED | REJECTED | PROMOTED
  attempts INTEGER NOT NULL DEFAULT 0,
  prediction_json TEXT,                      -- {answer, basis, confidence} after PREDICTED
  review_item_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS screener_predictions_status_idx
  ON screener_predictions(status);
