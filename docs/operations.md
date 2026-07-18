# Operations (Phase 1)

## Setup

```text
cd C:\dev\jobright-application-agent
npm install
npm run migrate
npm run verify:phase1
```

## CLI stubs

```text
npm run cli -- --help
npm run run:dry
npm run migrate
npm run report
```

Login, record, dashboard, inspect, retry, and resume-essay commands exist as stubs and exit non-zero with a clear message until later phases.

## Database

Default path: `data/app.sqlite` (gitignored). Migrations: `src/storage/db/migrations/`.
