# Product vision & technical direction — jobright-application-agent + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/jobright-application-agent`
— keep both files identical when editing. This is a **living document**,
refreshed by a scheduled review. It is not a proof log or a phase-status doc
(those already exist per-repo — see the "Deeper detail" links below) — it
exists so both projects' vision, architecture, and direction stay legible
from one place, and so risks that only show up when you look at *both*
repos together (shared lineage, shared operator, shared data-handling
posture) don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-08-19 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**), `skale-07/tSearch` (**public**) |

**Note on provenance**: the most recent copy merged to `main`/`master` in
either repo is still the 2026-08-07 original — six subsequent reviews
(08-09, 08-11, 08-13, 08-15, 08-17, and this one) were drafted on unmerged
`claude/*-*` branches and never landed. Per the session-start-ritual
instruction to check those branches for a fresher copy, this review
baselines on the 2026-08-17 draft (`claude/epic-pasteur-kr7842` /
`claude/busy-clarke-kr7842`, the most recent) and reconciles it against
everything that has actually changed since — verified directly against both
repos' current `HEAD`, not by re-reading the prior draft's claims
uncritically.

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
second surface: an **operator console** ("Dispatch" — the repo itself began
a rename to this name this review cycle, PR #61) that lets a human run,
watch, and approve the pipeline from a browser instead of the CLI, plus an
opt-in **L3 armed mode** that removes per-application confirmation only
inside a timed, capped, operator-initiated window — never the underlying
safety gates.

**This review's central finding, again: the Critical resume-PDF exposure
first flagged 08-11 is now on its fifth consecutive review cycle without a
fix, and it is still growing — 327 leaked files on 08-17, 366 today. This
review also found direct, first-party evidence of *why* the safety net is
failing**: a commit landed on `master` this cycle whose own message admits
a corrupted binary fixture slipped past the local pre-commit hook and only
got caught when the CI-equivalent gate ran (see §1.3). That is no longer an
inferred gap — it is the repo's own commit log documenting the hook not
doing its job on the machine that keeps adding to this leak.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3/Moonshot (multiple gated call sites) / Express + React console frontend.
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`) exportable via `npm run training:export`. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (full list in `CLAUDE.md`). `chromium.launch` is confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Free-text/essay and demographic fields are architecturally incapable of being auto-filled — they route to `review_items`; `ESSAY_DRAFT_ENABLED` may generate a SUGGESTION into that review item, and `ESSAY_AUTOFILL_ENABLED` may fill directly from `private/candidate/about-me.md` under the same `validateDraft` checks, with every generated answer recorded on the plan entry.
- **Feature wave since 08-17 — verified clean of the safety-flag list and submit gating.** Seven commits/PRs landed: a revert of the prior cycle's three predictor-efficiency changes after they proved net-negative (#55); grounding "why us" essay generation in actual posting context (title/heading/meta text harvested from every page-level hop, 900-char cap, no LLM in the harvest step) instead of abstaining blank when company/role context was empty, bundled with a fix restoring a corrupted `tests/fixtures/ats/greenhouse/sample-resume.pdf` that had broken `check:secrets`' pinned sha256 (#56 — see §1.3 for why this commit's own message is itself a finding); insider-connection email triage expanded to capture school + "beyond school" panels (#57); templated outreach v2 plus Gmail drafts (#58); Kimi K3 (Moonshot) added as a third opt-in LLM provider alongside Anthropic/OpenAI (#59); insider-triage display-name capture plus loud failure (rather than silent placeholder) on persona drafts (#60); and the Dispatch rename prep touching CLI/dashboard strings only (#61). Diffed all seven directly for touches to `sendGuards.ts`, `assertExecutableApprovedEntry`, `SUBMIT_ENABLED`, or `check-forbidden.ts` — none touch any of them.
- **ATS coverage today: unchanged since 08-11.** Greenhouse (inspect/fill/submit shipped, `FIXTURE_CONFIRMED`, live paths `UNVERIFIED`). Lever, Ashby, Workday, Workable all wired end-to-end but still `UNVERIFIED (wired, never run)` / `UNVERIFIED_SELECTOR` — verified no commit since 08-17 touched `docs/known-limitations.md`, `docs/ats-adapters-lever-ashby.md`, or `docs/ats-adapter-workday.md`. Generic is first-class (since 08-13, PR #42).
- **Verify gate this review, all re-run directly on current `HEAD` (`eedc63c`), not assumed:** `npm run typecheck` clean. `npm run check:forbidden` and `npm run check:secrets` both `ok`. `npm run test`: **895 passed / 199 failed / 8 skipped across 1102 tests in 116 files** (up from 873/1066 on 08-17 — growth tracks the new feature-wave tests). Every failure traces to the same single cause as the last three reviews: `chrome-headless-shell` isn't installed at this sandbox's Playwright browser path (`/opt/pw-browsers/chromium_headless_shell-1228/...`) — plain Chromium is present but the headless-shell channel the fixture harness requests is not. Not evidence of a code regression; claim remains `UNVERIFIED` for anything touching a real browser launch until re-run in an environment with the binary present.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **Resume-PDF leak: fifth review running, still unresolved, still growing —
  and this review found direct evidence of the mechanism, not just the
  symptom.** Verified directly against current `HEAD` (`eedc63c`): (a) **366
  `artifacts/applications/*/materials/resume-*.pdf` paths** are now
  reachable from `HEAD` (up from 327 on 08-17, 308 on 08-15) — traced the
  39 net-new paths to a single commit, `29b02cf` ("submit tuning",
  2026-08-17), confirmed by diffing the tracked file list directly; (b)
  unlike most of the prior growth (tagged `art: automation session ...
  (autopush)`), this batch landed under a plain manual commit message —
  confirming the leak is not solely the autopush code path's fault; the
  operator's own manual "tuning" commits are adding to it too, which the
  regex/exclusion fix in (c)/(d) below would still catch *if the local hook
  actually ran*; (c) `src/automation/artifactAutopush.ts:53` still runs a
  blanket `git("add", "-A", "--", "artifacts")` with no `materials/`
  exclusion — confirmed unchanged, same line number as the last three
  reviews; (d) `src/security/artifactScan.ts:26`'s pattern is still
  `/resume\.pdf$/i`, confirmed unchanged, same line — verified directly with
  `node -e "console.log(/resume\.pdf$/i.test('resume-db94def0.pdf'))"` →
  `false`; (e) **new this review**: commit `eb4a999`'s own message states
  that a CRLF-mangled copy of the test fixture `sample-resume.pdf` "picked
  up" by an operator artifact commit broke `check:secrets`' pinned sha256 on
  `master` — i.e. a corrupted binary landed in a commit that should have
  been caught by the local pre-commit hook before it ever reached `git
  push`, and wasn't; the same commit message says explicitly "the desktop's
  pre-commit hook is worth re-checking (`npm run hooks:install`)". That is
  the repo's own author independently arriving at the exact open question
  the last two reviews could only infer from a fresh clone (hook-install
  state isn't checkable from here) — now corroborated by direct in-repo
  evidence that the hook is not reliably firing on the machine that
  autopushes and hand-commits into this leak. No purge has ever been
  attempted against this specific leak — the one purge commit in the repo's
  history (`f0ddcff`) addresses an unrelated 08-07 incident.
- **`docs/current-state-and-phase56.md` is still wrong — sixth review in a
  row flagging it, now eight days past when it was first called a "same-day
  fix."** Line 179 still reads "The live discovery path has never produced a
  job," directly contradicted by the same class of real auto-cycle artifacts
  cited in every review since 08-11. No commit since PR #33 (well before
  08-11) touches this file.
- **L3 armed unattended apply: unchanged, still `FIXTURE_CONFIRMED`.** No new
  auto-cycle artifacts with a live submit found this review; the
  `submits_used: 1`/`per_app`-mismatch artifact (`run-47082d9f`) flagged
  08-13 is unchanged (re-verified: still present, still contradictory) and
  still worth an operator's direct look.
- **`auto:cycle` unattended operating posture: unchanged.** Still a standing
  `.env` + scheduled task, self-arming, no per-run human click, no time-boxed
  re-arm gate. `docs/operator-guide.md` §17b still documents the improvement
  loop as opening AND, "by standing operator grant," merging its own gated
  loop PR unattended (line ~1305) — re-checked this review: every merge
  commit in the git log since 08-15 carries author/committer `skale-07`,
  which is consistent with either a human clicking merge or an
  operator-token-authorized automated merge; commit metadata alone cannot
  distinguish the two, so this stays an open, unconfirmed-either-way item
  rather than a resolved one.
- **Sender-trust magic-link handling: substance unchanged, file touched.**
  `src/gmail/verificationParsers.ts` received a commit this cycle
  (`390c113`, "portal tuning," 08-16) — diffed directly: it only hardens
  the *OTP-code* extractor (rejects digit runs that are an email
  local-part, breaks keyword-score ties by later-in-document position), and
  does not touch `extractMagicLink`. The function itself, and its
  documented design (domain affinity to the sender/allowlist is a *ranking
  boost*, not a filter; the hard rejects are non-https and
  unsubscribe/footer-pattern links only) are unchanged from what previous
  reviews described. Last substantive touch to the magic-link qualifier
  logic remains `a4f9cd8` (2026-08-12).
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  silent multi-ATS expansion beyond what's now wired, replacing any
  deterministic adapter with an LLM agent as the default path, loosening L3's
  numeric caps.
- **Next up, in priority order, unchanged from 08-17 because none of it has
  been done — now with the hook-install question independently corroborated
  by the repo's own commit log (see above), which makes it the most
  actionable half of item (1):** (1) confirm `npm run hooks:install` is
  actually run on the machine that autopushes/tunes (this review found
  direct evidence it may not be), fix `src/security/artifactScan.ts:26`'s
  regex to match `resume-*.pdf`, add a `materials/` exclusion to
  `artifactAutopush.ts:53`, then purge the (now 366-path) leak from
  history — still the single most overdue action item across both repos,
  now five review cycles running without being picked up; (2) fix
  `current-state-and-phase56.md`; (3) resolve the `submits_used: 1`/`per_app`
  inconsistency with an operator; (4) live-DOM proof for Lever, Ashby,
  Workday, Workable, and generic; (5) a decision on tightening sender-trust
  domain affinity from ranking-boost to filter.

Deeper detail (in `skale-07/jobright-application-agent`, not this repo):
[`docs/architecture.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/architecture.md) ·
[`docs/current-state-and-phase56.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/current-state-and-phase56.md) ·
[`docs/operator-guide.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/operator-guide.md) ·
[`docs/ats-adapters-lever-ashby.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/ats-adapters-lever-ashby.md) ·
[`docs/ats-adapter-workday.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/ats-adapter-workday.md) ·
[`docs/known-limitations.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/known-limitations.md) ·
[`docs/validation-levels.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/validation-levels.md)

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
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass, joined by an experience-distinctiveness judge (routing boost only), a recruiter-label/tier judge, and — **newly merged this review cycle (PR #6, was unmerged since 08-13)** — an age-relative-impressiveness judge plus an obscurity multiplier.
- **First code change landed in six review cycles.** PR #6
  (`claude/talent-discovery-pipeline-bfunzx`) merged to `main` on 2026-08-18,
  30 files / +2345/-15: the award registry (`reference/awards-registry.yaml`,
  `src/awards/awardRegistry.ts`), an obscurity-multiplier + age-relative-stage
  scoring module (`src/scoring/computeObscurity.ts`,
  `src/assessment/judges/ageRelativeJudge.ts`,
  `src/assessment/stage/deriveStage.ts`), a seed-source refresh script
  (`src/seeds/refreshSeeds.ts` + `manualCohortSource.ts`/`rosterSource.ts`),
  new digest-render fields, UI ranking dials (`ReportsPanel.tsx`), and a
  LinkedIn-extractor change bumping `PROFILE_SCRAPE_VERSION` 9→10 to capture
  the stated connection count as an "undiscoveredness" signal
  (`parseConnectionCount` in `linkedinExtract.ts`). Diffed the LinkedIn
  change directly: it adds one more read (`section.innerText()`) inside the
  existing paced per-profile extraction call, still gated by the same
  `LINKEDIN_DELAY_MS` sleep before/after — no new unpaced scrape path.
- **Safety-flag layer — unchanged.** `CLAUDE.md` documents fail-closed
  boundaries in prose; PR #6 did not touch `CLAUDE.md` or add a
  forbidden-API checker — there is still no repo-wide `*_ENABLED` naming
  convention comparable to jobright's CI-enforced `check:forbidden`.
- **Verify gate this review:** `npm run typecheck` clean, `npm run test`:
  **222/222 passing across 38 files** (up from 186/36 on 08-17 — the new
  tests are PR #6's `tests/scoring/awardsAndSeeds.test.ts` and
  `tests/scoring/obscurityAndStage.test.ts`, both re-run directly and
  green). Repo is not currently broken.

### 2.3 Technical direction

- **PII history exposure: unchanged, still critical, still unpurged — seventh
  review in a row confirming it.** Re-verified directly again this review:
  `git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves, and
  the blob still contains a real person's full name, LinkedIn URL, photo CDN
  URL, school, and degree. No `filter-repo`/BFG commit exists anywhere in
  `git log --all`. Current tree stays clean (`.gitignore` covers `profiles/`,
  `backup/`, `data/`, `cache/`, `output/`, confirmed unchanged this review,
  and PR #6 didn't touch it), which bounds new exposure but does nothing for
  what's already public in history.
- **Ownership-share fix and mid-run LinkedIn auth-guard: still holding.**
  `tests/assessment/ownership.test.ts` and `tests/linkedin/authGuard.test.ts`
  both confirmed still present this review, neither touched by PR #6 — the
  two risks resolved 08-10/08-11 have not regressed.
- **Everything else in this section: unchanged since 08-13**, since PR #6's
  scope was scoring/UI, not the digest loop, LinkedIn scrape-failure
  handling, or auto-assess default. Digest feedback loop/oracle/autopilot,
  the open product question on global-vs-per-seed digest ranking and
  Substack-only filtering, zero retry/trace/screenshot capture on LinkedIn
  scrape failures, and auto-assess-by-default all carry forward unchanged.
- Zero open issues, zero open PRs at time of this review (PR #6, the last
  open one, is now merged).

Deeper detail (in this repo): [`docs/implementation-prompt.md`](./implementation-prompt.md) ·
[`docs/all-agents-wiring-verification.md`](./all-agents-wiring-verification.md) ·
[`docs/email-digest-implementation-context.md`](./email-digest-implementation-context.md) ·
[`docs/system-brief.md`](./system-brief.md) (generated, Tier 0 oracle context)

---

## 3. How the two projects relate

jobright-application-agent is a **hardened descendant** of tSearch's session/
scraping infrastructure, not an unrelated project. `docs/tsearch-reuse-map.md`
(**jobright repo**, not this one) records the original reuse plan: tSearch's
`saveSession.ts` / `linkedinBrowser.ts` concepts (manual storageState login,
lazy session open/validate) and atomic-JSON-store pattern were the seed for
jobright's `ServiceSession` and `src/storage/` layers, explicitly rebuilt with
more hardening (coverage statuses, mid-run auth checks — matched on
tSearch's side too, see §2.2 — traces/screenshots, no committed profile
artifacts, a design choice tSearch has also adopted going forward per
§2.2, though not retroactively into history per §4). tSearch's product
logic — olympiad scoring, GitHub graph expansion, the seed-tree UI — was
deliberately **not** ported; the two products solve different problems
(apply vs. discover) and share only the "safely drive a browser session
against a third-party site" substrate.

**Both repos still share the same unresolved shape of risk: a personal/PII
document exposure on a public repo, found and re-confirmed unpurged across
multiple review cycles, with the underlying automation in jobright's case
still capable of adding more.** tSearch's is third-party LinkedIn PII in
history only (current tree is clean, and the count is stable — no new
commits since 08-13); jobright's is the operator's own resume PDFs, still
actively growing with every automation cycle (366 files now vs. 327 two days
ago) and — new this review — with direct evidence the local safety-net
hook isn't reliably catching what lands on the machine that keeps adding to
it. That keeps jobright's the more urgent of the two: it is the one still
getting worse in real time, and this review found the first concrete clue
as to the actual mechanism, not just the symptom. Both repos also carry a
genuinely unattended, scheduled-automation surface — jobright's `auto:cycle`
(§1.3, real submissions possible, plus the still-unconfirmed
standing-grant self-merge) and tSearch's autopilot (§2.3, fail-closed to
mock/dry-run by default) — worth watching as a shared pattern, since a
gating bug in either would look similar from the outside (a scheduled task
silently doing something consequential).

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
| **Critical** | jobright | **Fifth consecutive review finding this unfixed and worse, now with direct evidence of cause.** `ARTIFACT_AUTOPUSH_ENABLED` plus manual operator commits continue pushing the operator's real resume PDFs to this public repo: 39 more paths landed since 08-17 (commit `29b02cf`, a manual "tuning" commit, not autopush), bringing the total to **366 leaked `materials/resume-*.pdf` paths** (up from 327 on 08-17, 308 on 08-15). `src/security/artifactScan.ts:26`'s regex (`/resume\.pdf$/i`) still does not match the actual filenames — verified unchanged. `src/automation/artifactAutopush.ts:53` still has no `materials/` exclusion in its `git add -A` — verified unchanged. **New this review**: commit `eb4a999`'s own message documents a corrupted binary fixture that slipped past the pre-commit hook and broke `check:secrets` on `master` — first-party evidence the local hook isn't reliably firing on the machine responsible for this leak. No purge has ever been attempted against this specific leak. | This is now the single longest-standing, actively-worsening item across both repos, and this review found the likely root cause of *why* it's worsening rather than just documenting that it is: a hook that isn't consistently running. The fix is small and well-specified (fix one regex, add one path exclusion, confirm `npm run hooks:install` on the actual autopushing/tuning machine, then purge history) and has been specified identically for five review cycles running without being picked up. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII (name, LinkedIn URL, photo URL, school, degree) is untracked from the current tree but still fully present and fetchable in git history on this public repo — re-verified directly this review (`git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves). No purge has been attempted since the finding was first raised. | Seventh review in a row confirming this is unchanged: a live public exposure of real third-party people's data, not a hypothetical. `git filter-repo`/BFG + force-push + collaborator re-clone is still the concrete, unexecuted unblock. |
| **High** | jobright | `docs/current-state-and-phase56.md` remains actively contradicted by the repo's own committed artifacts (it still says live discovery "has never produced a job"). Sixth review in a row flagging this, now eight days past when it was first called a "same-day fix." | An operator or future agent trusting this doc would materially misjudge the product's current state. The fix is a doc edit, not new code. |
| **High** | jobright | `auto:cycle` + a standing `.env` + a scheduled task remains a genuinely unattended fill-and-submit operating mode with no per-run human click and no time-boxed re-arm gate, unchanged since 08-11. `operator-guide.md` §17b also documents the improvement loop as capable of merging its own gated PR under a "standing operator grant" — commit authorship (`skale-07` on every merge) cannot confirm or rule this out. Realized submission risk stays bounded (no confirmed live submit yet). | Two open, deliberate product decisions bundled in one surface: whether unattended real-submission automation needs an additional standing-authorization gate, and whether the loop's PR-merge step is actually human-in-the-loop or self-authorizing. |
| **High** | jobright | Sender-trust magic-link handling remains a keyword-match-plus-ranking-boost qualifier with no hard sender-domain-affinity requirement; the browser still navigates to the top-scoring link using the operator's authenticated session. The file received an unrelated OTP-only tuning commit this cycle (08-16); the magic-link qualifier itself is unchanged since `a4f9cd8` (08-12). | Still a genuine, code-verified phishing-surface widening with no decision made yet on tightening it. |
| **Medium** | jobright | Lever, Ashby, Workday, Workable, and generic are all wired but unverified against real DOM — no live-DOM progress on any of them since 08-11. | The live-proof backlog isn't shrinking; the honest `UNVERIFIED_SELECTOR` labeling is good discipline but doesn't reduce the backlog itself. |
| **Medium** | tSearch | No fail-closed safety-flag *enforcement* — `CLAUDE.md` documents boundaries in prose but there is still no forbidden-API checker or `*_ENABLED` naming convention comparable to jobright's CI-enforced `check:forbidden`. PR #6 (the first code change in six cycles) didn't touch this. Unchanged since 08-11. | A future change could silently violate the frozen-candidates-snapshot or `final_score`/`priority_score` separation invariants and nothing in CI would catch it. |
| **Medium** | tSearch | `tsearch-playwright-system-audit.md` remaining items unchanged: zero retry/trace/screenshot capture on scrape failures; captured country still never used to reject homonym mismatches. PR #6's LinkedIn-extractor change (connection-count capture) didn't touch this. | Wrong-person matches can still silently enter the candidate graph; live failures are still hard to diagnose after the fact. |
| **Low** | jobright | An older run artifact (`run-47082d9f`, 2026-08-08) still shows `submits_used: 1` at the top level while all 7 of its `per_app` entries show `submitted: false`/`FAILED_RETRYABLE` — an internal inconsistency, not a confirmed live submit. Unchanged since 08-13, re-verified present this review. | Doesn't change L3's overall `FIXTURE_CONFIRMED` status, but a validation-ladder document should not have an unresolved contradiction sitting in its own evidence. |
| **Low** | tSearch | Auto-assess still runs by default at the end of every pipeline run (`AUTO_ASSESS=0` to opt out). Unchanged since 08-11. | Cost/scope-creep item, not a safety gap. |
| **Low** | tSearch | Digest-loop ranking-*refinement*-from-feedback still unbuilt; global-vs-per-seed and Substack-only-filtering product questions remain unresolved. Unchanged since 08-07. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase 10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |
| **Low** | both | This document itself has now been drafted seven times (08-07, 08-09, 08-11, 08-13, 08-15, 08-17, 08-19) without a single review's version ever being merged to `main`/`master` in either repo. | The living document only helps if someone reads the latest merged copy; right now the "latest" copy is only discoverable by checking unmerged review branches, which is exactly the failure mode the session-start ritual works around rather than fixes. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **Server-side push protection, with a feasibility caveat found this
  review.** GitHub's secret-scanning push protection is free and on by
  default for *public* repos (both repos here qualify), which is what makes
  this backstop attractive regardless of local-hook state. However, this
  review's research turned up a real caveat the prior five reviews didn't
  check: **custom** secret-scanning patterns (needed here, since the leak
  pattern is `materials/resume-<hash>\.pdf$`, not a built-in credential
  shape) are configured at the organization or enterprise level in GitHub's
  UI/docs, which doesn't map cleanly onto a personal-account public repo —
  worth the operator confirming custom-pattern configuration is actually
  reachable from Settings on a personal repo before counting on it as the
  fix. A `.gitleaks.toml` path rule doing the same in CI remains the
  complementary, definitely-available carried-over recommendation.
  https://docs.github.com/en/code-security/secret-scanning/using-advanced-secret-scanning-and-push-protection-features/custom-patterns/defining-custom-patterns-for-secret-scanning
- **Human-oversight-by-design browser-agent patterns** (e.g. Asteroid,
  Straiker's runtime guardrails for agentic browsers) — carried over, still
  directly relevant to the unresolved `auto:cycle` posture question in §4.
- **CDP session-handoff discipline** — carried over, still relevant now that
  the console, the nav-layer sidecar, the local sandbox, and `auto:cycle`
  can all potentially want the same CDP Chrome instance.

**tSearch**

- **`git filter-repo` / BFG history purge, executed, not just planned** —
  repeated for the seventh review in a row. This review's tooling check
  confirms `git filter-repo` (not BFG) is the right choice specifically
  because both leaks are path-scoped (`profiles/` here, `materials/` in
  jobright): BFG's documented weak point is that it can't target files by
  directory path, only by filename/glob, which matters for a path-shaped
  leak like this one. Kept here deliberately so it doesn't quietly stop
  being said just because it's been said before.
- **GitHub push protection with a custom secret-scanning pattern** matching
  the scraped-profile JSON shape (name + LinkedIn URL + photo URL) — pairs
  with the history purge as a recurrence-prevention measure at push time;
  same organization/personal-account caveat noted above applies here too.
- **Krippendorff's alpha for judge-panel calibration, with concrete
  thresholds** — carried over from 08-15, still unimplemented and still
  directly actionable: sample 100–300 traces, have 2–3 humans label them,
  compute Krippendorff's alpha (below 0.4 = rubric needs a rewrite, 0.4–0.6
  = weak but tunable, above 0.6 = acceptable, above 0.8 = strong), paired
  with position-bias measurement (run each comparison twice with the
  candidate's material in each slot, flag verdicts that flip on order
  alone). More relevant than ever now that PR #6 added a sixth judge
  (age-relative/obscurity) to the panel with no measured agreement or bias
  number for any of them.

---

## Changelog

- **2026-08-19** — Seventh review (this one). Baselined against the unmerged
  2026-08-17 draft (`claude/epic-pasteur-kr7842` / `claude/busy-clarke-kr7842`)
  per the session-start-ritual instruction, then independently re-verified
  every carried-forward claim against current `HEAD` in both repos.
  **Resume-PDF leak (jobright) confirmed worse for the fifth review
  running**: 366 paths now (327 on 08-17), traced to one manual "tuning"
  commit (`29b02cf`) rather than an autopush-tagged one — meaning the leak
  isn't solely the autopush code path's doing. **New finding this review**:
  commit `eb4a999`'s own message documents a corrupted fixture that slipped
  past the local pre-commit hook and broke `check:secrets` on `master`,
  independently corroborating what the last two reviews could only infer
  (hook-install state on the autopushing machine is suspect) — this is now
  first-party evidence, not an inference from a fresh clone's inability to
  check local hook state. **tSearch's PII-history exposure re-verified
  unpurged for the seventh review in a row** (direct `git cat-file` read of
  the same still-reachable blob). `docs/current-state-and-phase56.md` still
  wrong, sixth review flagging it. tSearch saw its **first code change in
  six review cycles**: PR #6 (award registry, obscurity/age-relative
  scoring, seed-source refresh, UI ranking dials, LinkedIn connection-count
  capture) merged 08-18 — diffed the LinkedIn-extractor change directly,
  confirmed it adds one more read inside the existing paced call, no new
  unpaced scrape path; safety-flag-layer gap and PII-history exposure
  unaffected by this PR. jobright saw a continued feature wave (a revert,
  essay-grounding-in-posting-context, insider-triage expansion, outreach
  v2 + Gmail drafts, a third LLM provider, and rename-prep) — diffed all
  seven commits directly for touches to the safety-flag list or submit
  gating; none touch either. Verify gates this review, all re-run directly
  rather than assumed: tSearch 222/222 tests passing (up from 186), typecheck
  clean; jobright typecheck clean, `check:forbidden`/`check:secrets` both
  `ok`, 895/1102 tests passing with the remaining 199 traced to the same
  missing-browser-binary environment gap seen in the last three reviews.
  Both repos: zero open issues, zero open PRs. This review's external scan
  found a feasibility caveat on the previously-recommended GitHub custom
  secret-scanning pattern (org/enterprise-level configuration, uncertain fit
  for a personal-account public repo) and confirmed `git filter-repo` over
  BFG specifically because both leaks are path-scoped. Pushed to each
  repo's designated review branch (`claude/busy-clarke-purjf5` jobright,
  `claude/epic-pasteur-purjf5` tSearch) — same unmerged-branch pattern as
  the last six reviews; whoever merges these into `main`/`master` should do
  so deliberately, not assume it already happened because this entry says
  "review."
- **2026-08-17** — Sixth review (drafted on `claude/epic-pasteur-kr7842`,
  never merged — used as this review's baseline). Baselined against the
  unmerged 2026-08-15 draft. **Resume-PDF leak (jobright) confirmed worse
  for the fourth review running**: 327 unique files now (308 on 08-15, 187
  on 08-13), traced to three specific new commits since 08-15 (`b53b0bb`,
  `edb0133`, `f005c4d`); both root-cause code locations (`artifactScan.ts:26`,
  `artifactAutopush.ts:53`) re-verified unchanged at the same line numbers.
  tSearch's PII-history exposure re-verified unpurged for the sixth review
  in a row. `docs/current-state-and-phase56.md` still wrong, fifth review
  flagging it. Zero commits landed anywhere in tSearch since 08-15. jobright
  saw a real feature wave (PRs #49–#54). Verify gates: tSearch 186/186
  passing, typecheck clean; jobright typecheck clean, `check:forbidden`/
  `check:secrets` both `ok`, 873/1066 tests passing. Both repos: zero open
  issues, zero open PRs.
- **2026-08-15** — Fifth review (drafted on `claude/epic-pasteur-kz1f9y`,
  never merged). Baselined against the unmerged 2026-08-13 draft.
  **Resume-PDF leak (jobright) confirmed worse for the third review
  running**: 308 unique files (187 on 08-13, 183 on 08-11). tSearch's
  PII-history exposure re-verified unpurged for the fifth review in a row.
  `docs/current-state-and-phase56.md` still wrong, fourth review flagging
  it. Zero commits landed anywhere in tSearch since 08-13. jobright saw a
  legitimate feature wave (PRs #42–#48). Verify gates: tSearch 186/186,
  typecheck clean; jobright typecheck clean, 791/960 tests passing. Both
  repos: zero open issues, zero open PRs.
- **2026-08-13** — Fourth review (drafted on `claude/epic-pasteur-559fdc`,
  never merged). Baselined against the unmerged 2026-08-11 draft. Found the
  Critical resume-PDF leak escalated rather than fixed (183 → 187 files) and
  found a second, independent cause: the secret-scanner's regex doesn't
  match the actual leaked filenames even when the hook runs. tSearch:
  PII-history exposure re-confirmed unchanged (fourth review); two new
  feature commits on an unmerged branch (obscurity/age-relative scoring,
  award registry) reviewed clean. Both repos: zero open issues, zero open
  PRs.
- **2026-08-11** — Third review (drafted on `claude/epic-pasteur-by0hjn`,
  never merged). Baselined against the unmerged 2026-08-09 draft. tSearch:
  verified two previously-flagged risks genuinely resolved (ownership-share
  bug, mid-run auth guard); verified the PII-history risk unchanged; found
  one new low-severity risk (auto-assess on by default). jobright: found the
  discovery-status doc question had flipped from "ambiguous" to "actively
  contradicted"; found L3 still not graduated past `FIXTURE_CONFIRMED`;
  found two new High risks (`auto:cycle` unattended-scheduling posture,
  sender-trust magic-link loosening). **Mid-review, discovered a second
  Critical finding while preparing to commit this doc update**: jobright's
  `art:`-autopush automation had been committing the operator's real resume
  PDFs to this public repo since 2026-08-08 (183 copies, 11 commits, missed
  by all three prior reviews) — the pre-commit hook was never installed.
  Both repos: zero open issues, zero open PRs.
- **2026-08-09** — Second review (drafted on `claude/epic-pasteur-27u1xf` /
  `claude/busy-clarke-27u1xf`, never merged). tSearch: zero commits since
  2026-08-07 beyond the vision-doc merge itself; §2 reconfirmed unchanged.
  jobright: large feature wave landed (Lever/Ashby wiring, navigation layer,
  operator console, L3 armed automation, screener answer-bank, essay draft
  assistant, telemetry export, branding/site) — §1 rewritten. Surfaced the
  discovery-status doc disagreement (since escalated, see above). Both
  repos: zero open issues, zero open PRs.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state (both repos: zero open
  issues, zero open PRs). Verified the critical PII/public-repo finding
  directly (`git ls-files`, file content, repo visibility) rather than
  relying solely on subagent report.
