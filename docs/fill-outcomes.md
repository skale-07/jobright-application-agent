# Field-fill outcomes layer

Append-only SQLite corpus of per-field fill/verify/heal outcomes for local adaptation.
Not a cloud training pipeline and not a substitute for `private/candidate/` profile data.

## Why

Each `ats:fill --execute` produces rich field detail (`verify.fields`, combobox picks, heal notes) that was previously only written to a **fixed overwriteable** artifact path. This layer keeps history so you can ask:

- How often does `Discipline` / `major` verify after synonym mapping?
- Does Greenhouse country still fail read-back as dial-code `+1`?
- Which boards accept `Bachelor's Degree` for profile `Bachelor of Science`?

## Schema

Migration: `src/storage/db/migrations/003_fill_outcomes.sql`

| Table | Role |
|-------|------|
| `fill_runs` | One row per **executed** fill (URL, ATS, host, validation_level, resume verified, heal counts) |
| `fill_field_outcomes` | One row per planned field (fill_ok, verify_match, selected_option, match_basis, heal_status, redacted expected/observed) |
| `fill_field_success_rates` | VIEW: rates by ATS / host / label / canonical |

## Privacy

| Canonical class | Stored as |
|-----------------|-----------|
| email / phone | partial mask (`a***@domain`, `***-***-XXXX`) |
| work_authorization / sponsorship | `[REDACTED_SPONSORSHIP]` |
| education option labels, majors | clear (training gold) |
| resume paths | never (resume evidence is verified bool only) |

PII fingerprints are **class-only** (same hash for any email) so they are not reverseable to cleartext. Prefer this corpus for local offline analysis; do not ship `data/app.sqlite` off-machine without a further scrub.

## Wiring

- **Live URL:** [`src/ats/greenhouse/liveFill.ts`](../src/ats/greenhouse/liveFill.ts) records on executed mutation (before redacted artifact write). Fail-open: DB errors never fail the fill.
- **Fixture:** [`src/applications/applicationFiller.ts`](../src/applications/applicationFiller.ts) records `source=fixture` on execute.
- Combobox `selected_option` / `match_via` / notes come from `FillResult.field_meta` filled by Greenhouse fill.

`mode=plan_only` is **not** recorded by default (outcomes need ground truth from mutation + verify).

## CLI

```powershell
# after migrate
npm run migrate

# summary stats
npm run ats:fill-outcomes -- --summary

# flat training-friendly JSONL
npm run ats:fill-outcomes -- --export artifacts/fill-outcomes.jsonl
```

Typical JSONL columns (per field row, joined to run): `fill_run_id`, `created_at`, `ats`, `job_url`, `job_host`, `label`, `canonical_field`, `control_kind`, `fill_ok`, `verify_match`, `expected_redacted`, `observed_redacted`, `selected_option`, `match_basis`, `heal_status`, `options_sample`.

## Example (sandbox discipline)

After a live Greenhouse execute:

```json
{
  "label": "Discipline",
  "canonical_field": "major",
  "expected_redacted": "Applied Math & Stats",
  "selected_option": "Mathematics",
  "match_basis": "unique_substring",
  "verify_match": 1
}
```

## Non-goals

- Auto-rewriting answer-aliases from outcomes (consumer of this layer)
- Fine-tuning / cloud model training
- Real-time dashboard
- Fixing verify false positives (country dial collapse, phone ITI format) — track them here, fix separately
