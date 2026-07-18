# jobright-application-agent

Local deterministic Playwright application processor (JobRight → ATS → Outlook drafts).

**Do not** place this repo under OneDrive. Canonical path: `C:\dev\jobright-application-agent`.

## Phase status

Phase 0–2 complete: skeleton + SQLite + separate service login (`STORAGE_STATE` / `PERSISTENT_CONTEXT`) + encrypted sensitive profile. No JobRight/ATS automation yet.

## Quick start

```text
npm install
npx playwright install chromium
npm run migrate
npm run verify:phase2
npm run login:jobright
npm run login:linkedin
npm run login:outlook
```

See [docs/architecture.md](docs/architecture.md), [docs/authentication.md](docs/authentication.md), and [docs/operations.md](docs/operations.md).
