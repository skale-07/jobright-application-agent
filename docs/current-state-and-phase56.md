# Current state and Phase 5.6 direction

Single reference for **where the codebase is** and **where Phase 5.6 goes next**.

| Field | Value |
| --- | --- |
| Doc type | Status + plan (not a live proof log) |
| Product | Local deterministic Playwright application processor |
| Canonical path | `C:\dev\jobright-application-agent` (not under OneDrive) |
| Lab baseline tag | `phase-5.5-complete` (`15f20a4`) |
| Phase 6 in tree | Not started (`autofillCompare` absent) |
| Phase 6 stash | `stash@{0}: phase6 autofill compare WIP` — do not restore unless starting Phase 6 |

Refresh git facts when needed: `git rev-parse --short HEAD`, `git describe --tags`, `git status -sb`.

Related docs (deeper detail, not replaced):

- [architecture.md](./architecture.md) — purpose, SQLite SoT, design invariants
- [validation-levels.md](./validation-levels.md) — how to claim “works”
- [phase55-remediation.md](./phase55-remediation.md) — hardened 0–5 lab baseline
- [phase56-live-validation-plan.md](./phase56-live-validation-plan.md) — original live ladder (short)
- [phase56-manual-test-commands.md](./phase56-manual-test-commands.md) — copy-paste operator runbook
- [greenhouse-live-inspection.md](./greenhouse-live-inspection.md) — GH live inspect rules
- [jobright-workflow.md](./jobright-workflow.md) — JR discover / inspect
- [known-limitations.md](./known-limitations.md) — standing ceilings
- [browser-use-evaluation.md](./browser-use-evaluation.md) — Phase 6 candidate eval only

---

## 1. What this system is

Local TypeScript / Node / Playwright agent:

```text
JobRight (discover + materials) → employer ATS fill → later contacts / LinkedIn → Outlook drafts only
```

- **Not** a general autonomous browser agent.
- **SQLite** (`data/app.sqlite`) is operational source of truth: queue, transitions, leases, idempotency, review items.
- **Artifacts** hold PDFs, screenshots, traces, JSON reports.
- **Fail-closed defaults:** `DRY_RUN`, `FORM_FILL_ENABLED=false`, `SUBMIT_ENABLED=false`.
- Staged rollout invariant: inspect → fill → human-approved submit → capped unattended. Submit remains offline by policy.

Validation language (required when claiming capability):

| Level | Meaning |
| --- | --- |
| `UNIT_CONFIRMED` | Logic / DB / policy only |
| `FIXTURE_CONFIRMED` | Local HTML/JS/PDF owned by this repo |
| `LIVE_READ_ONLY_CONFIRMED` | Real external page, no mutation |
| `LIVE_MUTATION_CONFIRMED` | Real page mutated; submit still impossible |
| `UNVERIFIED` | Not demonstrated at the required level |

A lower level never promotes a feature to a higher level.

---

## 2. Current codebase state

### 2.1 Modules (what exists under `src/`)

| Area | Role |
| --- | --- |
| `cli/` | Operator surface: migrate, login, discover, inspect, ats:inspect, ats:fill, run, report, recorder, … |
| `storage/` + queue / jobs | SQLite schema, leases, fingerprints, application state |
| `auth/` + sessions | JobRight / LinkedIn / Outlook login + storageState / persistent context |
| `browser/` | Launch options, fixture HTML pages, public-URL ephemeral pages |
| `jobright/` | Feed discover, eligibility, probes, stored-job inspect, resume download library |
| `ats/greenhouse/` | Inspect (fixture + live URL), fill/verify/upload (fixture), identity / login wall / navigation |
| `ats/` generic / unsupported | Detect / route skip for Workday, iCIMS, Oracle-class URLs |
| `applications/` | Fill guards, essay detection, approved plans, review routing |
| `recorder/` | Operator-guided JobRight captures → promote |
| `candidate/` | Profile + DPAPI-wrapped sensitive fields (Windows) |
| `security/` | Redaction, forbidden-path checks |
| `outlook/` | Scaffold only for future drafts; send is forbidden |

