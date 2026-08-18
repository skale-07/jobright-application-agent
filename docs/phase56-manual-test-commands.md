# Phase 5.6 — Manual live-validation command runbook

**Status:** Documentation only. No live tests were executed while generating this file.

**Baseline:** commit `15f20a4` / tag `phase-5.5-complete`.

**Safety:** Every live-oriented command below keeps `SUBMIT_ENABLED=false`. Do not enable submission.

Validation levels: see [validation-levels.md](./validation-levels.md).

---

## Existing command coverage (summary)

| Validation step | Status | Existing interface | Ceiling with current CLI |
| --------------- | ------ | ------------------ | ------------------------ |
| Preflight / local green | `COMMAND_EXISTS` | `verify:phase5`, checks, `report` | `UNIT_CONFIRMED` / `FIXTURE_CONFIRMED` |
| JobRight auth readiness | `COMMAND_EXISTS` | `login:jobright:cdp`, `report` | Prerequisite only |
| JobRight live feed read + queue | `COMMAND_PARTIAL` | `discover --max-jobs N` (no `--fixture`) | Can support `LIVE_READ_ONLY_CONFIRMED` for feed scrape; **writes local SQLite** |
| JobRight stored-job inspect (by id) | `COMMAND_EXISTS` | `inspect --job <jobright_job_id>` (SQLite → direct detail URL) | `LIVE_READ_ONLY_CONFIRMED` when live identity passes |
| JobRight resume-control detect (one listing) | `COMMAND_EXISTS` | `inspect --job` control visibility + `discover --probe-detail` | Visibility only; no generate click |
| Greenhouse live browser inspect | `COMMAND_EXISTS` | `ats:inspect --url <greenhouseUrl>` | `LIVE_READ_ONLY_CONFIRMED` after manual live run |
| Greenhouse inspect from saved HTML | `COMMAND_EXISTS` | `ats:inspect --html <path> --url <url>` | Offline / saved HTML only |
| Greenhouse live fill | `COMMAND_MISSING` | `ats:fill` is **fixture-only** | Ceiling today: `FIXTURE_CONFIRMED` |
| JobRight live resume download | `COMMAND_MISSING` | Library: `downloadAndVerifyResume` | No CLI |
| Evidence / DB inspection | `COMMAND_PARTIAL` | `report`, filesystem, optional `sqlite3` | — |

---

## A. Preconditions

1. Working directory: `C:\dev\jobright-application-agent`
2. Git at `15f20a4` / tag `phase-5.5-complete`, clean tree
3. Phase 6 files absent; do not touch `stash@{0}`
4. JobRight storage state already created (`npm run login:jobright:cdp` previously succeeded)
5. For Greenhouse HTML inspect: you will manually save page HTML yourself (browser Save As / DevTools) — the CLI does not fetch live Greenhouse pages
6. `SUBMIT_ENABLED` must stay `false` for every step
7. Do not run Workday URLs through fill paths

---

## B. User-supplied values

```powershell
$JOBRIGHT_JOB_ID="PASTE_JOBRIGHT_JOB_ID_FROM_DISCOVER_OR_URL"
$GREENHOUSE_URL="PASTE_REAL_GREENHOUSE_APPLICATION_URL_HERE"
$GREENHOUSE_HTML="C:\path\to\saved-greenhouse-page.html"
$DB="data\app.sqlite"
```

Notes:

- There is **no** CLI flag today that accepts a full JobRight listing URL for a dedicated read-only probe.
- `discover` always starts from the configured JobRight feed (`JOBRIGHT_FEED_URL` / default recommend feed).
- `ats:fill` does **not** accept `$GREENHOUSE_URL` — only `--fixture greenhouse`.

---

## C. Copy-paste PowerShell commands

### 1. Preflight

```powershell
cd C:\dev\jobright-application-agent
```

```powershell
git rev-parse --short HEAD; git describe --tags --exact-match HEAD 2>$null; git status -sb
```

```powershell
git stash list
```

```powershell
Test-Path src\applications\autofillCompare.ts; Test-Path src\applications\jobrightAutofill.ts; Test-Path tests\unit\ats-phase6.test.ts; Select-String -Path package.json -Pattern "verify:phase6|autofill:compare"
```

```powershell
node -v; npm -v
```

```powershell
npx playwright --version
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run migrate
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run check:secrets
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run check:forbidden
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run verify:phase5
```

```powershell
Write-Host "FORM_FILL_ENABLED=$env:FORM_FILL_ENABLED DRY_RUN=$env:DRY_RUN SUBMIT_ENABLED=$env:SUBMIT_ENABLED"
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"
```

