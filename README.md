# jobright-application-agent

Local deterministic Playwright application processor (JobRight → ATS → Outlook drafts).

**Do not** place this repo under OneDrive. Canonical path: `C:\dev\jobright-application-agent`.

## Phase status

**Phase 5.5 complete** (Phases 0–5 integrated and hardened). Phase 6 not started.

See [docs/phase55-remediation.md](docs/phase55-remediation.md).

## Quick start

```text
npm install
npx playwright install chromium
npm run migrate
npm run verify:phase5
npm run login:jobright:cdp
npm run discover -- --fixture --max-jobs 5
```

See [docs/jobright-workflow.md](docs/jobright-workflow.md).