### 2.2 Capability matrix (honest ceilings)

| Capability | Status | Max confirmed level |
| --- | --- | --- |
| Config, migrations, state machine, leases, review items | Done | `UNIT_CONFIRMED` |
| Safety checks (`check:forbidden`, secrets staged check) | Done | `UNIT_CONFIRMED` |
| Service login CLIs (JR CDP preferred for Google OAuth) | Done | Operator-proven for JR when CDP path used |
| Recorder + promote | Done | Fixture / operator-guided |
| JobRight feed discover + queue + dedupe + eligibility | **Live path failing** | `FIXTURE_CONFIRMED`; live `UNVERIFIED` — see §2.6b |
| JobRight detail probe (Apply / Improve Resume visibility) | Done | Visibility only; Improve Resume often missing live |
| JobRight `inspect --job` (SQLite → stored detail URL) | Done (5.6A) | `LIVE_READ_ONLY_CONFIRMED` when live identity passes |
| JobRight live resume generate/download CLI | **Missing CLI** (library `downloadAndVerifyResume` exists) | Download path `FIXTURE_CONFIRMED`; live UI `UNVERIFIED` |
| Greenhouse inspect (fixtures / HTML file) | Done | `FIXTURE_CONFIRMED` |
| Greenhouse `ats:inspect --url` live read-only | Done (5.6B) | Code + unit fixtures; live depends on host/CAPTCHA gates (see open issues) |
| Greenhouse redirect-off-host handling | Done | Untrusted final host → `GREENHOUSE_APPLICATION_UNAVAILABLE` (not login wall) |
| High-confidence login-wall detection | Done | Generic nav “Login” is not enough |
| Greenhouse fill / upload / verify | Done for fixtures | `FIXTURE_CONFIRMED` only; **`ats:fill` is fixture-only** |
| Live Greenhouse fill | **Not shipped** | Ceiling today: missing CLI / flags path for live URL |
| Employer submit | Forbidden | Must stay impossible until a later, explicit phase |
| Essays / demographics / invented sponsorship | Never auto | Review / skip |
| Lever / Ashby / Workday fill | Deferred | Skip / unsupported |
| Outlook send / LinkedIn enrichment | Deferred | Scaffold only |
| Dashboard | Not started | — |
| Phase 6 autofill compare | Not in tree | Stash only |

### 2.3 CLI that matters today

```text
npm run migrate
npm run verify:phase5          # local green; not live proof
npm run login:jobright:cdp
npm run discover -- --fixture --max-jobs N
npm run discover -- --max-jobs N [--probe-detail]
npm run inspect -- --job <jobright_job_id> [--fixture] [--save-diagnostics]
npm run ats:inspect -- --fixture greenhouse | --all-fixtures
npm run ats:inspect -- --url <GREENHOUSE_APPLICATION_URL> [--headed]
npm run ats:inspect -- --html <path> --url <url>
npm run ats:fill -- --fixture greenhouse            # plan only
npm run ats:fill -- --fixture greenhouse --execute  # FORM_FILL_ENABLED + DRY_RUN=false; SUBMIT stays false
npm run report
npm run run -- --dry-run [--fixture]                # discovery-oriented; no ATS submit
```

### 2.4 What “run end-to-end apply” means today

Operator reality:

```text
login (JobRight)
  → discover (feed → SQLite)
  → inspect --job (JobRight detail, read-only)
  → ats:inspect --url (Greenhouse form inventory + proposed plan, no values)
  → ats:fill --fixture greenhouse   [lab only]
  → stop  (no live fill CLI, no submit, no resume-download CLI, no outreach)
```

There is **no** closed loop: SQLite application → live ATS fill → verified submission.

### 2.5 Safety model (still binding)

| Flag | Default intent |
| --- | --- |
| `SUBMIT_ENABLED` | Must remain `false` for all 5.6 work |
| `FORM_FILL_ENABLED` | `false` for inspect; only true for deliberate fill |
| `DRY_RUN` | `true` for inspect; `false` only with fill |

