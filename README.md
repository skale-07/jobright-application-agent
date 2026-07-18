# jobright-application-agent

Local deterministic Playwright application processor (JobRight → ATS → Outlook drafts).

**Do not** place this repo under OneDrive. Canonical path: `C:\dev\jobright-application-agent`.

## Phase status

Phase 0–1 complete: repository skeleton, SQLite schema, state machine, idempotency, leases, review items, security checks. No browser automation yet.

## Quick start

```text
npm install
npm run migrate
npm run verify:phase1
```

See [docs/architecture.md](docs/architecture.md) and [docs/operations.md](docs/operations.md).
