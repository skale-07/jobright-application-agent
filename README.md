# jobright-application-agent

Local deterministic Playwright application processor (JobRight → ATS → Outlook drafts).

**Do not** place this repo under OneDrive. Canonical path: `C:\dev\jobright-application-agent`.

## Phase status

Phase 0–3 complete for JobRight **discovery** (feed parse, eligibility, SQLite queue). Contacts automation and ATS submit are not started.

## Quick start

```text
npm install
npx playwright install chromium
npm run migrate
npm run verify:phase3
npm run login:jobright:cdp
npm run discover -- --fixture --max-jobs 5
npm run discover -- --max-jobs 10
```

See [docs/jobright-workflow.md](docs/jobright-workflow.md).