`assertReadOnlyInspectionAllowed` / fill guards enforce this in code paths. Live mutation in 5.6 is **human-initiated only** when gates allow.

### 2.6 CAPTCHA false positives — FIXED (code)

Previously: a weak HTML regex (`captcha|recaptcha|hcaptcha|cf-turnstile`) over full page HTML, OR'd with weak adapter flags, aborted inspection on normal Greenhouse pages carrying dormant reCAPTCHA assets.

Now: `src/ats/greenhouse/captchaDetection.ts` scores blocking evidence only (provider interstitial, rendered challenge iframe, explicit human-verification prompt, rendered widget container). Dormant markers — `api.js` script, v3 badge, `grecaptcha` reference, bare `data-sitekey`, the word "captcha" — are recorded in the artifact and can never abort. A readable application form lowers the score; a challenge with no readable form behind it raises it. `liveInspect` no longer ORs the adapter flag.

Level: `FIXTURE_CONFIRMED`. Live retest is still required for §5's `LIVE_READ_ONLY_CONFIRMED` checkbox.

## 2.6b Known open defect — live JobRight discovery returns zero cards

`npm run discover -- --max-jobs 5` completes in ~6s reporting `jobs_inspected: 0` while auth reports `AUTHENTICATED`. The same parser returns 5 cards from the saved fixture, so this is **not** parser rot against the capture — the live HTML differs from the capture.

**Every application currently in SQLite is fixture-derived. The live discovery path has never produced a job.**

Ranked hypotheses (untested):

1. `storageState` does not carry the auth. `context.storageState()` captures cookies + localStorage only; Google Sign-In apps commonly keep the session in IndexedDB. Playwright ≥1.61 supports `storageState({ indexedDB: true })`.
2. SPA had not rendered. Now mitigated by a 30s `waitForSelector` on job-card links, but unproven live.
3. Markup drift since the capture (~3 weeks).

Discriminator: run `npx tsx scripts/diag-jobright-feed.ts` and read `cards_selector_attached` in the empty-feed artifact. Links present but unparsed ⇒ parser drift. Links absent ⇒ auth or render.

### 2.7 Lab vs live (summary)

| Track | Quality |
| --- | --- |
| Local (typecheck, unit tests, fixtures, `verify:phase5`) | Strong foundation |
| Live JobRight stored-job inspect | Usable; partially proven |
| Live JobRight feed discover | **Failing** — 0 cards; fails loud with artifacts as of §2.6b |
| Live Greenhouse understand form | Usable but brittle (CAPTCHA false positives, employer redirects) |
| Live fill any real application | Not there |
| Autopilot apply / multi-ATS / outreach product | Not there |

---

## 3. What Phase 5.6 is

**Phase 5.6 = live validation of existing Phase 5/5.5 machinery under human control.**

Goals:

1. Prove real JobRight pages for read-only inspection (and later guarded resume download).
2. Prove real Greenhouse application pages for read-only field inventory + proposed fill plan.
3. Optionally prove **guarded** live Greenhouse fill with `SUBMIT_ENABLED=false`.
4. Never promote “fixture green” to “live green” without evidence.
5. Do not start Phase 6 compare or autofill product work in this phase.

Phase 5.6 is **not**:

- Replacing Playwright with an LLM browser agent
- Enabling employer submit
- Auto-running live mutation in CI
- Expanding to Workday/Lever as primary adapters (optional later)

---

## 4. Phase 5.6 direction (workstreams)

Status keys for this section:

- **Done (code)** — implemented on current tree
- **Partial** — shipped but incomplete / fail-prone live
- **Next** — immediate remaining engineering
- **Later in 5.6** — still Phase 5.6 scope, after Next
- **Out of 5.6** — Phase 6+ or never on this track

### 4.1 Workstream ladder

