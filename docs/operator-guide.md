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
3. [Inspect (JobRight detail + ATS form: greenhouse/lever/ashby/workable)](#3-inspect)
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
15. [Navigation (autonomous employer-URL resolution)](#15-navigation)
16. [Operator console (web UI)](#16-operator-console-web-ui)
17. [When Submit stays greyed out](#17-when-submit-stays-greyed-out)
18. [L3 — armed unattended sessions (contract)](#18-l3--armed-unattended-sessions-contract)
19. [Hands-off schedule (auto:cycle)](#19-hands-off-schedule-autocycle)

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

**By default the pipeline does not park for essays** (`ESSAY_REQUIRED_GATE_ENABLED=false`).
Heuristics still classify fields for the proposed plan (textareas never auto-fill),
but EEO/combobox false positives must not block fill. Set
`ESSAY_REQUIRED_GATE_ENABLED=true` only for the human `resume-essay` workflow.

If the gate is on and inspection flagged essay questions, the application parks in
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

An LLM boundary (shared client: Anthropic preferred, OpenAI fallback). It
is a spend surface, so it is fail-closed:

```powershell
# .env:  EMAIL_GENERATION_ENABLED=true, plus an LLM key — ANTHROPIC_API_KEY=sk-ant-… (preferred;
#         model via ANTHROPIC_LLM_MODEL, default claude-opus-5) or OPENAI_API_KEY=sk-… (EMAIL_LLM_MODEL)
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
| `GMAIL_VERIFICATION_ENABLED` | `false` | Gmail verification retrieval during nav — browser mailbox scan primary (no token); REST only if a token exists |
| `ESSAY_REQUIRED_GATE_ENABLED` | `false` | Hard-stop on heuristic essay detection (`ESSAY_REQUIRED`); off until heuristics are better |
| `OUTLOOK_VERIFICATION_ENABLED` | `false` | Read-only Outlook mailbox scan for submit verification codes (§17) |

Console-only (not capability flags): `CONSOLE_HOST` (`127.0.0.1`,
validated) and `CONSOLE_PORT` (`8899`). The console's own shell is the
ceiling for every flag above — see §16.

The banned send-style APIs have no flag — they are impossible, enforced by
`npm run check:forbidden` (Outlook send identifiers AND Gmail
send/modify/compose identifiers).

## 14a. Answering everything (the autonomy unblockers)

Measured across the live fill reports, the things stopping applications
were not the safety gates — they were three plumbing failures that sent
answers you already had to a human.

**Advisory notes no longer freeze an application.** The pipeline halts on
any open review item, which is right for "sign in" or "solve the captcha"
and wrong for "we could not map one dropdown". One Lever form produced 20
of the latter. Field-level notes (`Answer needed:`, `New question
learned:`, `Submit selector proposal`) are now advisory: they stay in the
queue, but the application keeps going and the submit-side completeness
scan still refuses anything genuinely incomplete.

**A held answer is now placed onto the page's options** when the literal
matcher can't (`SCREENER_LLM_MATCH_ENABLED` — the same flag as label
mapping). "JobRight" against 13 options, "Remote" against Yes/No. The
model may only CHOOSE from the page's own list and its choice is checked
verbatim before filling; it can never author a value, and abstention parks
exactly as before.

**Healing is on for every ATS.** It was Greenhouse-only, so on Lever,
Ashby, Workable and Workday a single read-back miss was terminal. The
healer's locator is vendor-free label similarity that re-verifies
deterministically.

**Machine-named fields get a real question.** `cards[<uuid>][field0]`,
`Type your response`, `field_33` are recognised as non-questions and
resolved from the nearest legend/heading instead of being skipped as
unmapped.

**Budget walls are visible.** A navigation budget wall used to set
`FAILED_RETRYABLE` and leave nothing in the queue; 21 accumulated unnoticed.
It now writes an advisory note (so it is countable without freezing anything).

**`agent_unavailable` is not a budget wall.** If the deterministic phases do
not resolve and the agent phase cannot start, the report says
`wall: "agent_unavailable"` — nothing was spent, nothing was tried. The trace
names the cause, usually `CDP Chrome unreachable at http://127.0.0.1:9222`.
Fix it by starting Chrome with `--remote-debugging-port=9222` before the run,
or by granting `CDP_AUTOLAUNCH_ENABLED` to the session. Until then every app
the deterministic phases miss ends here, and none of them are retryable by
waiting.

**JobRight's Apply tab opens blank.** The autofill CTA opens an empty tab and
assigns its location afterwards — often only once the customize-resume
interstitial is answered. Navigation now waits for that tab to leave
`about:blank` before reading it, and leaves an unread tab OPEN rather than
closing the only link to the posting.

### EEO / demographics

These already fill — from your own encrypted sensitive profile, and from
nothing else. If they are being skipped, one of three things is true:

1. no sensitive profile on disk (`npm run cli -- candidate:encrypt-sensitive`),
2. the field carries no canonical mapping, or
3. the value for that canonical key is empty.

The rule that never changes: a demographic answer is never inferred,
defaulted, or generated. No value on file ⇒ the field is left blank.

### Essays (`ESSAY_AUTOFILL_ENABLED`)

```ini
ESSAY_AUTOFILL_ENABLED=true
```

Generates essay answers from `private/candidate/about-me.md` and fills
them, instead of routing every essay to you. Requires that file to exist
and an LLM key. Generated text must pass the same validation a review
draft does (length bounds, no placeholder brackets, no model
self-reference), and each answer is recorded on its plan entry, so the run
artifact shows exactly what an employer received.

**Worth knowing once:** essay prose is the part a human reads, and unlike
a dropdown it cannot be verified by read-back. A model writing from your
about-me can still phrase a claim more strongly than the source supports.
Check the first few in the artifacts. Off, or context missing, or the
draft rejected ⇒ the essay routes to review exactly as before.

## 14b. Company-hosted forms (`GENERIC_ATS_ENABLED`)

Most employers do not use Greenhouse, Lever, Ashby, Workable or Workday.
In the live corpus, 10 of 41 resolved URLs had no supported ATS — and every
one was a **different** host (tesla.com, careers.ibm.com, jobs.gusto.com,
jobs.jobvite.com, citadel.com, ycombinator.com). Adding vendors one at a
time never catches up with a tail like that, so those applications used to
dead-end at `UNSUPPORTED_ATS`.

```ini
GENERIC_ATS_ENABLED=true
```

With it on, a company-hosted form is filled, verified, resume-uploaded and
submitted through **the same path as any vendor** — same approved plan,
same completeness scan, same submit gates.

**Trust comes from provenance, not from a host allowlist.** The URL was
resolved from a JobRight posting you queued and passed the employer
congruence check, so there is no second allowlist to maintain. Two things
still refuse: non-https, and jobright.ai itself. A URL on a *vendor's* host
that the vendor's own validator rejected stays rejected — it is never
downgraded to heuristics.

**What is different from a vendor adapter, honestly:**

- **Confirmation is stricter, not looser.** A vendor proves "submitted" with
  a product DOM marker. Here, confirmation requires the confirmation text
  *and* the form's fields to be structurally gone (a fingerprint taken
  immediately before the click). A page still showing the same inputs is
  never confirmed, whatever the footer says. Ambiguity routes to the
  existing uncertain-submission review item, exactly as on Lever.
- **No essay fill.** Essay execution is Greenhouse-bound, so an application
  carrying essay answers is refused before the submit gate rather than
  submitted incomplete.
- **No form reset.** Reload the page to start over.

Turn it off and every generic host reverts to `UNSUPPORTED_ATS`; nothing
else changes.

## 15. Navigation (autonomous employer-URL resolution)

`APPLICATION_OPENING` can resolve the employer application URL itself
instead of dead-ending on a MANUAL review item. Three phases, each gated:

1. **Deterministic (`NAVIGATION_ENABLED=true`)** — open the JobRight job
   page, read external apply hrefs (zero mutation), else click the
   standard Apply control and capture the popup/same-tab URL (2-click
   cap). JobRight's "Customize Your Resume" modal is skipped immediately
   via **Apply Without Customizing** (never Fix My Resume, never the X).
   A captured URL that lands on a login wall is never stored — it
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

**Employer congruence gate.** Every candidate URL — anchor, click
capture, or agent answer — must belong to the job's own company before it
is stored: the org slug embedded in every supported-ATS URL is checked
against the company name (tokens, initials, parenthetical aliases). A
wrong-employer answer from the agent gets one corrective retry (the goal
names the company explicitly), then parks as a `mismatch` wall with a
review item naming both companies. A URL already held by another live
application parks as `duplicate_url` naming the sibling. This exists
because a live session returned one company's application page for three
unrelated jobs — host-only acceptance let it through. Armed sessions also
run an **employer-URL audit** at start: pre-submit apps holding a
wrong-company URL are repaired automatically (URL cleared, app
re-navigates); anything past submit parks for you.

Walls route to existing states: employer login/phone → MANUAL review;
captcha → `CAPTCHA_REQUIRED`; budget → `FAILED_RETRYABLE`; wrong-employer
`mismatch` and `duplicate_url` → `FAILED_RETRYABLE` with a named review
item; JobRight auth loss → `AUTH_REQUIRED` (re-login and retry). Artifacts under
`artifacts/navigation/<runId>/` never contain credentials, codes, or
magic-link URLs. When nav ran in your CDP Chrome, inspection and fill
re-attach to the same Chrome so employer cookies survive
(`nav_session: cdp` on the job row); unreachable CDP falls back to the
ephemeral browser.

Level: everything here ships `UNIT_CONFIRMED`/`FIXTURE_CONFIRMED` (fake
sidecars, routed fixtures, injected fetch). The first live nav run is
yours — success is only claimed from the deterministic read-back (URL
stored + ATS validation), never from the agent's self-report.

---

## 16. Operator console (web UI)

A local web console for everything above: browse applications and their
timelines, resolve review items, launch pipeline/nav/submit runs with live
output, and confirm submissions in the browser instead of the terminal.

The console opens on **Home** — the non-technical front door. One button
("Start applying") arms a default two-hour session and launches the
worker; while running, the same card shows time left, applications
worked, and submissions in plain words, plus a Stop button. Below it,
**Needs you** turns every open review item into a to-do in normal
language ("Answer 1 written question — Cohere — a draft is ready for
you"), each linking straight to the application. Submitted applications
and a setup checklist (JobRight login, Outlook, applying on/off) fill the
rest of the page. The sidebar shows only Home / Needs you / Applications
/ Settings; Overview, Runs, Enqueue, and Fill outcomes — the
operator-grade pages, unchanged — live under a collapsed **advanced**
group. Custom session limits (duration/caps, arm-only) remain on
Overview's arm card.

```powershell
npm run frontend:install     # once
npm run frontend:build       # after any frontend change
npm run console
```

The console prints a URL with a `#token=` fragment — **open that exact
URL**. The fragment never reaches the server (so it cannot appear in logs);
the page stores it for the tab and strips it from the address bar. A fresh
tab without it can still read, but every mutation returns 401 until you
paste the token into Settings.

Two security properties hold on every request: the server binds
`127.0.0.1` only (`CONSOLE_HOST` is validated like `DASHBOARD_HOST`), and a
`Host` header naming anything but localhost is refused 403 — that is what
stops a hostile page in your browser from reaching the API by DNS
rebinding.

The read-only dashboard (§12) is unchanged and still GET-only. The console
is a separate server; run either or both.

### The capability ceiling

**The shell that starts the console decides what any run can do.** The UI
can only narrow that, never widen it — a flag reaches a child run only if
the shell had it *and* you opt into it in the launch dialog. Start the
console with exactly the capability you intend to use that session:

```powershell
# read-only session (browse, resolve reviews, enqueue)
npm run console

# a session that may fill and submit
$env:FORM_FILL_ENABLED="true"; $env:DRY_RUN="false"; $env:SUBMIT_ENABLED="true"
npm run console
```

Settings shows the live ceiling. Two values are **forced** on every
console-launched run regardless of your shell:
`SUBMIT_REQUIRES_LOCAL_CONFIRMATION=true` and
`MAX_UNATTENDED_SUBMISSIONS_PER_RUN=0` — the unattended submit branch is
unreachable from the console, so a click always requires your explicit
confirmation.

### Runs

Runs execute as child processes (`src/console/runner.ts`), one at a time.
They call the same functions the CLI calls, so a console run and a CLI run
do the same thing; the console adds a live log stream (SSE, falling back to
polling), the flags the child actually received, cancel, and a persisted
history under `artifacts/console/runs/<id>/`.

### Submitting from the browser

When a submit run reaches the confirmation point, the terminal prompt is
replaced by a modal showing the same facts it printed — company, role, URL,
attempt, resume sha256, plan counts. Type the company name to arm the
button. Everything else about submission is unchanged: same env triple,
same approved-plan policy, same pre-click verification, same single click.

It fails closed in every direction: no answer within five minutes, a closed
tab, a dropped stream, or a stopped console all count as *declined*, and a
decline refuses before the `SUBMITTING` transition, so the application stays
`READY_TO_SUBMIT` and can be retried.

### Review queue

Every review kind is resolvable here, including the ones with no CLI
resolver: uncertain submissions (submitted / nothing-was-submitted, with
optional requeue), essay answers (typed by you — never machine-written),
requeue after clearing an auth or captcha wall, requeue an unsupported-ATS
item with a corrected employer URL, abandon, and dismiss. The server
re-checks the kind/action matrix and the application's current state, so a
stale page cannot force an illegal transition — if the application has
moved on, the item resolves without a transition and the response says so.

### Gmail setup

Settings drives the same one-time OAuth flow as `npm run gmail:auth`: start
it, open the consent URL, paste the localhost URL you land on. Scope is
pinned to `gmail.readonly`, and a grant carrying anything wider is refused
before it is stored. `gmail:check` needs `GMAIL_VERIFICATION_ENABLED` in
the console's own shell (it runs in-process).

### Dev mode

```powershell
npm run console        # API on 8899
npm run frontend:dev   # vite on 5173, proxying /api
```

Paste the token into Settings in dev mode — the `#token=` URL points at
8899.

Level: the server, run protocol, flag ceiling, and confirmation transport
are `UNIT_CONFIRMED`; the review resolvers and submit seam are
`FIXTURE_CONFIRMED`. **The browser UI itself is `UNVERIFIED`** — it builds
and serves, but no page has been exercised in a real browser. Your first
session is the promotion event.

## 17. When Submit stays greyed out

Some employers gate the submit button behind an emailed verification code.
The form still looks normal, so the login-wall detector does not fire and
field verification passes (the code input is not in the approved plan) —
the only symptom is a disabled button.

The submit path now diagnoses that before giving up, and the refusal names
the cause: a verification prompt (with the address it was sent to), the
required fields that are still invalid, or the visible validation errors.

To let it recover automatically, enable a mailbox reader in the shell:

```powershell
$env:OUTLOOK_VERIFICATION_ENABLED="true"   # reads your Outlook web session
# or
$env:GMAIL_VERIFICATION_ENABLED="true"     # browser mailbox scan (no token needed); REST only if gmail:auth token exists
```

The run then fetches the code, types it in, waits for the button to enable,
and clicks once. Codes are transient: held in memory, typed once, never
written to SQLite, artifacts, or logs. With no reader enabled the run fails
before the click and opens an `AUTH_REQUIRED` review item naming the wall.

Both readers are read-only. The Outlook path navigates and reads DOM in
your existing session — compose and send remain banned by
`src/outlook/sendGuards.ts` and the forbidden-identifier check.

Level: `FIXTURE_CONFIRMED` against a fixture form that disables Submit
until a six-digit code is entered. The Outlook mailbox selectors are
synthetic and `UNVERIFIED` against a real inbox; the Gmail path reuses the
parser already used by navigation.

## 17b. Stage-1 self-improvement loop

The analyze→fix→PR cycle that has driven this repo's recent fixes, with the
human courier steps removed. Three pieces:

1. **Artifact autopush** (`ARTIFACT_AUTOPUSH_ENABLED=true`): after an armed
   session ends, the worker commits `artifacts/` and pushes to the current
   branch. Only `artifacts/` is ever staged — pre-staged code changes are
   set aside, never swept along — and the pre-commit secret gate runs
   normally (`--no-verify` is never used; a hook refusal aborts the push
   loudly). Session reports gain `artifact_autopush`.
2. **`/improve`** (`.claude/commands/improve.md`): one bounded improvement
   cycle for any Claude agent — analyze the newest run artifacts, score the
   previous cycle's prediction, fix at most three things with regression
   tests, run the full gate, open a PR whose body states a falsifiable
   prediction for the next session. A protected-paths list (guards, secret
   checks, house rules) is off-limits to the loop by construction.
3. **Standing wake**: a scheduled Claude session polls master for new
   artifact pushes and runs `/improve` when it finds them.

You keep exactly two touches per cycle: **merge the PR** and **arm the next
session**. Arming stays human by contract; nothing in this loop can widen a
capability, weaken a gate, or submit anything.

## 18. L3 — armed unattended sessions (contract)

L3 lets the console click Submit **without a per-application confirmation**,
but only inside a **timed, capped, operator-armed session**. This section
is the contract; §18.1 below is the runbook.

**Arming.** From the console you arm a session: a duration (clamped 15–240
minutes, default 120) and caps — max submits (default 10) and max apps
attempted (default 25). Arming is bearer-token-gated like every console
mutation. The armed session is a single `automation_runs` row (stage
`l3_session`); its unattended-submission budget is that row's persisted,
atomically-consumed counter, so **disarming makes further submission
structurally impossible** and a crash cannot reset the count.

**Disarm is the default.** A console **restart is always disarmed** (stale
sessions are swept on boot), the session **auto-disarms at its expiry**, and
you can disarm at any time. Only one session may be armed at once — arming
while armed is refused; disarm first.

**What arming does and does not change.** Arming removes exactly one thing:
the human-confirmation *transport* for submits made by the armed worker.
Every other gate is unchanged — the env triple (`FORM_FILL_ENABLED`,
`SUBMIT_ENABLED`, `DRY_RUN=false`), the prior-submission check, the ATS page
identity gate, the approved-plan policy (essays and demographics are still
never auto-filled), and the pre-click fill/upload/verify check all still
run. Nothing is force-clicked.

**Walls still park, the queue still moves.** CAPTCHA, phone OTP,
unrecoverable auth, unsupported ATS, and missing materials park the
application (review item) and the session moves to the next one — exactly as
today, just unattended.

**Outreach stays drafts-only.** Nothing in L3 sends mail. Contacts
extraction, email *generation*, and Outlook *draft* creation may run after a
verified submit when their flags are set, and never send — the send bans in
`src/outlook/sendGuards.ts` and the forbidden-identifier check are untouched.

**Kill switch.** `AUTOMATION_ENABLED=false` (fail-closed, default) refuses
the automation worker regardless of any arm.

Hard-stop codes that park an app and continue the queue: `CAPTCHA_REQUIRED`,
`AUTH_REQUIRED` (non-OTP / no mailbox recovery), phone OTP, `UNSUPPORTED_ATS`,
missing materials, and budget/attempt exhaustion.

### 18.1 Runbook

**Prerequisites (before the first armed session):**

1. **JobRight session** ready (`npm run auth:login -- --service jobright`;
   the Overview "Session readiness" card must show jobright ready) — needed
   for discovery and contacts extraction.
2. **Default resume** uploaded (Settings → "Upload default resume", or place
   the PDF at `DEFAULT_RESUME_PATH`). Apps without a registered resume
   auto-attach this; if it is missing they park at materials review.
3. **Gmail verification** authorized (`npm run gmail:auth`) if you want the
   worker to recover ATS email-verification codes unattended
   (`GMAIL_VERIFICATION_ENABLED`).
4. Start the console from a shell that carries the capabilities you intend
   to grant — at minimum `AUTOMATION_ENABLED=true FORM_FILL_ENABLED=true
   SUBMIT_ENABLED=true DRY_RUN=false` plus whatever else you want in the
   ceiling (navigation, native autofill, materials download, gmail
   verification; email generation + outlook drafts for the outreach tail).
   The shell is the ceiling: anything not exported there can never reach a
   child run, whatever the UI asks for.

**Starting a session:** on Overview, set duration/caps on the arm card and
press **Start L3 session** (arm + launch in one action), or **Arm only** and
launch the `automation` kind from Runs yourself. The worker discovers (per
the arm's `discover_max`/`rediscover_every`), then walks the queue oldest
first, skipping apps with open review items and apps you've excluded
(Applications → include/exclude toggle).

**Watch the first hour.** Keep the run view (SSE) open for the first armed
session: confirm the first unattended submit looks right in the ATS tab, the
arm card counters climb (`submits x/y`, `apps x/y`), and walls park with
review items instead of retrying. The first verified live submit is what
promotes this path to `LIVE_MUTATION_CONFIRMED` — treat everything before
that as unverified.

**While armed you can always:**
- **Disarm** (arm card) — soft stop: the in-flight app finishes, nothing
  else starts, and the budget can never be consumed again.
- **Cancel the run** (run view) — SIGTERM the worker child; the arm stays
  armed until you disarm or it expires.
- **Kill switch**: unset/`false` `AUTOMATION_ENABLED` in the console shell
  and restart the console — restart also always disarms.

**After the session:** the run report lists per-app outcomes
(`per_app[].end_state` / `stopped` / `submitted`), discovery runs, outreach
tail counts (`emails_generated`, `drafts_saved`), and why the session
stopped (`disarmed` / `expired` / `apps_cap` / `queue_drained`). Leftover
apps sit at `READY_TO_SUBMIT` (budget spent) or in review (walls). Review
items are the worklist; Outlook Drafts is the outreach review surface —
nothing has been sent.

**Where the evidence lives.** "What did automation just do?" →
`artifacts/console/runs/<newest>/logs.jsonl` (the worker and pipeline log
every step, stop, and error there). "Did this app actually submit?" →
`artifacts/applications/<uuid>/submission/` (report + screenshot) plus the
SQLite state — never the console terminal alone. A submit that failed to
find its control now writes a CTA inventory into the submission report
notes, and a failed resume upload writes a file-input inventory into the
fill/submit evidence — a failure without its inventory is a bug.
Every navigation and submit attempt also lands as a SQLite telemetry row
(`navigation_attempts` / `submit_attempts`, joined to fill outcomes) —
`npm run training:export` dumps all three corpora as JSONL; see
`docs/telemetry-training.md` for the schema, the PII policy, and the
`*_rates` views to read first after a session.

**Screener answers.** `npm run screeners:init` creates
`private/candidate/screeners.json` — your verbatim answers to the common
"Additional Questions" (availability, education level, closest location,
how-did-you-hear, …). Matched questions fill from this bank (option
answers must literally match a page option or they park);
`SCREENER_LLM_MATCH_ENABLED` adds an LLM label→key mapping assist (labels
only — your answers never reach a model); `npm run screeners:suggest`
lists verified predictions ready to paste into the bank. Full set +
policies: `docs/screener-questions.md`.

**Blank fields ask you directly ("Answer needed").** Whenever a live fill
meets a question NOTHING could answer (no registry key, no custom entry,
no profile rule), Dispatch leaves the field blank on the form and
immediately opens an **Answer needed** to-do showing the company, the
exact question, and — for choice questions — the page's real options. It
appears near the top of the Home "Needs you" list and expands in place:
pick or type the answer, hit **Save answer**, and it joins
`screeners.json` as a `custom` entry keyed to that exact question — every
future form asking it fills deterministically with zero AI involvement.
No flag needed; this works even with all LLM features off.

**New-question predictions (one-click promote).** With
`SCREENER_PREDICT_LLM_ENABLED=true` (plus an LLM key), two things happen:

- **At fill time**, previously-unmapped screeners may be filled when the
  proposal survives `validatePrediction`: a choice must match the page's
  options verbatim; free-text must already appear in your about-me or
  public profile (12+ characters). Invented answers stay blank and still
  open **Answer needed**. Nothing is written into `screeners.json`.
- **After the session**, the same questions get a suggested answer in
  the review item (drawn from about-me + bank + profile facts). **Approve
  & save** (or edit first) joins the bank. A dismissed question never
  comes back.

Major-option checkboxes ("Electrical Engineering"), inspector
placeholders (`field_12`), UUID labels, and terms/privacy checkboxes are
not queued as questions — terms auto-check; majors check only when they
match your profile. Pronouns / EEO stay on the sensitive-profile path.

Long-form essays still need `ESSAY_AUTOFILL_ENABLED` (and
`private/candidate/about-me.md`) to fill rather than park.

**Essay drafts (automatic suggestions).** Copy `about-me.example.md` to
`private/candidate/about-me.md` and write your context once. With
`ESSAY_DRAFT_ENABLED=true`, **armed sessions draft automatically**: after
the session loop, every open essay question on the session's apps gets a
draft — grounded ONLY in your about-me + the posting, validated (length,
no placeholders), landing as UNVERIFIED suggestions inside the essay
review item and under `artifacts/applications/<id>/essays/`. The review
UI pre-fills the answer box with the draft; you edit-or-approve, and only
approved text ever fills. Manual per-app run:
`npm run essay:draft -- --application <uuid>`. Missing flag/key/about-me
degrades to a named note in the session report, never a failure.

**Pre-click completeness.** Immediately before any submit click, the page
is scanned for required-but-unanswered controls (native and ARIA widgets).
Any hit refuses BEFORE the click — no unattended budget spent — parks the
app `FAILED_RETRYABLE`, and the review item names every unanswered
question. Answer them via `screeners.json` / the essay workflow, then
requeue.

**Bulk review triage.** `npm run review:bulk -- --action dismiss|requeue-wall
[--kind KIND] [--limit N] [--apply]` — dry-run by default; `requeue-wall`
re-queues AUTH/CAPTCHA items after you cleared the wall by hand. Use this
when the queue clogs (the run data showed armed sessions draining after a
single pick because everything held an open item).

**Nav agent while armed.** The ArmCard shows `nav agent:
available/unavailable` before you arm. Available means the shell exported
`AGENT_FALLBACK_ENABLED=true` AND your CDP Chrome
(`chrome:debug:jobright`) is answering — armed navigation then runs the
agent phase on walls instead of parking them as `budget`. Leave that
Chrome open for the session's duration; without it, wall'd apps park
with the reason named in the trace.

**Escape hatch:** the CLI one-shot submit
(`npm run submit -- --application <id>` with `--yes` for unattended) is
unchanged and still available; the console one-shot submit keeps its
confirmation modal regardless of arm.

## 19. Hands-off schedule (auto:cycle)

For when you cannot be at this machine: one command runs an entire session
cycle — self-update from master, deterministic preflight, arm with the
standard caps, run the SAME autonomous worker the console button runs,
disarm, and let the post-session batches (essays, predictions, artifact
autopush) feed the improvement loop.

```powershell
npm run auto:cycle                       # one full cycle now
npm run auto:cycle -- --no-update        # skip the git pull (offline)
npm run auto:cycle -- --duration 60 --max-submits 5 --max-apps 10
```

### Standing live environment (set once, never again)

Every entry point (CLI, console, auto:cycle) loads a local `.env` at the
repo root via dotenv. Put the live-run flags there ONCE and stop exporting
them per shell — the file is gitignored and the pre-commit hook blocks it
from ever being committed. **This file IS the standing authorization**:
deleting it (or flipping `AUTOMATION_ENABLED=false` in it) is the kill
switch, exactly like the scheduled task itself.

```ini
# C:\dev\jobright-application-agent\.env   (gitignored — NEVER commit)
AUTOMATION_ENABLED=true
FORM_FILL_ENABLED=true
SUBMIT_ENABLED=true
DRY_RUN=false
NAVIGATION_ENABLED=true
NATIVE_AUTOFILL_ENABLED=true
GMAIL_VERIFICATION_ENABLED=true
AGENT_FALLBACK_ENABLED=true
CDP_AUTOLAUNCH_ENABLED=true
SCREENER_LLM_MATCH_ENABLED=true
SCREENER_PREDICT_LLM_ENABLED=true
ESSAY_DRAFT_ENABLED=true
ARTIFACT_AUTOPUSH_ENABLED=true
SUBMIT_REQUIRES_LOCAL_CONFIRMATION=false
MAX_UNATTENDED_SUBMISSIONS_PER_RUN=10
ANTHROPIC_API_KEY=sk-ant-...
# Your ONE portal login (see "Employer-portal logins" below)
PORTAL_LOGIN_EMAIL=you@example.com
PORTAL_LOGIN_PASSWORD=your-standing-portal-password
# Point this at your REAL resume — apps with no registered resume park
# here otherwise. auto:cycle preflight reports whether the file exists.
DEFAULT_RESUME_PATH=private/candidate/resumes/default.pdf
```

Code defaults stay fail-closed — a fresh clone without this file can
mutate nothing. Delete or rename the file any time you want a machine
that is read-only again.

### Debug Chrome starts itself

With `CDP_AUTOLAUNCH_ENABLED=true`, the cycle launches the debug Chrome
on its own whenever the CDP endpoint is down — same executable and same
persistent profile as `npm run chrome:debug:jobright`, so the
JobRight/Google logins you did once in that window survive every
relaunch. You only ever intervene if a session actually expires (the nav
reports will say so). The cycle report's `preflight.agent_leg` line tells
you the agent phase's exact status every run.

### Employer-portal logins — one email + password, set once

Employers (ByteDance careers, Workday tenants, …) gate applications behind
their own accounts. Put the ONE login you use everywhere in `.env` and
every portal wall is answered automatically — no per-site setup:

```ini
PORTAL_LOGIN_EMAIL=you@example.com
PORTAL_LOGIN_PASSWORD=your-standing-portal-password
```

Use the same mailbox the verification scanner reads (Gmail/Outlook), so
emailed codes and links land where Dispatch can find them. Setting these
authorizes portal sign-in on any **https** employer host the apply flow
reaches; jobright.ai is never credentialed (that's your own session), and
a real sign-in form must be on the page. Passwords stay out of logs,
artifacts, and SQLite; `.env` is gitignored and hook-enforced.

Rare exception — a portal forces its own password rotation:

```powershell
npm run cli -- accounts:set --host portal.example.com --email you@example.com --password "the-forced-one"
npm run cli -- accounts:list     # hosts + usernames only, never passwords
```

A stored per-host password overrides the standing one for that host only.
With no `PORTAL_LOGIN_PASSWORD` set at all, portal auth falls back to
vault-seeded hosts plus recognized Workday tenants and refuses everything
else (fail-closed by absence).

**What happens at a wall.** Navigation reads the wall's shape first
(`login_wall` in the nav report: which inputs exist, which submit control,
which federated buttons, whether a create-account route is offered, and
any error text), then:

1. cookie/consent banners are accepted so they can't swallow the click;
2. on Workday job postings it clicks **Apply**, then **Apply Manually**
   on the chooser (never Autofill with Resume). Create Account pages
   with standing credentials flip to **Sign In** first. Inspection does
   **not** park Sign In headers as `AUTH_REQUIRED` when
   `NAVIGATION_ENABLED` is on — fill owns that wall on every recognized
   ATS host (Greenhouse/Lever/Ashby included), not Workday only;
3. it **signs in** with the standing credentials;
4. only if the portal **rejects** those credentials *and* offers a
   create-account route does it follow that route and create the account
   with the same email + password (the Amazon case);
5. the mailbox is opened only when the page actually asks for a code or a
   confirmation link — never on spec.
6. required **terms / privacy / "I certify this is true"** checkboxes are
   auto-checked. Marketing opt-ins (`consent[marketing]`) and unlabeled
   checkboxes are not.

A wall that survives all of that parks the application as `wall: auth`
with the diagnosis in the report, so the next fix is driven by the real
DOM rather than a screenshot.

### Seeing what happened — `viz:timeline`

```powershell
npm run viz:timeline            # writes artifacts\console\run-timeline.html
npm run viz:timeline -- --limit 60
```

One self-contained page (no network, no DB, no browser — it only reads
`artifacts/`): the latest cycle's frame at the top, then one expandable
row per navigation run, colour-coded — green resolved, amber auth/CAPTCHA
wall, red unresolved, grey closed posting — each carrying its phase trace,
notes, and the hosts the agent visited. `auto:cycle` renders it at the end
of every run, so a pushed artifact bundle already contains the page.

### "skipped_already_armed" — and when a cycle sweeps it

An arm row is a budget ledger held by a live worker, not a lock. While a
session is genuinely running, the next scheduled cycle skips (correctly)
and now says who holds it: `arm 60a3693f, 15/25 apps, 24 min left`.

A killed session used to leave that row `RUNNING` forever, and every
later cycle skipped silently — on 2026-08-12 three consecutive firings
did nothing while the schedule looked healthy. The worker now writes a
heartbeat each iteration, and a cycle completes any arm that has gone
quiet for 15 minutes, logging it:

```
swept abandoned arm 60a3693f — no worker heartbeat for 34 min (a killed session left it RUNNING)
```

Sweeping only ever *removes* unattended-submit budget — a completed row
can never fund a submit — so it cannot loosen anything. To clear one by
hand instead: `curl -X POST .../api/automation/disarm` or the console's
Disarm button.

### Stopping a cycle by hand

`Ctrl+C` during `npm run auto:cycle` pushes the artifacts collected so far
before exiting (needs `ARTIFACT_AUTOPUSH_ENABLED=true`); press it a second
time to skip the push and exit immediately.

### Schedule it

```powershell
# 1. Create private\auto-cycle.cmd (gitignored) — with .env in place it is just:
#    @echo off
#    cd /d C:\dev\jobright-application-agent
#    npm run auto:cycle >> artifacts\console\auto-cycle.log 2>&1

# 2. Schedule it (every 4 hours while the machine is on):
schtasks /Create /TN "DispatchAutoCycle" /TR "C:\dev\jobright-application-agent\private\auto-cycle.cmd" /SC HOURLY /MO 4

# Pause / resume / kill:
schtasks /Change /TN "DispatchAutoCycle" /DISABLE
schtasks /Change /TN "DispatchAutoCycle" /ENABLE
schtasks /Delete /TN "DispatchAutoCycle" /F
```

What the cycle refuses to do, loudly and by name: run with any capability
flag missing, run when `SUBMIT_REQUIRES_LOCAL_CONFIRMATION` is still true,
run after a failed typecheck, or double-arm over a session you started
from the console (yours is left untouched). Every in-run gate — the arm
row's submit/app budget, page identity, verification, walls, caps — is
exactly the console path's. The nav agent phase needs the debug Chrome —
with `CDP_AUTOLAUNCH_ENABLED=true` the cycle starts it itself; without
that flag, keep `chrome:debug:jobright` running yourself or wall'd apps
park with the reason named, same as always.

Full-autonomy loop with this installed: scheduled cycle runs → artifacts
autopush → the cloud analysis agent scores its last prediction, fixes,
opens AND (by standing operator grant) merges the gated loop PR → the next
scheduled cycle pulls that merge before running. The human watches from
anywhere via GitHub and the pushed run reports; disabling the task or the
`AUTOMATION_ENABLED` line stops the world.
