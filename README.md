<img src="design/logo.svg" alt="dispatch·console" width="232" height="40" />

# jobright-application-agent

**Dispatch** — the application operator console. A local, deterministic
Playwright application processor (JobRight → ATS → Outlook drafts) with an
operator web console and operator-armed autonomy. Every application
accounted for.

Design system: [DESIGN.md](DESIGN.md) · Coding-agent context: [AGENTS.md](AGENTS.md)

**Do not** place this repo under OneDrive. Canonical path: `C:\dev\jobright-application-agent`.

## Phase status

**Phases 0–13 engineering complete** at `UNIT/FIXTURE_CONFIRMED`: discovery → materials → inspect → fill → essays → **gated submit** → contacts → **LLM outreach** → **Outlook drafts** → dashboard, plus the inert Phase 6 J1 authoring sidecar. Live validation is stepwise and operator-driven.

**Start here:** [docs/operator-guide.md](docs/operator-guide.md) — the end-to-end walkthrough.

Status + direction: [docs/current-state-and-phase56.md](docs/current-state-and-phase56.md) · Limitations: [docs/known-limitations.md](docs/known-limitations.md) · Phase 6 eval: [docs/browser-use-evaluation.md](docs/browser-use-evaluation.md).

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
