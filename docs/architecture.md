# Architecture (Phase 0/1)

## Purpose

Local Chromium-based application processor: JobRight discovery → materials → ATS fill/submit → contacts → LinkedIn enrichment → Outlook **drafts only**.

Not a general autonomous browser agent. Deterministic adapters, approved candidate context, human essays, verified submissions.

## Location

Project root: `C:\dev\jobright-application-agent` (outside OneDrive).

## Operational source of truth

**SQLite** (`data/app.sqlite`) owns queue state, transitions, idempotency, leases, and review items.

| Layer | Role |
| --- | --- |
| SQLite | Canonical state |
| `artifacts/` | PDFs, screenshots, traces, JSON exports |
| JSONL | Optional diagnostic log |
| `state.json` | Readable export from SQLite only |

## Phase 1 scope

Skeleton only: config, logging, migrations, state machine, idempotency, leases, review items, job fingerprints, artifact paths, CLI stubs, security/forbidden checks, recorder sanitization helpers.

**Out of scope until later phases:** authentication, JobRight automation, ATS adapters, LinkedIn extraction, LLM calls, Outlook interaction.

## Key corrections baked into schema

1. **Job fingerprint** — stable duplicate key over JobRight id + normalized URL + company + role.
2. **Verified-submission uniqueness** — at most one verified successful submission per application.
3. **Leases** — DB-backed locks with expiry for crash-safe in-progress work.
4. **Review items** — human queue for uncertain submit, essays, ambiguous fields, auth/CAPTCHA.
5. **Recorder sanitization** — strip secrets/PII before writing captures (helpers in Phase 1; recorder CLI later).
6. **Outlook send guards** — no `sendEmail`; CI check forbids send APIs and `EMAIL_SEND_ENABLED`.

## Service sessions (later)

Separate contexts for JobRight, LinkedIn, Outlook. `STORAGE_STATE` default; `PERSISTENT_CONTEXT` fallback. LinkedIn package receives an injected `Page`.

## Staged rollout

Inspect → Fill → Human-approved submit → Capped unattended → Expand. Defaults fail-closed.