| # | Workstream | Status | Target level | Notes |
| --- | --- | --- | --- | --- |
| A | Preflight / local suite always green | Done (lab) | `UNIT` / `FIXTURE` | `npm run verify:phase5` |
| B | JobRight auth readiness | Done (ops) | Prerequisite | CDP login |
| C | JobRight live feed discover + queue | **Failing live** | `LIVE_READ_ONLY` | Returns 0 cards; fixture path fine. See §2.6b |
| C′ | Diagnose + fix live discovery | **Next** | Unblocks the closed loop | Run diag script; then fix per `cards_selector_attached` |
| D | JobRight stored-job inspect (`inspect --job`) | Done (code + live path) | `LIVE_READ_ONLY` | No feed search; SQLite → detail URL |
| E | Greenhouse live `ats:inspect --url` | Partial | `LIVE_READ_ONLY` | Redirect/login fixed; CAPTCHA false positive open |
| F | CAPTCHA high-confidence detector | Done (code) | `FIXTURE_CONFIRMED` | Unblocks E and all of Phase 6 |
| G | Re-confirm GH live inspect on sandbox URL | **Next** (operator) | `LIVE_READ_ONLY` | Manual evidence + artifact |
| H | JobRight resume control detect → live download CLI | Later in 5.6 | `LIVE_MUTATION` possible | Library exists; wrap CLI + human initiation |
| I | Greenhouse live fill (`ats:fill --url` or equivalent) | Later in 5.6 | `LIVE_MUTATION` | Deterministic fields only; verify read-back; no submit |
| J1 | Phase 6a: agent-assisted adapter authoring (Lever / Ashby) | **Out of 5.6** | — | Build-time only; emits selectors for `recorder:promote`. Gated on 5.6B closing — needs one live-confirmed deterministic ATS path as the control |
| J2 | Phase 6b: constrained agent executor (Workday), fill-only | **Out of 5.6** | — | Gated on J1 + workstream I. Verify read-back must be proven live before anything nondeterministic drives a page. No submit method |

### 4.2 Immediate next (priority order)

Engineering for 1 and 2 is done; both now need an **operator** on the Windows box.

```text
1. [OPERATOR] Diagnose live discovery (C′)
   npx tsx scripts/diag-jobright-feed.ts
   → read cards_selector_attached + sample_hrefs in the report
   → links present, none parsed  ⇒ parser/selector drift; fix jobFeed.ts
   → links absent                ⇒ auth did not carry; try storageState
                                    ({ indexedDB: true }) or run discovery in
                                    PERSISTENT_CONTEXT against the CDP profile

2. [OPERATOR] Manual re-run Greenhouse live inspect (G)
   $GREENHOUSE_URL = sandbox or real boards URL that stays on Greenhouse
   FORM_FILL_ENABLED=false DRY_RUN=true SUBMIT_ENABLED=false
   npm run ats:inspect -- --url $GREENHOUSE_URL --headed
   → proof: LIVE_READ_ONLY_CONFIRMED only if success + artifact clean
   → confirm captcha_detection.dormant_markers is populated and
     captcha_detected is false on a normal board page

3. Only then: resume CLI and/or live fill (H then I)
```

Steps 1 and 2 are independent: `ats:inspect --url` takes a URL directly and does not depend on discovery. Run whichever is convenient first. The **product** is blocked on 1 — there is no closed loop while live discovery yields nothing.

Preferred GH sandbox (integration board, not a stealth employer hit):

```text
https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003
```

### 4.3 JobRight live resume (later in 5.6)

When unblocked by UI presence of Improve Resume (or equivalent):

- Lease + idempotency
- Human-initiated generate/download only
- Verify `%PDF-`, size, SHA-256; atomic persist; materials row
- No duplicate material for same key
- Target: possible `LIVE_MUTATION_CONFIRMED` for download only

### 4.4 Greenhouse guarded live fill (later in 5.6)

Only after stable live inspect:

