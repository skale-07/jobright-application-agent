# Product vision & technical direction — jobright-application-agent + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/tSearch`
— keep both files identical when editing. This is a **living document**, refreshed by a
scheduled review. It is not a proof log or a phase-status doc (those already
exist per-repo — see the "Deeper detail" links below) — it exists so both
projects' vision, architecture, and direction stay legible from one place, and
so risks that only show up when you look at *both* repos together (shared
lineage, shared operator, shared data-handling posture) don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-08-13 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**), `skale-07/tSearch` (**public**) |

**Note on provenance**: a fuller "third review" was drafted 2026-08-11 on an
unmerged branch (`claude/epic-pasteur-by0hjn`) but never merged to either
`main`/`master`. Per the session-start-ritual instruction to check
`claude/epic-pasteur*` branches for a fresher copy, this review treats that
draft as its baseline and reconciles it against everything that has actually
landed since — including new feature commits on both repos' unmerged branches
(`claude/talent-discovery-pipeline-bfunzx` for tSearch,
`claude/busy-clarke-559fdc` for jobright) — rather than starting from the
last-merged 2026-08-07 version. Two small factual errors in the 08-11 draft
are corrected here: it mislabeled `docs/tsearch-reuse-map.md`'s home repo
(it lives in jobright, not tSearch — fixed in §3) and dropped the
cross-repo "Deeper detail" qualifiers for §1's links (restored below).

---

## 1. jobright-application-agent

### 1.1 Vision

A **local, deterministic, operator-controlled** Playwright agent that automates
the mechanical parts of *your own* job-application workflow — JobRight.ai
discovery → employer ATS form fill → gated submit → outreach → Outlook
drafts — while keeping every judgment call (essays, demographics, uncertain
submissions) with a human. It is explicitly **not** trying to be a general
autonomous browser agent. The product bet is that determinism + fail-closed
gating + an honest validation ladder beats an LLM-driven agent for a task
where a wrong click (an accidental real submission, a leaked credential, an
invented EEO answer) is expensive and hard to undo. That bet extends to a
second surface: an **operator console** ("Dispatch") that lets a human run,
watch, and approve the pipeline from a browser instead of the CLI, plus an
opt-in **L3 armed mode** that removes per-application confirmation only
inside a timed, capped, operator-initiated window — never the underlying
safety gates.

