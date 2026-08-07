# Operator guide — end to end

The single walkthrough for driving one application from discovery to a
verified submission and an outreach draft. Every step lists the exact
command, the flags it needs, what success looks like, the common failure
modes, and the validation level the step ships at.

**Validation-level discipline** ([validation-levels.md](./validation-levels.md)):
every feature below ships at `UNIT_CONFIRMED` / `FIXTURE_CONFIRMED`. Live
levels are earned by *you* running the live steps — nothing here promotes
itself.

**The safety model in one paragraph.** Everything mutating is fail-closed
behind env flags and refuses loudly with the flag named in the message.
Submission additionally requires a per-submission human confirmation
(`SUBMIT_REQUIRES_LOCAL_CONFIRMATION=true`, the default) and is blocked
forever after a verified — or unresolved uncertain — submission for that
application. Outreach uses an LLM for exactly one thing (email text), the
output is deterministically re-validated, and mail can never be dispatched:
drafts only, enforced by CI-level banned-identifier checks.

## Contents

0. [One-time setup](#0-one-time-setup)
1. [Login (JobRight via CDP, Outlook)](#1-login)
2. [Discover jobs](#2-discover)
3. [Inspect (JobRight detail + ATS form: greenhouse/lever/ashby)](#3-inspect)
4. [Register a domain resume](#4-materials)
5. [Rehearse the fill](#5-fill)
6. [Essays (ATS-form questions — human-written)](#6-essays)
7. [Submit (gated, human-approved)](#7-submit)
8. [Review queue + uncertain submissions](#8-review)
9. [Contacts + persona setup](#9-contacts-and-personas)
10. [Generate the outreach email (LLM)](#10-email-generation)
11. [Outlook draft (create + verify)](#11-outlook-drafts)
12. [Dashboard](#12-dashboard)
13. [Pipeline driver + retry](#13-pipeline)
14. [Agent-assisted adapter authoring (Phase 6 J1)](#14-agent-authoring)

Essays (§6) vs outreach emails (§10) are different things: essays are
free-text questions **on the employer's application form**, always written
by you; outreach emails are **networking messages to contacts**, generated
by the LLM from your template and persona, reviewed by you in the Drafts
folder.

---

## 0. One-time setup

```powershell
cd C:\dev\jobright-application-agent
npm install
npx playwright install chromium
npm run hooks:install      # REQUIRED: makes check:secrets a pre-commit hook
npm run migrate
npm run verify:phase5      # full local gate; expect "verify:phase5: ok"
```

Put your real resume PDFs in `private\candidate\resumes\` (gitignored) —
never at the repo root. The pre-commit hook blocks commits containing
resumes, `.env` copies, editor Local History snapshots, or non-example
profile JSON.

Safe env for everything read-only (set this in each new shell):

```powershell
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"
```

Candidate data:

```powershell
copy private\candidate\public-profile.example.json private\candidate\public-profile.json
copy private\candidate\answer-aliases.example.json private\candidate\answer-aliases.json
# edit both with your real values (gitignored)
```

**Failure modes:** `check:secrets` refusing a commit means you staged
something private — unstage it, never force. Red `verify:phase5` before you
changed anything means environment drift; fix before proceeding.

## 1. Login

JobRight uses Google OAuth, which blocks automated browsers — attach to a
Chrome you started instead:

```powershell
npm run chrome:debug:jobright     # starts Chrome with CDP on 127.0.0.1:9222
# sign into JobRight with Google in THAT window, then:
npm run login:jobright:cdp
```

Expected: `Authenticated. Saved storageState: private\auth\jobright.storage.json`.

Outlook (needed only for §11):

```powershell
npm run login:outlook
```

**Failure modes:** validation failing with a checkpoint URL means finish
the sign-in in the window first. If discovery later reports
`AUTH_REQUIRED`, re-run login — sessions expire. If the saved state doesn't
carry auth into fresh contexts (a known open question, see
[current-state-and-phase56.md](./current-state-and-phase56.md) §2.6b), run
the diagnostic: `npx tsx scripts/diag-jobright-feed.ts`.

## 2. Discover

```powershell
npm run discover -- --max-jobs 10        # live feed → SQLite
npm run discover -- --fixture --max-jobs 5   # offline sanity check
npm run report                            # applications_by_state should show QUEUED
```

Expected: `jobs_inspected > 0` and application rows in `QUEUED`. An empty
live feed **fails loud** with artifacts under `artifacts/discovery/` and a
review item — read `meta.json`'s `cards_selector_attached` to tell parser
drift (true) from auth/render trouble (false).

Level: fixture `FIXTURE_CONFIRMED`; live discovery currently `UNVERIFIED`
(§2.6b).

## 3. Inspect

Read-only, safe-env. JobRight detail (from SQLite, no feed search):

```powershell
npm run inspect -- --job <jobright_job_id>
```

ATS form (field inventory + proposed plan, **no values**). Greenhouse,
Lever, and Ashby URLs all dispatch automatically:

```powershell
npm run ats:inspect -- --url https://boards.greenhouse.io/<board>/jobs/<id> --headed
npm run ats:inspect -- --url https://jobs.lever.co/<company>/<posting-uuid>/apply
npm run ats:inspect -- --url https://jobs.ashbyhq.com/<org>/<job-uuid>/application
```

Expected (greenhouse): report with `identity_verification.passed: true`, a
`proposed_fill_plan`, and `captcha_detected: false` on a normal board page
(dormant CAPTCHA assets are listed under `dormant_markers` and never abort).
Lever/Ashby run the shared read-only inspector on the rendered DOM (no
identity verification exists for them — see
`docs/ats-adapters-lever-ashby.md`) and write an
`artifacts/ats-inspect/<ats>-live/` report. Store the employer URL for the
pipeline while you're at it (any supported ATS URL is accepted and
normalized):

```powershell
npm run run -- --pipeline --app <application_uuid> --url <ATS_APPLICATION_URL>
```

**Failure modes:** `GREENHOUSE_APPLICATION_UNAVAILABLE` = employer redirect
off Greenhouse (posting gone); `LOGIN_WALL`/`CAPTCHA` = park it, human
gate; unsafe flags error = your shell has fill flags on — this step wants
the safe env.

## 4. Materials

Live resume generation was descoped — you keep 4–5 pre-written domain
resumes and register the right one per application:

```powershell
npm run materials:register -- --application <uuid> --file private\candidate\resumes\swe.pdf --label swe
```

Expected: JSON with `sha256` and a path under `artifacts/`; the same
verified persistence (magic bytes, size, atomic write, re-verify) as every
material. Re-registering replaces the single resume slot.

**Failure modes:** `Missing %PDF-` = not a real PDF (export, don't rename);
`Unknown application` = run discovery first. Level: `UNIT_CONFIRMED`.

## 5. Fill

Plan first, always — read what would be typed before enabling mutation:

```powershell
npm run ats:fill -- --url $ATS_URL                     # plan only, safe env — greenhouse|lever|ashby
```

Then deliberately:

```powershell
$env:FORM_FILL_ENABLED="true"; $env:DRY_RUN="false"; $env:SUBMIT_ENABLED="false"
npm run ats:fill -- --url $ATS_URL --execute --headed --resume private\candidate\resumes\swe.pdf
```

Expected: `verify.passed: true` with per-field read-back results, and
`submit_attempted: false` — this command has no submit path at all. Essays
and demographics are skipped by policy; sponsorship is never invented.

**Failure modes:** refusal naming a flag = working as designed; a failed
`verify` on specific fields = custom widgets; `validation_level` stays
`UNVERIFIED` and nothing downstream will submit it.

**Selector healing (automatic):** when read-back fails on a field, a
deterministic heal pass rescans the page by label evidence and retries once
— the report's `heal` block shows what recovered. With
`AGENT_FALLBACK_ENABLED=true` a failed heuristic additionally consults the
sidecar (`locate_field`, HTML-based, budgeted); candidates are still
retried and re-verified deterministically. Values always come from the
approved plan — healing relocates fields, never chooses answers.

## 6. Essays

If inspection flagged essay questions the application parks in
`ESSAY_REQUIRED` with an `ESSAY` review item listing every question.

```powershell
npm run resume:essay                      # list what needs writing
# write your answer into a text file, then per field:
npm run resume:essay -- --application <uuid> --field <field_id> --file C:\essays\why-acme.txt
```

Expected: after the last required field, `review_resolved: true` and state
`FIELD_VERIFICATION`. Your text is stored with `source='human'` and
re-checked from the database at fill time — machine-written essay text is
structurally rejected, not just discouraged.

**Failure modes:** `Refusing to save an empty essay answer`;
`unanswered_fields` in the output tells you what's left.

## 7. Submit

The policy line here is *gated*, not casual. Three flags **and** a
confirmation:

```powershell
$env:FORM_FILL_ENABLED="true"; $env:DRY_RUN="false"; $env:SUBMIT_ENABLED="true"
npm run submit -- --application <uuid> --headed
```

What happens, in order: prior-submission guard → registered-resume check →
lease → PENDING submissions row → per-ATS page gate (greenhouse: full
identity verification incl. job-id match; lever/ashby: trusted host +
login wall + CAPTCHA + form-present — deliberately weaker, see
`docs/ats-adapters-lever-ashby.md`) → fill + essays + upload + read-back
verification (**must** pass or it refuses to click) → the confirmation
prompt naming company, role, URL, attempt, resume sha256, and plan counts →
one click → deterministic receipt verification (explicit confirmation text
+ screenshot).

Lever/Ashby differences: essay answers on file for those ATSes fail closed
BEFORE any page mutation (`FAILED_BEFORE_CLICK` + MANUAL review item — the
essay filler isn't wired for them yet), and the selector healer is
greenhouse-only.

Expected outcomes:

| Outcome | Meaning | Exit |
| --- | --- | --- |
| `SUBMITTED_VERIFIED` | Receipt captured; state `SUBMITTED`; resubmission now impossible | 0 |
| `UNCERTAIN` | Clicked but unverifiable; review item; auto-resubmit blocked | 3 |
| `FAILED_BEFORE_CLICK` | Refused before clicking; state `FAILED_RETRYABLE` | 1 |
| `REFUSED` | A guard fired; nothing happened | 1 |

Receipts land in `artifacts/applications/<uuid>/submission/`.

`--yes` is honored **only** when `SUBMIT_REQUIRES_LOCAL_CONFIRMATION=false`;
it cannot bypass the interactive prompt. Unattended submission additionally
requires `MAX_UNATTENDED_SUBMISSIONS_PER_RUN > 0` — the cap is persisted per
run in SQLite, and 0 (default) always refuses.

Level: `FIXTURE_CONFIRMED` (fill+submit+receipt against the confirmation
fixture). Live submission is yours to run — start with the sandbox board in
[current-state-and-phase56.md](./current-state-and-phase56.md) §4.2.

## 8. Review

```powershell
npm run review                            # all open items
```

Uncertain submission — check your email / the board first, then:

```powershell
npm run review:resolve -- --id <item_id> --outcome submitted        # receipt exists
npm run review:resolve -- --id <item_id> --outcome not-submitted --requeue  # nothing went through
```

`submitted` marks the row VERIFIED and moves to `SUBMITTED`;
`not-submitted --requeue` fails the attempt's idempotency key and re-queues.
Nothing automatic ever resolves an uncertain submission.

## 9. Contacts and personas

Contacts (after a verified submission):

```powershell
npm run contacts:extract -- --application <uuid> --headed
```

Expected: contact rows with `source_category` (`school` = alum → alum
subject line later). Zero contacts is valid and completes the application.
**Caveat:** contact selectors are built from a synthetic fixture and are
live-`UNVERIFIED` — if extraction finds nothing on a page that clearly shows
contacts, capture it with the recorder and promote real selectors.

Personas — the only legal source of project claims in outreach:

```powershell
copy private\candidate\personas\default.example.json private\candidate\personas\default.json
# edit: put your REAL projects in (name, summary, tools, relevance_tags)
```

Add more personas (`ml.json`, `quant.json`, …) as you learn which domains
you email most; pick one per generation with `--persona <id>`.

## 10. Email generation

The **only** LLM boundary in this codebase. It is a spend surface, so it is
fail-closed:

```powershell
# .env:  EMAIL_GENERATION_ENABLED=true, OPENAI_API_KEY=sk-…, EMAIL_LLM_MODEL=<confirm current model id>
npm run email:generate -- --application <uuid> --persona swe
```

What the model gets: your template (`prompts/outreach-email.v1.md`), the
persona JSON, and the contact/job context. What it cannot do: every rule is
deterministically re-checked after generation — subject variant must match
alum status (`Hopkins student…` for school contacts, `JHU undergrad…`
otherwise), the company must be in the subject, every project bullet must
name a real persona project that appears in the body, no referral claims,
no school ties for non-alums, greeting and signature present. Any violation
→ `REJECTED`: row recorded, review item opened, **no draft possible**, exit 3.

Expected: `validation_status: "VALIDATED"` with the full email printed for
your inspection, state `EMAIL_GENERATED`.

**Failure modes:** flag/key refusals name what's missing; persona missing →
copy the example first; repeated `REJECTED` for the same rule usually means
the persona projects don't fit the contact — improve the persona, not the
validator.

## 11. Outlook drafts

Nothing in this repo can dispatch mail — banned identifiers are enforced by
`npm run check:forbidden` over code *and* docs. Drafts only:

```powershell
$env:OUTLOOK_DRAFTS_ENABLED="true"; $env:DRY_RUN="false"
npm run draft:create -- --application <uuid> --contact <contact_id> --headed
npm run draft:verify -- --draft <draft_id> --headed
```

Expected: `status: "SAVED"`, then `verified: true` after re-opening the
Drafts folder and matching subject/recipient (+ body-hash comparison).
**The Drafts folder is the review surface**: read the email there, edit it,
or delete it — sending is your manual decision in Outlook, never the tool's.

**Failure modes:** contact without an email address can't be drafted
(connect on the platform instead); duplicate recipient per application is
refused by a unique index; Outlook's DOM churns — if compose selectors
miss, run `--headed`, fix `src/outlook/selectors.ts`, and rely on
`draft:verify` as the acceptance check. Level: composer/gates
`UNIT_CONFIRMED`; live Outlook flow `UNVERIFIED`.

## 12. Dashboard

```powershell
npm run dashboard        # → http://127.0.0.1:8788/
```

Read-only over SQLite: summary, applications (filter `?state=`), review
items, submissions, drafts. Binds 127.0.0.1 only (config rejects anything
else); every non-GET method is 405 — mutation routes don't exist.

## 13. Pipeline

The sequential driver that chains §3–§7 with all the same gates:

```powershell
npm run run -- --pipeline --app <uuid> --headed              # advances until a gate/review
npm run run -- --pipeline --app <uuid> --headed --submit     # includes gated submission
npm run retry                                                # FAILED_RETRYABLE → QUEUED (cap 3)
```

It stops — with a review item where human input is what unblocks — on:
missing resume, missing employer URL, unsupported ATS, CAPTCHA, login wall,
essays, failed fill verification, and **always** at `READY_TO_SUBMIT`
unless you passed `--submit` (which still runs the §7 confirmation).
Anything with an open review item is yours until resolved.

## 14. Agent authoring

Phase 6 J1: a browser-use sidecar that reads an application page through
your debug Chrome and proposes selector candidates for **you** to review —
it never fills, never submits, never touches application state.

One-time (deliberate — it is inert until you do this):

```powershell
cd agent
python -m venv .venv
.venv\Scripts\pip install -e .        # pins browser-use==0.13.7
cd ..
```

Run:

```powershell
npm run chrome:debug:jobright          # sidecar attaches to this Chrome
$env:AGENT_AUTHORING_ENABLED="true"
npm run agent:author -- --url $GREENHOUSE_URL
```

Expected: `status: "ok"` and a candidate map under
`artifacts/agent-authoring/<runId>/candidate-map.json` marked "Human review
required". Promote what you accept into fixtures deliberately — raw agent
output never becomes runtime selectors.

**Failure modes:** flag refusal (by design); `browser-use not installed` =
skip the venv step above; malformed sidecar output is rejected by the zod
contract rather than trusted.

---

## Flag reference

| Flag | Default | Gates |
| --- | --- | --- |
| `DRY_RUN` | `true` | Every mutation (fill, submit, resume download, drafts) |
| `FORM_FILL_ENABLED` | `false` | Fill + submit |
| `SUBMIT_ENABLED` | `false` | Submit only |
| `SUBMIT_REQUIRES_LOCAL_CONFIRMATION` | `true` | Per-submission human prompt |
| `MAX_UNATTENDED_SUBMISSIONS_PER_RUN` | `0` | Unattended cap (0 = never) |
| `MATERIALS_DOWNLOAD_ENABLED` | `false` | Descoped live resume generation |
| `EMAIL_GENERATION_ENABLED` | `false` | The LLM spend surface |
| `OUTLOOK_DRAFTS_ENABLED` | `false` | Draft creation |
| `AGENT_AUTHORING_ENABLED` | `false` | Phase 6 J1 sidecar |
| `AGENT_FALLBACK_ENABLED` | `false` | Sidecar escalation in the fill healer (6a′) + nav agent phase |
| `NAVIGATION_ENABLED` | `false` | Navigation: clicking Apply on JobRight (mutates applied-state) |
| `GMAIL_VERIFICATION_ENABLED` | `false` | Gmail readonly OTP/magic-link retrieval during nav |

The banned send-style APIs have no flag — they are impossible, enforced by
`npm run check:forbidden` (Outlook send identifiers AND Gmail
send/modify/compose identifiers).

## 15. Navigation (autonomous employer-URL resolution)

`APPLICATION_OPENING` can resolve the employer application URL itself
instead of dead-ending on a MANUAL review item. Three phases, each gated:

1. **Deterministic (`NAVIGATION_ENABLED=true`)** — open the JobRight job
   page, read external apply hrefs (zero mutation), else click the
   standard Apply control and capture the popup/same-tab URL (2-click
   cap). A captured URL that lands on a login wall is never stored — it
   becomes the agent's starting point.
2. **Agent (`+ AGENT_FALLBACK_ENABLED=true` + debug Chrome running)** —
   browser-use sidecar attached to your CDP Chrome
   (`npm run chrome:debug:jobright`). Hard rules: never fills application
   fields, never clicks submit, stays on allowed domains, stops on
   captcha/phone walls. Account walls use the vault
   (`private/ats-accounts/`, created on demand); caps: 3 spawns × 25
   steps × 180s, 8-minute total.
3. **Gmail micro-turn (`+ GMAIL_VERIFICATION_ENABLED=true`)** — when a
   site emails a verification code/link, the orchestrator polls your
   mailbox readonly (10 × 6s), parses deterministically, and re-invokes
   the agent with the code. One-time setup:

```powershell
npm run gmail:auth -- --email <mailbox> --client-id <id> --client-secret <secret>
$env:GMAIL_VERIFICATION_ENABLED = "true"   # gmail:check reads the mailbox, so the flag gates it too
npm run gmail:check       # read-only smoke
Remove-Item Env:GMAIL_VERIFICATION_ENABLED
```

(Desktop-app OAuth client, scope `gmail.readonly` only — a token carrying
any wider scope is refused before it is stored.)

Run it standalone or let the pipeline call it:

```powershell
npm run nav:resolve -- --app <application_uuid>
npm run run -- --pipeline --app <application_uuid>
```

Walls route to existing states: employer login/phone → MANUAL review;
captcha → `CAPTCHA_REQUIRED`; budget → `FAILED_RETRYABLE`; JobRight auth
loss → `AUTH_REQUIRED` (re-login and retry). Artifacts under
`artifacts/navigation/<runId>/` never contain credentials, codes, or
magic-link URLs. When nav ran in your CDP Chrome, inspection and fill
re-attach to the same Chrome so employer cookies survive
(`nav_session: cdp` on the job row); unreachable CDP falls back to the
ephemeral browser.

Level: everything here ships `UNIT_CONFIRMED`/`FIXTURE_CONFIRMED` (fake
sidecars, routed fixtures, injected fetch). The first live nav run is
yours — success is only claimed from the deterministic read-back (URL
stored + ATS validation), never from the agent's self-report.
