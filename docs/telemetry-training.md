# Telemetry & training corpus

Three append-only attempt corpora in SQLite (`data/`), one per failure
surface, all joinable to `artifacts/` and `logs.jsonl` on
`run_id` + `application_id`:

| Domain | Tables | Recorded at | Since |
|---|---|---|---|
| Field fills | `fill_runs`, `fill_field_outcomes` | applicationFiller / atsLiveFill | 003 |
| Navigation | `navigation_attempts` | `runNavigation.persist()` — every path | 004 |
| Submit | `submit_attempts` | `submitRun.persist()` — every path | 004 |

Aggregate views for the first read after any session:
`fill_field_success_rates`, `navigation_wall_rates`, `submit_outcome_rates`.

## Debugging joins

- "What did automation do?" → `artifacts/console/runs/<run>/logs.jsonl`.
- "Why did this app fail?" → its `navigation_attempts` /
  `submit_attempts` rows point at the exact artifact report
  (`report_artifact_relpath`) and carry the wall/outcome, resolution tier,
  and duration inline.
- "Is this ATS getting worse?" → the `*_rates` views, grouped by
  host/ats.

## PII policy (hard rule)

These tables exist to become model training data, so they must be safe to
export wholesale: **hosts, classes, fingerprints, counts, and short
reasons only.** Raw field values, credentials, message bodies, and full
URLs (query strings can carry tokens) are never stored. Fill outcomes
store redacted/classed values (`expected_class`, `value_fingerprint`) —
the same discipline applies to any new column. A column that could carry
a secret is a design defect.

## Export

```
npm run training:export            # artifacts/training/<timestamp>/
npm run training:export -- --out some/dir
```

Writes `fill-outcomes.jsonl`, `navigation-attempts.jsonl`,
`submit-attempts.jsonl`, and a `manifest.json` (counts + PII policy).

## Feature/label framing (for future agent training)

Each domain is already shaped as (features → label):

- **Fields**: label = `verify_match`; features = ats, host, label text,
  canonical field, control kind, value class, match basis, heal status.
  First models: "which selector/strategy will verify on this field?"
- **Navigation**: label = `resolved`; features = wall, session kind,
  phases attempted (trace), start host, agent turns/steps. First models:
  "will phase C rescue this wall?" and "which hosts are deterministic?"
- **Submit**: label = outcome; features = ats, host, resolution tier,
  CTA inventory size, recovery used. First models: "which resolution
  tier will click on this host?"

Failures are as valuable as successes — never prune failed rows.
Attempt caps stay mandatory: a training corpus never justifies an
unbounded retry loop.

## Extension-first attribution (X4, 2026-08-20)

Migration 009 adds the columns the extension-first architecture trains
on. `fill_runs.strategy` records which path served the run
(`EXTENSION_FIRST` | `NATIVE_ONLY`); `fill_runs.trace_relpath` joins the
run to its step-level `fill-trace-<ts>.jsonl` artifact (activation →
extension_satisfied → native_fill → verify — the fill-side sibling of the
nav agent-trace, classed/identifier data only); and
`fill_field_outcomes.filled_by` labels each field `extension` (JobRight's
extension satisfied the planned answer before we typed anything),
`native` (our deterministic gap-fill), or `skipped`. The long-run model —
an in-house agent that replaces the extension — learns per-field from
exactly this: which field shapes the extension handles, which it misses,
and which walls it never clears.