**This review's central finding is that the Critical resume-PDF exposure
flagged 08-11 was not remediated and has gotten worse — two more autopush
commits landed 2026-08-12, adding 5 more leaked files (187 total now), the
pre-commit hook is still not installed, and this review found a second,
independent reason it keeps recurring: even with the hook installed, the
secret-scanner's own regex would not catch these filenames. See §4, first
row, for the full picture — this is now two consecutive review cycles where
the product's own safety net around its most identifiable personal data has
failed to close.**

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI (multiple gated call sites) / Express + React console frontend.
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`) exportable via `npm run training:export`. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (full list in `CLAUDE.md`). `chromium.launch` is confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Free-text/essay and demographic fields are architecturally incapable of being auto-filled — they route to `review_items`; `ESSAY_DRAFT_ENABLED` may generate a SUGGESTION into that review item, but only human-approved text ever fills.
- **New flags since 08-11:** `GENERIC_ATS_ENABLED` (a company-hosted, non-named-ATS adapter, landed `12c2f62` on 08-12 — fill/submit still routed through the same congruence + submit gates) and `ESSAY_AUTOFILL_ENABLED` (landed as PR #39, "autonomy: answer everything"; matches CLAUDE.md's 2026-08-13 operator-directive description — generates from `private/candidate/about-me.md`, requires that file plus an LLM key, output passes `validateDraft`, every generated answer is recorded on the plan entry). Both are already documented in CLAUDE.md's fail-closed flag list, consistent with house-rules discipline.
- **ATS coverage today:** Greenhouse (inspect/fill/submit shipped, `FIXTURE_CONFIRMED`, live paths `UNVERIFIED`). Lever, Ashby, Workday, Workable all wired end-to-end but **unchanged since last review** — still `UNVERIFIED (wired, never run)` / `UNVERIFIED_SELECTOR` in their own docs. Generic ATS is the newest addition (see above), same honesty discipline expected once it accumulates a doc of its own.
- **Verify gate this review:** `npm run typecheck` clean. `npm run test`: 712 passed / 126 failed / 8 skipped across 30 files — every failure traces to `browserType.launch: Executable doesn't exist … chrome-headless-shell` (the Playwright browser binary isn't installed in this review's sandbox). This reads as a review-environment gap, not a code regression, but it means this review's test-suite claim is `UNVERIFIED` for anything touching real browser launches, and should be re-run in an environment with the binary present before being treated as confirmed.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **Resume-PDF leak: escalated, not resolved.** See §4. Concretely this review
  found: (a) `.git/hooks/pre-commit` still absent, `core.hooksPath` unset —
  `npm run hooks:install` has still never been run; (b) two more autopush
  commits since 08-11 (`4f5df1d`, `14905ff`, both 2026-08-12) added 5 more
  resume PDFs, bringing the total to 187 unique leaked file paths across 13
  commits, all reachable from current `HEAD`; (c) the one purge commit that
  exists (`f0ddcff`, "security: purge leaked files") addresses a **different**
  incident (a leaked `.env` key + `.history/` snapshots from 08-07) and lives
  only on `master`, not on the branch these leaks are on — the 187-file
  autopush leak has never had a purge attempted; (d) `src/automation/artifactAutopush.ts`
  still does a blanket `git add -A -- artifacts` with no `materials/`
  exclusion, so it will keep leaking on every future autopush cycle; (e)
  **new this review** — even if the hook were installed, its regex
  (`src/security/artifactScan.ts:26`, `/resume\.pdf$/i`) would not match the
  actual filenames (`resume-<hash>.pdf`), so the intended safety net has a
  second, independent gap on top of not being installed at all.
- **`docs/current-state-and-phase56.md` is still wrong — third review in a
  row flagging it, still unfixed.** It still states live discovery "has never
  produced a job" (`jobs_inspected: 0`), directly contradicted by real,
  non-fixture artifacts this review read directly
  (`artifacts/console/auto-cycle/cycle-2026-08-12T23-27-16-165Z.json`:
  `discover: 8 inspected`, `apps_started: 3`). This has now gone two full
  days past the 08-11 finding without a fix, despite the 08-11 review noting
  it was "a same-day fix, not new code."
- **L3 armed unattended apply: still not confirmed past `FIXTURE_CONFIRMED`,
  with one loose end worth an operator's eyes.** Every current-cycle
  auto-cycle artifact (08-10 through 08-13) shows `submits_used: 0`. One
  older artifact, `artifacts/console/runs/run-47082d9f.../report.json`
  (an armed session from 2026-08-08), shows `submits_used: 1` at the top
  level while all 7 of its listed `per_app` entries show
  `submitted: false`/`FAILED_RETRYABLE` — an internal inconsistency, not a
  confirmed live submit. Flagged for operator clarification rather than
  asserted either way; does not change the overall `FIXTURE_CONFIRMED`
  status.
- **`auto:cycle` unattended operating posture: unchanged.** Still a standing
  `.env` + scheduled task, self-arming, no per-run human click; no
  time-boxed re-arm gate has been added since 08-11.
- **Sender-trust magic-link handling: unchanged since `ecc0979`.** Still a
  keyword-match-only qualification, no sender-domain-affinity requirement,
  browser still navigates using the operator's authenticated session.