**Safe reset (run after any mutation-oriented shell session):**

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; Write-Host "SAFE: FORM_FILL_ENABLED=$env:FORM_FILL_ENABLED DRY_RUN=$env:DRY_RUN SUBMIT_ENABLED=$env:SUBMIT_ENABLED"
```

| Command purpose | Success | Must not | Level |
| --- | --- | --- | --- |
| Preflight above | Exit 0; HEAD `15f20a4`; no Phase 6 paths; verify green | Mutate employers; apply stash | Local gates only |

---

### 2. JobRight live read-only (COMMAND_PARTIAL)

**Auth readiness (no JobRight page mutation):**

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run report
```

- Does: prints auth readiness / rollout flags / open review counts.
- Success: JobRight `ready: true` (or clear login guidance).
- Must not: open employer ATS; submit.
- Level: prerequisite (not a listing confirmation).

**If login needed (interactive; do not automate 2FA):**

```powershell
npm run chrome:debug:jobright
```

```powershell
npm run login:jobright:cdp
```

**Live feed scrape + eligibility (headed; writes local SQLite applications):**

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run discover -- --max-jobs 1
```

- Does: opens JobRight feed via `PlaywrightServiceSession`, parses cards, upserts job + application rows.
- Success: JSON with `jobs_inspected >= 1`, `dedupe_kind` present, exit 0.
- Must not: click Improve Resume; open Greenhouse; submit.
- Level: can contribute to `LIVE_READ_ONLY_CONFIRMED` for **feed discovery only** (local DB writes expected).

**Deterministic inspect by stored JobRight job id (SQLite → direct detail URL):**

```powershell
$JOBRIGHT_JOB_ID="PASTE_STORED_JOBRIGHT_JOB_ID_HERE"
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"
```

```powershell
npm run inspect -- --job $JOBRIGHT_JOB_ID
```

- Does: resolves the job from SQLite, opens the persisted JobRight detail URL via `PlaywrightServiceSession`, verifies identity, reports control visibility, writes `artifacts\inspection\jobright-inspect-*.json`.
- Success: console shows `JobRight inspection: LIVE_READ_ONLY_CONFIRMED`, `Identity verified: true`, `Mutation attempted: false`.
- Must not: scrape the recommendation feed as a prerequisite; click Improve Resume / Apply / ATS; submit.
- Level: `LIVE_READ_ONLY_CONFIRMED` when live identity passes.
- Failure if not in SQLite: `Stored JobRight job not found: <id>`
- Failure if wrong page: `JobRight identity verification failed.`

```powershell
Write-Host "FORM_FILL_ENABLED=$env:FORM_FILL_ENABLED DRY_RUN=$env:DRY_RUN SUBMIT_ENABLED=$env:SUBMIT_ENABLED"
```

```powershell
$LATEST_INSPECTION=Get-ChildItem artifacts\inspection\jobright-inspect-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1; Get-Content $LATEST_INSPECTION.FullName
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run report
```

**Optional probe first recommended job detail UI (resume/cover controls):**

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run discover -- --max-jobs 1 --probe-detail
```

- Does: after discovery, opens the first card’s JobRight detail and writes a probe JSON under `artifacts\discovery\`.
- Success: console prints `Wrote job detail probe: ...`; JSON includes `resume` / `apply` probes.
- Must not: click Improve Resume / download; submit ATS.
- Level: `LIVE_READ_ONLY_CONFIRMED` for control **visibility** only if you confirm no generation click occurred.

**Operator-assisted recorder (resume UI capture without generating):**

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run record:jobright -- --workflow resume-generator
```

- Does: opens JobRight session; waits for Enter while you navigate to resume UI; saves sanitized capture under live-captures.
- Success: `Saved: ...` path printed; you did **not** click generate/download.
- Must not: generate/download resume in this step if classifying read-only.
- Level: evidence for selectors; `LIVE_READ_ONLY_CONFIRMED` only if no generation click.

**Abort if:** login wall, CAPTCHA, wrong job identity, accidental Improve Resume click, or any employer form open for submit.

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"
```

---

### 3. Greenhouse live read-only (`COMMAND_EXISTS`)

Target: `LIVE_READ_ONLY_CONFIRMED` after a real Greenhouse form is inspected manually.

**Preferred first live target** — Greenhouse-hosted integration sandbox (not a personally targeted employer app):

```powershell
$GREENHOUSE_URL="https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003"
```

Live Greenhouse-hosted integration sandbox. Useful for validating current Greenhouse DOM discovery without inspecting a personally targeted employer application.

**Known no-form redirect example** (must fail as `FORM_NOT_FOUND`, not login wall and not a host refuse):

```powershell
$GREENHOUSE_URL="https://boards.greenhouse.io/okta/jobs/7617090"
```

Or paste any other real Greenhouse job URL matching `boards.greenhouse.io/<board>/jobs/<id>`:

```powershell
$GREENHOUSE_URL="PASTE_REAL_GREENHOUSE_APPLICATION_URL_HERE"
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"
```

```powershell
Write-Host "FORM_FILL_ENABLED=$env:FORM_FILL_ENABLED DRY_RUN=$env:DRY_RUN SUBMIT_ENABLED=$env:SUBMIT_ENABLED"
```

```powershell
npm run ats:inspect -- --url $GREENHOUSE_URL
```

Headed (recommended for first live sandbox run):

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run ats:inspect -- --url $GREENHOUSE_URL --headed
```

