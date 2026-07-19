# Phase 5.5 remediation

## Status

Phases 0–5 are integrated and hardened locally. **Phase 6 is not started.**

See also: [validation-levels.md](./validation-levels.md), [phase56-live-validation-plan.md](./phase56-live-validation-plan.md).

## Environment isolation (post-fix)

- `verify:phase5` forces `FORM_FILL_ENABLED=false` / `DRY_RUN=true` / `SUBMIT_ENABLED=false` for typecheck, test, migrate, and checks.
- Only the final `--fixture greenhouse --execute` step receives fill-enabled flags (still `SUBMIT_ENABLED=false`).
- Phase 4/5 unit tests use `tests/helpers/fillEnvIsolation.ts` so ambient shell env cannot leak.
- No `.env` file is required for fail-closed defaults.

## What Phase 5.5 fixed (validation levels)

| Area | Level | Notes |
|------|-------|-------|
| Discovery dedupe | `UNIT_CONFIRMED` | Partial unique index + getOrCreate |
| Fill policy / sponsorship | `UNIT_CONFIRMED` | Approved plan; no invented Yes/No |
| Sessions | Code wired; live mid-run paths largely `UNVERIFIED` | ServiceSession used for JR workflows |
| Resume download | `FIXTURE_CONFIRMED` | Local download fixture; live JR UI `UNVERIFIED` |
| Greenhouse fill | `FIXTURE_CONFIRMED` | Local HTML; live boards `UNVERIFIED` |
| Recorder promote | `UNIT_CONFIRMED` / fixture path | Sanitized promote |
| Redaction | `UNIT_CONFIRMED` | |
| `verify:phase5` | Suite + fixture execute | Does **not** prove live pipeline |

## Commands

```bash
npm run verify:phase5
npm run recorder:promote -- --run <runId> --workflow job-feed
npm run discover -- --fixture --max-jobs 5
```
