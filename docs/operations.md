# Operations

## Setup

```text
cd C:\dev\jobright-application-agent
npm install
npx playwright install chromium
npm run migrate
npm run verify:phase2b
```

## Core CLI

```text
npm run cli -- --help
npm run migrate
npm run report
npm run run:dry
```

## Authentication (Phase 2)

JobRight Google OAuth (required):

```text
npm run chrome:debug:jobright
npm run login:jobright:cdp
```

Other services:

```text
npm run login:linkedin
npm run login:outlook
npm run candidate:encrypt-sensitive
```

See [authentication.md](authentication.md).

## JobRight recorder (Phase 2b)

```text
npm run login:jobright
npm run record:jobright
npm run record:jobright -- --workflow apply-autofill
npm run record:jobright -- --all
npm run record:jobright -- --workflow job-feed --derive-fixtures
```

See [jobright-recorder.md](jobright-recorder.md).

## Database

Default path: `data/app.sqlite` (gitignored). Migrations: `src/storage/db/migrations/`.
