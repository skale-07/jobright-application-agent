-- Extension-first fill (X4): per-run strategy + step-trace join, and
-- per-field attribution of WHO put the value on the page. filled_by is
-- the training label the eventual in-house agent learns from: which
-- fields JobRight's extension handled vs which needed the native
-- deterministic gap-fill vs which nobody filled.
ALTER TABLE fill_runs ADD COLUMN strategy TEXT;
ALTER TABLE fill_runs ADD COLUMN trace_relpath TEXT;
ALTER TABLE fill_field_outcomes ADD COLUMN filled_by TEXT
  CHECK (filled_by IN ('extension', 'native', 'skipped') OR filled_by IS NULL);
