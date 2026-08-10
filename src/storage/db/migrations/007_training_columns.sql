-- Training-data layer: era stamps, outcome labels, and trajectory joins.
-- Rows produced by different code eras (goal prompts, discovery regexes,
-- fill tactics) are different distributions — code_version separates them.
-- congruence_verdict is the deterministic success label for a navigation
-- episode (match | mismatch | unknown, from the employer-congruence gate);
-- trace_relpath joins the episode to its step-level agent trace artifact
-- (artifacts/navigation/<run>/agent-trace.jsonl) for behavioral cloning.
ALTER TABLE navigation_attempts ADD COLUMN code_version TEXT;
ALTER TABLE navigation_attempts ADD COLUMN congruence_verdict TEXT;
ALTER TABLE navigation_attempts ADD COLUMN trace_relpath TEXT;
ALTER TABLE fill_runs ADD COLUMN code_version TEXT;
ALTER TABLE submit_attempts ADD COLUMN code_version TEXT;
