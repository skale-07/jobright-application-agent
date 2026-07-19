# Phase 5.6 — Live validation plan (documentation only)

**Do not run live mutation automatically.** Human initiation required for any live mutation step.

No step in this document is currently `LIVE_READ_ONLY_CONFIRMED` or `LIVE_MUTATION_CONFIRMED` until executed with evidence.

## JobRight live read-only

- Open one real listing via `PlaywrightServiceSession`
- Confirm auth; confirm listing identity
- Detect resume-generation controls; record selector evidence
- **Do not** click generate/download yet
- Classify: `LIVE_READ_ONLY_CONFIRMED` or leave `UNVERIFIED`

## JobRight guarded resume (human-initiated)

- Lease + idempotency key
- Generate one resume on real UI; capture Playwright download
- Verify `%PDF-`, size, SHA-256; atomic persist; SQLite materials row
- No duplicate material for same key
- Possible: `LIVE_MUTATION_CONFIRMED`

## Greenhouse live read-only

- Open one real Greenhouse application
- Detect adapter; discover/classify fields; produce approved fill plan
- **Do not** mutate
- Possible: `LIVE_READ_ONLY_CONFIRMED`

## Greenhouse guarded fill (human-initiated)

- `FORM_FILL_ENABLED=true`, `DRY_RUN=false`, `SUBMIT_ENABLED=false`
- Fill deterministic fields only; no essays; no invented sponsorship
- Upload verified resume; read back values; verify upload indicators when possible
- Close page; never click Submit
- Possible: `LIVE_MUTATION_CONFIRMED`

## Remains UNVERIFIED until live evidence

- Live JobRight resume UI compatibility
- Live Greenhouse field / custom widget compatibility
- Employer-side upload processing
- Full mid-run auth recovery on every materials path
- Multi-process stress beyond current SQLite tests
