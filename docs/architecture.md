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

## Phase 1–2 scope

Phase 1: config, logging, migrations, state machine, idempotency, leases, review items, job fingerprints, artifact paths, CLI stubs, security/forbidden checks, recorder sanitization helpers.

Phase 2: `ServiceSession` (`STORAGE_STATE` | `PERSISTENT_CONTEXT`), three login CLIs, auth validation + expiry → review items, AES-GCM sensitive profile + Windows DPAPI key wrap.

Phase 2b: JobRight recorder (`npm run record:jobright`) writes sanitized live captures under `fixtures/live-captures/` for seven workflows. No production selectors yet.

**Out of scope until later phases:** JobRight automation beyond login/recorder, ATS adapters, LinkedIn extraction, LLM calls, Outlook draft interaction (send remains forbidden).

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