- **Feature wave since 08-11** (PRs #31–#39, merged 2026-08-12): navigation
  speed/login-wall diagnosis and reliability fixes, a congruence improvement
  that infers employer from URL for unsupported ATS, the new generic ATS
  adapter, and the essay-autofill feature (all covered above). Zero open
  issues, zero open PRs at time of this review.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  silent multi-ATS expansion beyond what's now wired, replacing any
  deterministic adapter with an LLM agent as the default path, loosening L3's
  numeric caps.
- **Next up, in priority order:** (1) install the pre-commit hook and fix the
  secret-scan regex, then purge the resume-PDF history — this is now the
  single most overdue action item across both repos; (2) fix
  `current-state-and-phase56.md` against the artifacts that already
  contradict it; (3) resolve the `submits_used: 1`/`per_app` inconsistency
  with an operator; (4) live-DOM proof for Lever, Ashby, Workday, Workable,
  and the new generic adapter; (5) a decision on tightening sender-trust
  domain affinity.

Deeper detail (in this repo):
[`docs/architecture.md`](./architecture.md) ·
[`docs/current-state-and-phase56.md`](./current-state-and-phase56.md) ·
[`docs/operator-guide.md`](./operator-guide.md) ·
[`docs/ats-adapters-lever-ashby.md`](./ats-adapters-lever-ashby.md) ·
[`docs/ats-adapter-workday.md`](./ats-adapter-workday.md) ·
[`docs/known-limitations.md`](./known-limitations.md) ·
[`docs/validation-levels.md`](./validation-levels.md)

---

## 2. tSearch

### 2.1 Vision

"Unseen talent discovery": find people whose ability shows up in public
artifacts (GitHub repos, technical writing) rather than credentials — starting
from named seeds (olympiad medalists, referrals), expanding outward through
their real collaboration graph (GitHub collaborators/followers, Substack),
scoring on evidence of building + thinking + pedigree, then running LLM
"judges" over their actual public work to produce a defensible, evidence-cited
priority score for a recruiter digest. The stated non-negotiable design
principle (`implementation-prompt.md`) is that every judgment must be
evidence-grounded and that missing evidence maps to `insufficient_public_evidence`,
never to a negative capability judgment — the system is built to avoid
confidently ranking someone down for something it simply couldn't see.

### 2.2 Core technical details

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / Anthropic + OpenAI (provider-selectable) / Resend.
- **Pipeline:** `resolve identity (LinkedIn + website) → expand graph hop-1 (GitHub collaborators/followers, Substack) → optional hop-2 (UI-driven only) → score (final_score heuristic) → persist (candidates.json, profiles/, data/people/) → assess (LLM judges, priority_score) → digest email`, with an optional autopilot chain (sweep → resolve → discovery → assessment → digest → send) and a GitHub-first "footprint sweep" that pre-qualifies olympiad-CSV names before ever touching LinkedIn.
- **Discovery/Assessment/Presentation separation is load-bearing:** assessment reads only the frozen candidates snapshot — it never re-runs LinkedIn discovery or corrects a wrong identity match. `final_score` (discovery) and `priority_score` (assessment) are deliberately never collapsed into one number.
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass, joined by an experience-distinctiveness judge (routing boost only) and a label judge mapping outputs to recruiter-facing archetypes/tiers.
- **New this review — two feature commits landed 2026-08-13 on an unmerged branch, both reviewed clean:**
  - `6ebab0f` ("obscurity multiplier + age-relative impressiveness — Grace
    feedback") adds `computeObscurity.ts` and an age-relative judge.
    **Verified**: `obscurity`/`obscurity_confidence` are added to
    `ScoreBreakdown` but explicitly excluded from the `final_score` sum
    (the code's own comment says so); the age-relative judge reuses the
    existing LLM-client/mock gating, no new env flag, no new LLM surface,
    `priority_score` untouched.
  - `257b5f4` ("award registry, seed-source refresh, UI ranking dials") adds
    a tracked `reference/awards-registry.yaml` (no PII) plus seed-refresh
    sources that read only local operator-supplied files. **Verified**: zero
    `fetch`/`http`/`axios` calls in the new source files — no new live
    scraping; LinkedIn resolution remains the sole identity path per the
    commit's own framing.
- **Safety-flag layer — unchanged since 08-11.** `CLAUDE.md` documents
  fail-closed boundaries in prose; there is still no forbidden-API checker or
  repo-wide `*_ENABLED` naming convention comparable to jobright's CI-enforced
  `check:forbidden` — individually-safe-by-inspection flags, mechanically
  unenforced.
- **Verify gate this review:** `npm run typecheck` clean. `npm run test`:
  **186/186 passing across 36 files.** Repo is not currently broken.

### 2.3 Technical direction

- **PII history exposure: unchanged, still critical, still unpurged.**
  Re-verified directly this review: `git show 700e2f6:profiles/madanva/profile.json`
  (still fetchable from `origin` right now) returns a real person's full name,
  LinkedIn URL, photo CDN URL, school, and degree. 71 commits across history
  touch `profiles/`. No `filter-repo`/BFG commit exists anywhere in
  `git log --all`. Current tree stays clean (`.gitignore` covers `profiles/`,
  `backup/`, `data/`, `cache/`, `output/`), which bounds new exposure but does
  nothing for what's already public in history. This is now the fourth review
  in a row flagging the same unexecuted remediation.
- **Ownership-share fix and mid-run LinkedIn auth-guard: still holding.**
  `tests/assessment/ownership.test.ts` and `tests/linkedin/authGuard.test.ts`
  both still present and passing — the two risks resolved 08-10/08-11 have
  not regressed.
- **Digest feedback loop, oracle, and autopilot: unchanged since 08-11**
  beyond the digest UI addition inside `6ebab0f` (a new "upside" chip
  surfacing obscurity in the digest — doesn't touch `priority_score`).
  Ranking-refinement-*from*-feedback (as opposed to feedback capture, which
  is built) is still the open remainder of that roadmap.
- **Still open, unchanged:** zero retry/trace/screenshot capture on LinkedIn
  scrape failures; captured country is still ranking-only, never used to
  reject homonym mismatches after the fact; auto-assess still runs by default
  at the end of every pipeline run (`AUTO_ASSESS=0` to opt out).
- **Open product question, still unresolved:** whether digest emails should
  surface global top-N candidates or per-seed neighbors, and whether
  Substack-only (no GitHub) candidates should be filtered out of the digest
  at all.
- Zero open issues, zero open PRs at time of this review.

Deeper detail (in `skale-07/tSearch`, not this repo): `docs/implementation-prompt.md` ·
`docs/all-agents-wiring-verification.md` · `docs/email-digest-implementation-context.md` ·
`docs/system-brief.md` (generated, Tier 0 oracle context)

---

## 3. How the two projects relate

jobright-application-agent is a **hardened descendant** of tSearch's session/
scraping infrastructure, not an unrelated project. `docs/tsearch-reuse-map.md`
(**this repo** — corrected from the 08-11 draft, which mislabeled this as
living in tSearch) records the original reuse plan: tSearch's `saveSession.ts` /
`linkedinBrowser.ts` concepts (manual storageState login, lazy session
open/validate) and atomic-JSON-store pattern were the seed for jobright's
`ServiceSession` and `src/storage/` layers, explicitly rebuilt with more
hardening (coverage statuses, mid-run auth checks — now matched on tSearch's
side too, see §2.2 — traces/screenshots, no committed profile artifacts, a
design choice tSearch has now also adopted going forward per §2.2, though not
retroactively into history per §4). tSearch's product logic — olympiad
scoring, GitHub graph expansion, the seed-tree UI — was deliberately **not**
ported; the two products solve different problems (apply vs. discover) and
share only the "safely drive a browser session against a third-party site"
substrate.

**Both repos now share the same unresolved shape of risk: a personal/PII
document exposure on a public repo, found and re-confirmed unpurged across
multiple review cycles, with the underlying automation still capable of
adding more.** tSearch's is third-party LinkedIn PII in history only (current
tree is clean); jobright's is the operator's own resume PDFs, still actively
being added to the live tree with every automation cycle — which makes
jobright's the more urgent of the two right now, since it is still growing
while tSearch's is not. Both repos also carry a genuinely unattended,
scheduled-automation surface — jobright's `auto:cycle` (§1.3, real
submissions possible) and tSearch's autopilot (§2.3, fail-closed to
mock/dry-run by default) — worth watching as a shared pattern, since a gating
bug in either would look similar from the outside (a scheduled task silently
doing something consequential).

One document is stale on the reuse-plan point specifically:
`docs/tsearch-reuse-map.md` still describes porting `linkedinExtract.ts` into
a `packages/linkedin-enrichment` module "in Phase 10," but
`current-state-and-phase56.md` records that LinkedIn enrichment was
**dropped by decision** for the MVP (JobRight contact context only).
Low-severity, unchanged since 2026-08-07.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | jobright | **Escalated this review — not fixed, actively worse.** `ARTIFACT_AUTOPUSH_ENABLED` continues pushing the operator's real resume PDFs to this public repo: 2 more autopush commits landed 2026-08-12 (`4f5df1d`, `14905ff`), bringing the total to **187 unique leaked files across 13 commits**, all reachable from current `HEAD`. `.git/hooks/pre-commit` is still not installed (`npm run hooks:install` never run). The one purge commit in the repo (`f0ddcff`) addresses an unrelated 08-07 incident and lives only on `master` — the resume-PDF leak has never had a purge attempted. **New finding this review**: even installing the hook wouldn't fully fix this — `src/security/artifactScan.ts`'s regex (`/resume\.pdf$/i`) doesn't match the actual filenames (`resume-<hash>.pdf`), a second, independent gap. `src/automation/artifactAutopush.ts` still has no `materials/` exclusion, so it will keep leaking. | Two consecutive review cycles have now found this and neither has been acted on — the leak is growing in real time. Immediate action, in order: (1) `npm run hooks:install`; (2) fix the secret-scan regex to match `resume-*.pdf`, not just `resume.pdf`; (3) add a `materials/` exclusion to `artifactAutopush.ts` so autopush stops adding to the problem; (4) `git filter-repo`/BFG-purge the 187 files from history. This is the single most urgent item across both repos. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII (name, LinkedIn URL, photo URL, school, degree) is untracked from the current tree but still fully present and fetchable in git history on this public repo — re-verified directly this review by reading a real PII blob (`700e2f6:profiles/madanva/profile.json`) out of a still-reachable commit. No purge has been attempted since the finding was first raised. | Fourth review in a row confirming this is unchanged: a live public exposure of real third-party people's data, not a hypothetical. `git filter-repo`/BFG + force-push + collaborator re-clone is still the concrete, unexecuted unblock. |
| **High** | jobright | `docs/current-state-and-phase56.md` remains actively contradicted by the repo's own committed artifacts (it says live discovery "has never produced a job"; real auto-cycle artifacts from 08-12 show `inspected: 8`, `apps_started: 3`) — third review in a row flagging this, now two full days past when it was first called a "same-day fix." | An operator or future agent trusting this doc would materially misjudge the product's current state. The fix is a doc edit, not new code — the cost of continuing to leave it is now higher than the cost of fixing it. |
| **High** | jobright | `auto:cycle` + a standing `.env` + a scheduled task remains a genuinely unattended fill-and-submit operating mode with no per-run human click and no time-boxed re-arm gate, unchanged since 08-11. No live submit has occurred yet (one ambiguous historical artifact aside, see §1.3), so realized risk is still bounded, but the capability is armed and intended for regular use. | Still an open, deliberate product decision: whether 4-hourly unattended real-submission automation needs an additional standing-authorization gate before being treated as normal operation. |
| **High** | jobright | Sender-trust magic-link handling (`ecc0979`) remains a keyword-match-only qualification with no sender-domain-affinity requirement; the browser still navigates to matching links using the operator's authenticated session. Unchanged since 08-11. | Still a genuine, code-verified phishing-surface widening with no decision made yet on tightening it back toward domain affinity or adding sender authentication. |
| **Medium** | jobright | `operator-guide.md`'s claim that the improvement loop autonomously merges its own gated PR remains unsupported by anything in-repo (`.claude/commands/improve.md` still says a human merges). Unchanged, still unconfirmed either way. | Needs a direct operator confirmation — "agent proposes" vs. "agent unattendedly merges to its own safety-relevant codebase" are very different risk profiles. |
| **Medium** | jobright | Lever, Ashby, Workday, Workable, and now the new generic ATS adapter are all wired but unverified against real DOM — no live-DOM progress on any of them since 08-11. | The live-proof backlog has grown (five adapters now) rather than shrunk; the honest `UNVERIFIED_SELECTOR` labeling is good discipline but doesn't reduce the backlog itself. |
| **Medium** | tSearch | No fail-closed safety-flag *enforcement* — `CLAUDE.md` documents boundaries in prose but there is still no forbidden-API checker or `*_ENABLED` naming convention comparable to jobright's CI-enforced `check:forbidden`. Unchanged since 08-11. | A future change could silently violate the frozen-candidates-snapshot or `final_score`/`priority_score` separation invariants and nothing in CI would catch it. |
| **Medium** | tSearch | `tsearch-playwright-system-audit.md` remaining items unchanged: zero retry/trace/screenshot capture on scrape failures; captured country still never used to reject homonym mismatches. | Wrong-person matches can still silently enter the candidate graph; live failures are still hard to diagnose after the fact. |
| **Low** | jobright | An older run artifact (`run-47082d9f`, 2026-08-08) shows `submits_used: 1` at the top level while all 7 of its `per_app` entries show `submitted: false`/`FAILED_RETRYABLE` — an internal inconsistency, not a confirmed live submit, but worth an operator's direct look. | Doesn't change L3's overall `FIXTURE_CONFIRMED` status, but a validation-ladder document should not have an unresolved contradiction sitting in its own evidence. |
| **Low** | tSearch | Auto-assess still runs by default at the end of every pipeline run (`AUTO_ASSESS=0` to opt out); individually fail-closed but a global `AUTO_ASSESS_LIVE=1` convenience setting would mean every future run silently spends on live LLM calls. Unchanged since 08-11. | Cost/scope-creep item, not a safety gap. |
| **Low** | tSearch | Digest-loop ranking-*refinement*-from-feedback still unbuilt; global-vs-per-seed and Substack-only-filtering product questions remain unresolved. Unchanged since 08-07. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase 10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **Gitleaks (or an equivalent) with a path-based custom rule, not just a
  secrets regex** — directly targets this review's new finding: the current
  `check-secrets-staged.ts` filename regex fails to match the real leaked
  files (`resume-<hash>.pdf` vs. its `resume\.pdf$` pattern). Gitleaks
  supports `.gitleaks.toml` path-filter rules that can block any
  `materials/.*\.pdf$` path outright, independent of filename spelling —
  a more robust fix than patching one regex, since it stops the *class* of
  file rather than one naming pattern. https://gitleaks.org/
- **Human-oversight-by-design browser-agent patterns** (e.g. Asteroid,
  Straiker's runtime guardrails for agentic browsers) — carried over from
  the last review, still directly relevant to the unresolved `auto:cycle`
  posture question in §4: unattended browser automation guidance
  consistently treats human-approval gates on irreversible actions as
  structural, not optional.
- **CDP session-handoff discipline** — carried over, still relevant now
  that the console, the nav-layer sidecar, and `auto:cycle` can all
  potentially want the same CDP Chrome instance.

**tSearch**

- **`git filter-repo` / BFG history purge, executed, not just planned** —
  repeated for the fourth review in a row. This is not a new suggestion; it
  is now the single most overdue action item specific to this repo, kept
  here deliberately so it doesn't quietly stop being said just because it's
  been said before.
- **GitHub push protection with a custom secret-scanning pattern** matching
  the scraped-profile JSON shape (name + LinkedIn URL + photo URL) — pairs
  with the history purge as a recurrence-prevention measure at push time.
- **Judge Reliability Harness** (arXiv 2603.05399) and the broader
  LLM-as-judge literature's inter-rater-reliability/calibration-anchoring
  methods — increasingly applicable as more judges stack up
  (experience-distinctiveness, recruiter-label, and now the age-relative
  judge added 08-13) without a measured agreement number between them.

---

## Changelog

- **2026-08-13** — Fourth review (this one). Baselined against the unmerged
  2026-08-11 draft (`claude/epic-pasteur-by0hjn`) per the session-start-ritual
  instruction, then reconciled against everything landed since, including two
  new feature commits on tSearch's `claude/talent-discovery-pipeline-bfunzx`
  (obscurity/age-relative scoring, award registry + seed refresh — both
  reviewed clean, no safety-invariant violations) and continued work on
  jobright's `claude/busy-clarke-559fdc` (generic ATS adapter, essay
  autofill, nav reliability fixes — PRs #31–#39). Corrected two factual
  errors carried in the 08-11 draft: `docs/tsearch-reuse-map.md`'s home repo
  was mislabeled, and §1's "Deeper detail" cross-repo link qualifiers had
  been dropped.
  **Headline finding: the Critical resume-PDF leak first found 08-11 was not
  remediated and got worse** — 2 more autopush commits (08-12) added 5 more
  files (187 total, 13 commits), the pre-commit hook is still not installed,
  and this review found a second, independent reason the leak persists: the
  secret-scanner's own regex doesn't match the actual leaked filenames even
  when the hook runs. tSearch's PII-history exposure remains unchanged and
  unpurged (fourth review confirming it). `docs/current-state-and-phase56.md`
  is still wrong (third review flagging it, now two days past "same-day
  fix"). Found one new Low item: an internal inconsistency in an older
  jobright run artifact (`submits_used: 1` with no corroborating successful
  `per_app` entry) worth an operator's direct look, though it doesn't change
  L3's `FIXTURE_CONFIRMED` status. Verify gates: tSearch 186/186 tests
  passing, typecheck clean; jobright typecheck clean, but 126 of 838 tests
  failed on a missing Playwright browser binary in this review's sandbox
  (environment gap, not a code regression — re-run needed in a properly
  provisioned environment before treating jobright's test suite as fully
  confirmed this cycle). Both repos: zero open issues, zero open PRs at time
  of review.
- **2026-08-11** — Third review (drafted on `claude/epic-pasteur-by0hjn`,
  never merged — used as this review's baseline per above). Baselined
  against the unmerged 2026-08-09 draft. tSearch: verified two
  previously-flagged risks genuinely resolved (ownership-share bug, mid-run
  auth guard) by reading the fix code and its tests directly; verified the
  PII-history risk unchanged (current tree clean, history still unpurged);
  found one new low-severity risk (auto-assess on by default). jobright:
  found the discovery-status doc question had flipped from "ambiguous" to
  "actively contradicted by the system's own artifacts"; found L3 still not
  graduated past `FIXTURE_CONFIRMED`; found two new High risks — the
  `auto:cycle` unattended-scheduling posture shift, and a security loosening
  in sender-trust magic-link handling; corrected this doc's own "private"
  mislabel for jobright (it's public, cleanly gitignored). **Mid-review,
  discovered a second Critical finding while preparing to commit this very
  doc update**: jobright's `art:`-autopush automation had been committing
  the operator's real resume PDFs to this public repo since 2026-08-08 (183
  copies, 11 commits, missed by all three prior reviews) — the pre-commit
  hook was never installed. Both repos: zero open issues, zero open PRs at
  time of review.
- **2026-08-09** — Second review (drafted on `claude/epic-pasteur-27u1xf` /
  `claude/busy-clarke-27u1xf`, never merged). tSearch: zero commits since
  2026-08-07 beyond the vision-doc merge itself; §2 reconfirmed unchanged.
  jobright: large feature wave landed (Lever/Ashby wiring, navigation layer,
  operator console, L3 armed automation, screener answer-bank, essay draft
  assistant, telemetry export, branding/site) — §1 rewritten. Surfaced the
  discovery-status doc disagreement (since escalated, see 08-11/08-13 above).
  Both repos: zero open issues, zero open PRs at time of review.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state (both repos: zero open
  issues, zero open PRs at time of review). Verified the critical PII/public-repo
  finding directly (`git ls-files`, file content, repo visibility) rather
  than relying solely on subagent report.
