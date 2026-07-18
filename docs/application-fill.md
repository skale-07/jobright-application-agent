# Native autofill (Phase 5)

## Scope

Stage 2: **fill / upload / verify / reset** on Greenhouse fixtures.

- `FORM_FILL_ENABLED` must be `true` and `DRY_RUN=false` to mutate a page
- `SUBMIT_ENABLED` stays `false` — submit throws
- Essays are never auto-filled
- Demographics skipped (sensitive-profile path later)
- Lever/Ashby fill deferred until Greenhouse is green on live pages

## CLI

```bash
# Plan only (safe default)
npm run ats:fill -- --fixture greenhouse

# Execute against fixture HTML in headless Chromium
set FORM_FILL_ENABLED=true
set DRY_RUN=false
npm run ats:fill -- --fixture greenhouse --execute --resume tests/fixtures/ats/greenhouse/sample-resume.pdf
```

Reports: `artifacts/ats-fill/greenhouse/fill-plan.json` or `fill-report.json`.

## Verify

```bash
npm run verify:phase5
```
