# Architecture (Phase 0/1)

## Purpose

Local Chromium-based application processor: JobRight discovery → materials → ATS fill/submit → contacts → LinkedIn enrichment → Outlook **drafts only**.

Not a general autonomous browser agent. Deterministic adapters, approved candidate context, human essays, verified submissions.

**The LLM boundary:** one shared client seam (`src/contacts/emailLlm.ts` — Anthropic preferred, OpenAI fallback), consumed by flag-gated surfaces (outreach generation, screener label mapping/prediction, essay draft suggestions, healer proposals, nav agent sidecar), each deterministically re-validated. No LLM ever auto-fills form answers, essays, demographics, or sponsorship.

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

## Operator console (web UI)

Two HTTP servers exist, deliberately separate:

- `src/dashboard/` — the original read-only view. GET-only *by
  construction* (every other method is 405 before routing). Unchanged.
- `src/console/` — the operator console: read API plus guarded mutations,
  serving the built React app in `frontend/dist`.

Both bind `127.0.0.1` only (validated in `src/config/env.ts`). The console
additionally checks the `Host` header on every request (DNS-rebinding
defense) and requires a per-boot random bearer token on every POST,
delivered to the browser in a URL fragment so it never reaches the server
or its logs.

### Runs are child processes

Long-running work is not executed inside the server. `RunManager`
(`src/console/runManager.ts`) spawns `src/console/runner.ts`, which calls
the same domain functions the CLI calls (`runPipeline`, `runNavigation`,
`runAtsSubmission`). This keeps capability flags out of the long-lived
server process — they are composed per run — and gives crash isolation and
a natural progress stream.

Parent and child speak a line protocol on stdio: control frames are
single-line JSON carrying the reserved key `jaa_frame`
(`hello` / `confirm_request` / `report` / `error`); every other line is a
log line the parent forwards with a sequence number. The report is a frame
*and* is written to `report.json`, so a demux failure cannot lose it.

### The flag ceiling

`src/console/flagCeiling.ts` implements the rule that the process `.env`
is the upper bound on capability. `composeChildEnv` sets **every** gated
key explicitly — `"true"` only when the ceiling allows it *and* the UI
opted in for that run — so a child's environment is fully determined rather
than inherited. `DRY_RUN` is inverted (live mode requires an explicit
`DRY_RUN=false` in `.env` plus opt-in), and
`SUBMIT_REQUIRES_LOCAL_CONFIRMATION=true` /
`MAX_UNATTENDED_SUBMISSIONS_PER_RUN=0` are forced, making the unattended
submit branch unreachable from the console.

### Submit confirmation is a transport, not a policy

`src/applications/submitConfirmation.ts` defines the confirmation seam.
The default implementation is the historical TTY prompt (byte-identical,
never declines). The console injects a callback that carries the same
summary over the runner's stdio to a browser modal and returns the
operator's answer. The callback sits at exactly the point the prompt sat —
after every gate and before the `SUBMITTING` transition — so it cannot skip
a guard. Every failure mode (timeout, closed tab, dropped stream, parent
death, malformed or stale answer) resolves to *declined*, which refuses
before any page mutation.

### Review resolution

`src/queue/reviewResolvers.ts` is the shared domain layer behind both the
CLI and the console, so the two cannot diverge. Resolvers transition only
when the application still sits in the state the item blocks on; otherwise
the item resolves on its own and the response reports `transition_skipped`.
All transitions go through the state machine.