- Does: validates Greenhouse URL, opens ephemeral Chromium (no JobRight auth), records the final host (host is not a refuse), discovers/classifies fields, writes proposed fill plan + artifact under `artifacts\inspection\greenhouse-inspect-*.json`.
- Success: `Greenhouse inspection: LIVE_READ_ONLY_CONFIRMED`, `Identity verified: true`, `Mutation attempted: false`.
- Careers homepage with no form: `FORM_NOT_FOUND` (not “Login wall”, not a host refuse).
- Must not: fill, upload, click Submit, invent sponsorship, answer essays.
- Level: `LIVE_READ_ONLY_CONFIRMED` only on a real live form.

```powershell
$LATEST_GREENHOUSE_INSPECTION=Get-ChildItem artifacts\inspection\greenhouse-inspect-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1; Get-Content $LATEST_GREENHOUSE_INSPECTION.FullName
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run report
```

**Stop if:**

- URL redirects away from trusted Greenhouse
- CAPTCHA appears
- High-confidence login wall (password + sign-in form) — not a nav “Login” link
- Page is not the expected company or role
- Any field value changes
- Any checkbox changes
- Any file chooser opens
- Any submit interaction occurs
- Raw candidate PII appears in the artifact

**Offline alternatives (not live):**

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run ats:inspect -- --fixture greenhouse
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run ats:inspect -- --html $GREENHOUSE_HTML --url $GREENHOUSE_URL
```

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"
```

---

### 4. Greenhouse guarded live fill

**Status: `COMMAND_MISSING`**

Existing fill CLI is fixture-only:

```powershell
$env:FORM_FILL_ENABLED="true"; $env:DRY_RUN="false"; $env:SUBMIT_ENABLED="false"; npm run ats:fill -- --fixture greenhouse --execute
```

- This is **`FIXTURE_CONFIRMED` only**. It does **not** accept `$GREENHOUSE_URL`.
- Do **not** treat this as `LIVE_MUTATION_CONFIRMED`.

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"
```

If you need live fill later, implement a dedicated CLI (see Missing interfaces). Until then: **stop after Greenhouse read-only HTML inspect.**

---

### 5. JobRight guarded resume generation/download

**Status: `COMMAND_MISSING`**

Library exists: `src/jobright/resumeDownload.ts` → `downloadAndVerifyResume`.

No package script / CLI command invokes it against a live listing.

Do not invent a one-off `tsx` mutation script in this runbook.

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"
```

---

### 6. Evidence inspection

**Rollout / auth / applications summary:**

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; npm run report
```

**List recent discovery probes / ATS inspect artifacts:**

```powershell
Get-ChildItem -Recurse artifacts\discovery, artifacts\ats-inspect, artifacts\ats-fill, artifacts\applications -ErrorAction SilentlyContinue | Select-Object FullName, Length, LastWriteTime
```

**Confirm submit flags in current shell:**

```powershell
Write-Host "SUBMIT_ENABLED=$env:SUBMIT_ENABLED FORM_FILL_ENABLED=$env:FORM_FILL_ENABLED DRY_RUN=$env:DRY_RUN"
```

**Prove no verified submission rows (optional `sqlite3` if installed):**

```powershell
sqlite3 data\app.sqlite "SELECT COUNT(*) AS verified_submissions FROM submissions WHERE status='VERIFIED' AND submitted=1;"
```

**List materials / review / leases / idempotency (optional `sqlite3`):**

```powershell
sqlite3 data\app.sqlite "SELECT id, application_id, kind, sha256, size_bytes, verified, path FROM materials ORDER BY created_at DESC LIMIT 20;"
```

```powershell
sqlite3 data\app.sqlite "SELECT id, kind, status, title, application_id, created_at FROM review_items WHERE status IN ('OPEN','IN_PROGRESS') ORDER BY created_at DESC LIMIT 20;"
```

```powershell
sqlite3 data\app.sqlite "SELECT resource_type, resource_id, holder_run_id, expires_at FROM leases ORDER BY acquired_at DESC LIMIT 20;"
```

```powershell
sqlite3 data\app.sqlite "SELECT idempotency_key, status, resource_type, resource_id, result_ref, updated_at FROM idempotency_keys ORDER BY updated_at DESC LIMIT 20;"
```

```powershell
sqlite3 data\app.sqlite "SELECT id, job_id, state, route, updated_at FROM applications ORDER BY updated_at DESC LIMIT 20;"
```

```powershell
sqlite3 data\app.sqlite "SELECT application_id, previous_state, next_state, reason, timestamp FROM application_events ORDER BY timestamp DESC LIMIT 30;"
```

If `sqlite3` is not installed: use `npm run report` plus artifact file review only; do not invent destructive DB tools.

**Sanitized live captures (recorder):**

```powershell
Get-ChildItem -Recurse fixtures\live-captures -ErrorAction SilentlyContinue | Select-Object FullName, Length, LastWriteTime
```

---

### 7. Cleanup / environment reset

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"; Write-Host "SAFE RESET OK"
```