- `FORM_FILL_ENABLED=true`, `DRY_RUN=false`, `SUBMIT_ENABLED=false`
- Fill deterministic allowlist only
- No essays; no invented sponsorship / work auth
- Upload verified resume when mapped; verify field values on page
- Close without Submit
- Target: possible `LIVE_MUTATION_CONFIRMED`

### 4.5 Explicit non-goals (through and beyond 5.6 unless re-scoped)

- Employer Submit
- Essay generation
- Outlook **send**
- Silent multi-ATS expansion without adapters
- Restoring Phase 6 stash into master without a deliberate Phase 6 plan
- Replacing Greenhouse adapter with an LLM agent as the default fill engine

---

## 5. Phase 5.6 success criteria

### Phase 5.6A / JobRight (read-only) — largely met when

- [x] Deterministic `inspect --job` from SQLite (code)
- [x] Live identity + control visibility can pass for at least one stored job (manual)
- [x] Empty live feed fails loud with artifacts + review item instead of reporting success (code + unit)
- [ ] Live feed discovery returns ≥1 card (C′ — currently failing, §2.6b)
- [ ] Resume generate/download proven live (optional stretch of 5.6, not same as inspect)

`inspect --job` resolves a stored URL from SQLite, so its checkbox stands independently of C′.

### Phase 5.6B / Greenhouse (read-only) — met when

- [x] `ats:inspect --url` exists with URL validation + proposed plan (code)
- [x] Untrusted redirect classified as application unavailable (code + fixture)
- [x] High-confidence login wall vs generic Login link (code + fixture)
- [x] CAPTCHA false positives fixed — code + fixtures (`FIXTURE_CONFIRMED`)
- [ ] CAPTCHA fix confirmed on a live board page (operator)
- [ ] Manual live inspect succeeds on a trusted Greenhouse application host with artifact (`LIVE_READ_ONLY_CONFIRMED`)

### Phase 5.6 mutation (optional extension)

- [ ] JobRight resume download CLI + live evidence **or** documented block (controls absent)
- [ ] Greenhouse live fill path + live evidence with submit still off

Do not claim Phase 5.6 “complete” until B’s open checkboxes are closed with evidence. Mutation items can be a follow-on tag.

---

## 6. End-state product direction (after 5.6)

Longer arc from [architecture.md](./architecture.md) (not all committed this phase):

```text
Discover (done) → materials (partial) → inspect (partial live)
  → fill (fixture; live later) → human-approved submit (later)
  → contacts / LinkedIn (later) → Outlook drafts only (later)
```

Optional Phase 6 track (eval only today): constrained residual fill assist for **unsupported ATS** under the same policy invariants — see [browser-use-evaluation.md](./browser-use-evaluation.md). That is **coverage**, not a replacement of Greenhouse fill.

Two Phase 6 notes that affect 5.6 sequencing:

- Workstream **F is on Phase 6's critical path**, not just Greenhouse's. Any agent will meet CAPTCHAs and must route to a human; the high-confidence detector is the shared gate.
- Do **not** reach for an agent to debug the live feed (§2.6b). `scripts/diag-jobright-feed.ts` answers that deterministically, cheaper and repeatably. Adding an LLM to an unsolved perception problem produces a second unsolved problem.

---

## 7. Operator quick reference

Safe env for all 5.6 read-only work:

```powershell
cd C:\dev\jobright-application-agent
$env:FORM_FILL_ENABLED="false"
$env:DRY_RUN="true"
$env:SUBMIT_ENABLED="false"
```

Core commands: full matrices and PowerShell sequences live in [phase56-manual-test-commands.md](./phase56-manual-test-commands.md).  
GH failure precedence and identity rules: [greenhouse-live-inspection.md](./greenhouse-live-inspection.md).

---

## 8. Maintenance

When Phase 5.6 CAPTCHA fix lands or a capability is re-leveled:

1. Update the capability matrix (§2.2) and checklist (§5) in **this** file.
2. Note commit/tag used as the new baseline.
3. Keep detailed procedures in the specialized docs; do not duplicate long command dumps here.
