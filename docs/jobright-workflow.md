# JobRight workflow (Phase 3)

## Scope

Phase 3 implements **discovery and materials probes** only:

- Parse Recommended Jobs feed (`/jobs/recommend`)
- Extract JobRight job IDs, company, role, location
- Eligibility checks (internship / May 2029 / hard exclusions)
- Persist jobs + applications in SQLite
- Probe Apply / Improve Resume / Cover Letter UI presence
- PDF download verification helpers

**Not in Phase 3:** employer ATS fill/submit, contact outreach automation.

## Selector registry

Versioned module: [`src/jobright/selectors/v1.ts`](../src/jobright/selectors/v1.ts)

Derived from live captures. Contacts selectors are marked incomplete.

## Commands

Offline discovery (fixture feed HTML, no browser):

```text
npm run discover -- --fixture --max-jobs 5
npm run run:dry -- --fixture
```

Live (requires JobRight storageState + job already in SQLite):

```text
npm run discover -- --max-jobs 10
npm run discover -- --max-jobs 3 --probe-detail
npm run inspect -- --job <jobright_job_id>
```

`inspect --job` resolves the job from SQLite and opens the persisted detail URL directly.
It does **not** search the recommendation feed. Run discovery first so the job is stored.

Offline fixture detail page (job must still exist in SQLite; uses local HTML):

```text
npm run inspect -- --job <jobright_job_id> --fixture
```

## Capture gaps

- `job-feed`: good
- resume/cover/apply: partial (entry CTAs present)
- school/beyond/email contacts: deferred (`contacts.supportedInV1 = false`)