Do not delete traces/screenshots automatically.

Do not `git stash` / apply Phase 6.

Do not push.

---

### 8. Failure and abort

1. Press `Ctrl+C` in the active terminal.
2. Immediately run the safe reset command above.
3. Close any Playwright/Chrome debug windows manually without clicking Submit on employer sites.
4. Re-run `npm run report` and optional `sqlite3` submission count query.
5. If auth expired: expect / create open `AUTH_REQUIRED` review via normal login recovery (`login:jobright:cdp`); do not continue fill/resume.
6. Inspect `leases` / `idempotency_keys` for stuck `in_progress` rows — do **not** hand-delete; note for review.
7. Preserve `artifacts\` and `fixtures\live-captures\` evidence before any cleanup.
8. Abort permanently if: CAPTCHA, unexpected 2FA, Submit focused/clicked, essay filled, sponsorship inferred, wrong job identity, raw PII in sanitized artifacts.

---

## D. Expected results (cheat sheet)

| Step | Exit | Output pattern | Artifact / DB | Level |
| ---- | ---- | -------------- | ------------- | ----- |
| `verify:phase5` | 0 | `verify:phase5: ok` + UNIT/FIXTURE/UNVERIFIED banner | local only | `UNIT_CONFIRMED` + `FIXTURE_CONFIRMED` |
| `discover --max-jobs 1` | 0 | JSON report with applications | SQLite jobs/applications | Live feed read + local writes |
| `discover --probe-detail` | 0 | `Wrote job detail probe` | `artifacts/discovery/job-detail-probe-*.json` | Resume control visibility |
| `ats:inspect --html/--url` | 0 | `route`, `mapped_fields` | stdout (+ optional prior save) | Live HTML offline inspect |
| `ats:fill --fixture --execute` | 0/2 | redacted fill report | `artifacts/ats-fill/...` | **`FIXTURE_CONFIRMED` only** |

---

## E. Abort conditions

Stop immediately if any of:

- Login wall / CAPTCHA / unexpected 2FA
- Unsupported ATS (e.g. Workday) on a fill attempt
- Submit button focused or clicked
- Essay field receives a value
- Sponsorship answer invented as Yes/No without explicit profile value
- More than one resume generation starts
- Wrong job identity
- Sanitized artifact contains raw secrets/PII

---

## F. Manual evidence checklist

```text
[ ] Correct listing identity
[ ] Authenticated session confirmed
[ ] Submit disabled (SUBMIT_ENABLED=false printed)
[ ] No essay fields filled
[ ] No sponsorship inference
[ ] Resume hash recorded (N/A until live resume CLI exists)
[ ] Database row inspected
[ ] No duplicate material created (N/A until live resume CLI exists)
[ ] No submission record created (verified_submissions count = 0)
[ ] Trace/capture sanitized
[ ] Screenshots excluded from promotion / reviewed
[ ] Browser closed without submission
```

---

## Missing commands required before manual live testing

1. **`ats:fill --url <greenhouseUrl> --execute`** with approved-plan gate, `SUBMIT_ENABLED=false`, headed, no essay/sponsorship inference. Module: `applicationFiller` / Greenhouse adapter (today fixture-only).
2. **`jobright:resume --job <jobrightJobId>`** (or application id) — calls `downloadAndVerifyResume` once with lease + idempotency. Module: `src/jobright/resumeDownload.ts`.
3. Optional: **`db:inspect` / `materials:list`** — first-class CLI instead of optional `sqlite3`.

Live Greenhouse **read-only** inspection is implemented (`ats:inspect --url`). Live fill and JobRight resume download remain missing.
