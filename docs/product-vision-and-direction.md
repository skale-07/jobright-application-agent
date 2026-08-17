# Product vision & technical direction — jobright-application-agent + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/tSearch`
— keep both files identical when editing. This is a **living document**,
refreshed by a scheduled review. It is not a proof log or a phase-status doc
(those already exist per-repo — see the "Deeper detail" links below) — it
exists so both projects' vision, architecture, and direction stay legible
from one place, and so risks that only show up when you look at *both*
repos together (shared lineage, shared operator, shared data-handling
posture) don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-08-17 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**), `skale-07/tSearch` (**public**) |

**Note on provenance**: the most recent copy merged to `main`/`master` in
either repo is still the 2026-08-07 original — five subsequent reviews
(08-09, 08-11, 08-13, 08-15, and this one) were drafted on unmerged
`claude/*-*` branches and never landed. Per the session-start-ritual
instruction to check those branches for a fresher copy, this review
baselines on the 2026-08-15 draft (`claude/epic-pasteur-kz1f9y` /
`claude/busy-clarke-kz1f9y`, the most recent) and reconciles it against
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
second surface: an **operator console** ("Dispatch") that lets a human run,
watch, and approve the pipeline from a browser instead of the CLI, plus an
opt-in **L3 armed mode** that removes per-application confirmation only
inside a timed, capped, operator-initiated window — never the underlying
safety gates.

**This review's central finding, again: the Critical resume-PDF exposure
first flagged 08-11 is now on its fourth consecutive review cycle without a
fix, and it is still growing — 308 leaked files on 08-15, 327 today.** See
§4, first row, for the full picture. This is no longer a one-off miss; it is
a standing gap in the product's own safety net, and the automation that
keeps adding to it (autopush) is still running on every cycle unmodified.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI (multiple gated call sites) / Express + React console frontend.
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`) exportable via `npm run training:export`. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (full list in `CLAUDE.md`). `chromium.launch` is confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Free-text/essay and demographic fields are architecturally incapable of being auto-filled — they route to `review_items`; `ESSAY_DRAFT_ENABLED` may generate a SUGGESTION into that review item, and `ESSAY_AUTOFILL_ENABLED` may fill directly from `private/candidate/about-me.md` under the same `validateDraft` checks, with every generated answer recorded on the plan entry.
- **Feature wave since 08-15 — verified clean.** Six merged PRs (#49–#54), all zero open issues / zero open PRs at time of review: unstarving the predictive tiers with grouped questions and richer option surfacing (#49); a loopback-only local sandbox (`npm run sandbox`, port 4599, zero external deps) the operator can drive with the real CLI to watch fill behavior directly instead of trusting unit-test mocks (#50); a "hard mode" sandbox course plus a Resend-backed emailed-code wall for testing OTP recovery (#51); type-aware control resolution fixing a label-collision bug where a URL answer was being written into an unrelated checkbox, plus removal of 30s ghost waits (#52); restoring submit-path OTP recovery for the pure-emailed-code-wall case without loosening the password-present refusal — spot-checked directly, `isEmailedCodeWallOnly` still requires *no* password-input signal and new tests pin that boundary (#53); and predictor bank pruning to stop the saved-answer payload growing unbounded, explicitly fail-open and deliberately not routed through a second LLM call per operator directive 2026-08-17 (#54). Spot-checked #50 and #53 directly for gate integrity: the sandbox is loopback-only and driven through the existing `ats:fill --execute` gated CLI path, and the OTP fix touches only `submitRun.ts`'s wall-classification branch, not `FORM_FILL_ENABLED`/`SUBMIT_ENABLED`/`assertExecutableApprovedEntry`. None of the six touch the safety-flag list or submit gating.
- **ATS coverage today: unchanged since 08-11.** Greenhouse (inspect/fill/submit shipped, `FIXTURE_CONFIRMED`, live paths `UNVERIFIED`). Lever, Ashby, Workday, Workable all wired end-to-end but still `UNVERIFIED (wired, never run)` / `UNVERIFIED_SELECTOR` — verified no commit since 08-15 touched `docs/known-limitations.md`, `docs/ats-adapters-lever-ashby.md`, or `docs/ats-adapter-workday.md`. Generic is first-class (since 08-13, PR #42).
- **Verify gate this review, all re-run directly on current `HEAD` (`8d28a1a`), not assumed:** `npm run typecheck` clean. `npm run check:forbidden` and `npm run check:secrets` both `ok`. `npm run test`: **873 passed / 185 failed / 8 skipped across 1066 tests in 113 files** (up from 791/960 on 08-15 — the growth tracks the new feature-wave tests). Every failure traces to the same single cause as the last two reviews: `chrome-headless-shell` isn't installed at this sandbox's Playwright browser path. This time verified more than the top-line count — checked the handful of failures whose assertion diffs *don't* literally say "browserType.launch": they're all downstream of the same root cause (navigation classification falls back to the generic `NAVIGATION_FAILURE` code instead of the specific expected one — `GREENHOUSE_APPLICATION_UNAVAILABLE`, `LOGIN_WALL`, `APPLICATION_CLOSED` — because the real browser launch that would produce the specific signal never happens). Not evidence of a code regression; claim remains `UNVERIFIED` for anything touching a real browser launch until re-run in an environment with the binary present.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **Resume-PDF leak: fourth review running, still unresolved, still growing.**
  Verified directly against current `HEAD` (`8d28a1a`): (a) **327 unique
  `materials/resume-*.pdf` files** are now reachable from `HEAD` (up from 308
  on 08-15, 187 on 08-13, 183 on 08-11) — 20 net-new files added since 08-15
  by three specific commits (`b53b0bb` "artifact push", `edb0133` and
  `f005c4d`, both "art: automation session ... (autopush)"), confirmed by
  diffing the tracked file list directly rather than trusting the delta; (b)
  no purge has ever been attempted against this specific leak — the one
  purge commit in the repo's history (`f0ddcff`) addresses an unrelated
  08-07 incident; (c) `src/automation/artifactAutopush.ts:53` still runs a
  blanket `git("add", "-A", "--", "artifacts")` with no `materials/`
  exclusion — confirmed unchanged, same line number as the last two
  reviews — so it will keep adding to this on every future autopush cycle;
  (d) `src/security/artifactScan.ts:26`'s pattern is still `/resume\.pdf$/i`,
  confirmed unchanged, same line — which still does not match the actual
  filenames (`resume-<hash>.pdf`). Note on verification scope: this session
  runs from a fresh clone, so local `.git/hooks/pre-commit` / `core.hooksPath`
  state on the operator's actual machine isn't independently checkable from
  here (a fresh clone never carries hooks either way) — but that's moot for
  diagnosing the leak, since (c) and (d) are sufficient on their own to
  explain why it keeps growing regardless of whether the hook is installed
  anywhere: even a locally-run hook using today's regex would not catch a
  single one of these files.
- **`docs/current-state-and-phase56.md` is still wrong — fifth review in a
  row flagging it, now six days past when it was first called a "same-day
  fix."** Line 179 still reads "The live discovery path has never produced a
  job," directly contradicted by the same class of real auto-cycle artifacts
  cited in every review since 08-11. No commit since PR #33 (well before
  08-11) touches this file.
- **L3 armed unattended apply: unchanged, still `FIXTURE_CONFIRMED`.** No new
  auto-cycle artifacts with a live submit found this review; the
  `submits_used: 1`/`per_app`-mismatch artifact flagged 08-13 is unchanged
  and still worth an operator's direct look.
- **`auto:cycle` unattended operating posture: unchanged.** Still a standing
  `.env` + scheduled task, self-arming, no per-run human click, no time-boxed
  re-arm gate.
- **Sender-trust magic-link handling: unchanged**, last touched `a4f9cd8`
  (2026-08-12), before the 08-13 baseline.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  silent multi-ATS expansion beyond what's now wired, replacing any
  deterministic adapter with an LLM agent as the default path, loosening L3's
  numeric caps.
- **Next up, in priority order, unchanged from 08-15 because none of it has
  been done:** (1) fix `src/security/artifactScan.ts:26`'s regex to match
  `resume-*.pdf`, add a `materials/` exclusion to
  `artifactAutopush.ts:53`, confirm `npm run hooks:install` is actually run
  on the machine that autopushes, then purge the (now 327-file) leak from
  history — still the single most overdue action item across both repos,
  and the gap between "known" and "fixed" is now measured in a growing leak
  count across five review cycles, not just elapsed days; (2) fix
  `current-state-and-phase56.md`; (3) resolve the `submits_used: 1`/`per_app`
  inconsistency with an operator; (4) live-DOM proof for Lever, Ashby,
  Workday, Workable, and generic; (5) a decision on tightening sender-trust
  domain affinity.

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
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass, joined by an experience-distinctiveness judge (routing boost only), a recruiter-label/tier judge, and (on an unmerged branch, unchanged since 08-13) an age-relative-impressiveness judge plus an obscurity multiplier.
- **Zero commits since the 08-15 review, on any branch, in either repo — sixth review in a row confirming this.**
  Verified with `git log --all --since=2026-08-15` across every ref: nothing
  landed. `claude/talent-discovery-pipeline-bfunzx` (the obscurity/age-relative-judge
  and award-registry work reviewed clean on 08-13) remains unchanged and
  unmerged.
- **Safety-flag layer — unchanged.** `CLAUDE.md` documents fail-closed
  boundaries in prose; there is still no forbidden-API checker or repo-wide
  `*_ENABLED` naming convention comparable to jobright's CI-enforced
  `check:forbidden`.
- **Verify gate this review:** `npm run typecheck` clean, `npm run test`:
  **186/186 passing across 36 files** (re-run directly this review; identical
  to the 08-15 result, as expected since nothing changed). Repo is not
  currently broken.

### 2.3 Technical direction

- **PII history exposure: unchanged, still critical, still unpurged — sixth
  review in a row confirming it.** Re-verified directly again this review:
  `git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves, and
  the blob still contains a real person's full name, LinkedIn URL, photo CDN
  URL, school, and degree. No `filter-repo`/BFG commit exists anywhere in
  `git log --all`. Current tree stays clean (`.gitignore` covers `profiles/`,
  `backup/`, `data/`, `cache/`, `output/`, confirmed unchanged this review),
  which bounds new exposure but does nothing for what's already public in
  history.
- **Ownership-share fix and mid-run LinkedIn auth-guard: still holding.**
  `tests/assessment/ownership.test.ts` and `tests/linkedin/authGuard.test.ts`
  both confirmed still present this review — the two risks resolved 08-10/08-11
  have not regressed (trivially true this cycle, since nothing changed).
- **Everything else in this section: unchanged since 08-13**, because zero
  commits have landed anywhere in the repo since then. Digest feedback
  loop/oracle/autopilot, the open product question on global-vs-per-seed
  digest ranking and Substack-only filtering, zero retry/trace/screenshot
  capture on LinkedIn scrape failures, and auto-assess-by-default all carry
  forward unchanged.
- Zero open issues, zero open PRs at time of this review.

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
actively growing with every automation cycle (327 files now vs. 308 two days
ago) — which keeps jobright's the more urgent of the two, since it is the
one still getting worse in real time while tSearch's has simply gone
unaddressed. Both repos also carry a genuinely unattended, scheduled-automation
surface — jobright's `auto:cycle` (§1.3, real submissions possible) and
tSearch's autopilot (§2.3, fail-closed to mock/dry-run by default) — worth
watching as a shared pattern, since a gating bug in either would look similar
from the outside (a scheduled task silently doing something consequential).

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
| **Critical** | jobright | **Fourth consecutive review finding this unfixed and worse.** `ARTIFACT_AUTOPUSH_ENABLED` continues pushing the operator's real resume PDFs to this public repo: 3 more autopush/manual-artifact commits landed since 08-15 (`b53b0bb`, `edb0133`, `f005c4d`), bringing the total to **327 unique leaked resume PDFs** (up from 308 on 08-15, 187 on 08-13, 183 on 08-11). `src/security/artifactScan.ts:26`'s regex (`/resume\.pdf$/i`) still does not match the actual filenames (`resume-<hash>.pdf`) — verified unchanged. `src/automation/artifactAutopush.ts:53` still has no `materials/` exclusion in its `git add -A` — verified unchanged. No purge has ever been attempted against this specific leak. | This is now the single longest-standing, actively-worsening item across both repos. The fix is small and well-specified (fix one regex, add one path exclusion, confirm the pre-commit hook is actually installed on the autopushing machine, then purge history) and has been specified identically for four review cycles running without being picked up. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII (name, LinkedIn URL, photo URL, school, degree) is untracked from the current tree but still fully present and fetchable in git history on this public repo — re-verified directly this review (`git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves). No purge has been attempted since the finding was first raised. | Sixth review in a row confirming this is unchanged: a live public exposure of real third-party people's data, not a hypothetical. `git filter-repo`/BFG + force-push + collaborator re-clone is still the concrete, unexecuted unblock. |
| **High** | jobright | `docs/current-state-and-phase56.md` remains actively contradicted by the repo's own committed artifacts (it still says live discovery "has never produced a job"). Fifth review in a row flagging this, now six days past when it was first called a "same-day fix." | An operator or future agent trusting this doc would materially misjudge the product's current state. The fix is a doc edit, not new code. |
| **High** | jobright | `auto:cycle` + a standing `.env` + a scheduled task remains a genuinely unattended fill-and-submit operating mode with no per-run human click and no time-boxed re-arm gate, unchanged since 08-11. Realized risk stays bounded (no confirmed live submit yet), but the capability is armed and intended for regular use. | Still an open, deliberate product decision: whether unattended real-submission automation needs an additional standing-authorization gate before being treated as normal operation. |
| **High** | jobright | Sender-trust magic-link handling remains a keyword-match-only qualification with no sender-domain-affinity requirement; the browser still navigates to matching links using the operator's authenticated session. Unchanged since `a4f9cd8` (08-12). | Still a genuine, code-verified phishing-surface widening with no decision made yet on tightening it. |
| **Medium** | jobright | `operator-guide.md`'s claim that the improvement loop autonomously merges its own gated PR remains unsupported by anything in-repo. Unchanged, still unconfirmed either way. | Needs a direct operator confirmation — "agent proposes" vs. "agent unattendedly merges to its own safety-relevant codebase" are very different risk profiles. |
| **Medium** | jobright | Lever, Ashby, Workday, Workable, and generic are all wired but unverified against real DOM — no live-DOM progress on any of them since 08-11. | The live-proof backlog isn't shrinking; the honest `UNVERIFIED_SELECTOR` labeling is good discipline but doesn't reduce the backlog itself. |
| **Medium** | tSearch | No fail-closed safety-flag *enforcement* — `CLAUDE.md` documents boundaries in prose but there is still no forbidden-API checker or `*_ENABLED` naming convention comparable to jobright's CI-enforced `check:forbidden`. Unchanged since 08-11. | A future change could silently violate the frozen-candidates-snapshot or `final_score`/`priority_score` separation invariants and nothing in CI would catch it. |
| **Medium** | tSearch | `tsearch-playwright-system-audit.md` remaining items unchanged: zero retry/trace/screenshot capture on scrape failures; captured country still never used to reject homonym mismatches. | Wrong-person matches can still silently enter the candidate graph; live failures are still hard to diagnose after the fact. |
| **Low** | jobright | An older run artifact (`run-47082d9f`, 2026-08-08) still shows `submits_used: 1` at the top level while all 7 of its `per_app` entries show `submitted: false`/`FAILED_RETRYABLE` — an internal inconsistency, not a confirmed live submit. Unchanged since 08-13. | Doesn't change L3's overall `FIXTURE_CONFIRMED` status, but a validation-ladder document should not have an unresolved contradiction sitting in its own evidence. |
| **Low** | tSearch | Auto-assess still runs by default at the end of every pipeline run (`AUTO_ASSESS=0` to opt out). Unchanged since 08-11. | Cost/scope-creep item, not a safety gap. |
| **Low** | tSearch | Digest-loop ranking-*refinement*-from-feedback still unbuilt; global-vs-per-seed and Substack-only-filtering product questions remain unresolved. Unchanged since 08-07. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase 10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |
| **Low** | both | This document itself has now been drafted six times (08-07, 08-09, 08-11, 08-13, 08-15, 08-17) without a single review's version ever being merged to `main`/`master` in either repo. | The living document only helps if someone reads the latest merged copy; right now the "latest" copy is only discoverable by checking unmerged review branches, which is exactly the failure mode the session-start ritual works around rather than fixes. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **Server-side push protection as a backstop that doesn't depend on the
  local hook ever being installed** — this review's leak analysis found the
  local pre-commit path isn't independently verifiable from a fresh clone,
  which is itself telling: a fix that only works if a specific developer
  machine has `npm run hooks:install` run on it is fragile by construction.
  GitHub's own secret-scanning push protection (GA, expanding detector
  coverage through 2026) can carry a custom pattern for the `materials/.*\.pdf$`
  path shape and blocks the push server-side regardless of local hook state
  — a strictly stronger backstop than the current design, and independent of
  whether the regex or hook fix ever lands. A `.gitleaks.toml` path rule
  doing the same in CI remains the complementary carried-over recommendation
  from prior reviews. https://docs.github.com/en/code-security/concepts/secret-security/push-protection
- **Human-oversight-by-design browser-agent patterns** (e.g. Asteroid,
  Straiker's runtime guardrails for agentic browsers) — carried over, still
  directly relevant to the unresolved `auto:cycle` posture question in §4.
- **CDP session-handoff discipline** — carried over, still relevant now that
  the console, the nav-layer sidecar, the new local sandbox (#50), and
  `auto:cycle` can all potentially want the same CDP Chrome instance.

**tSearch**

- **`git filter-repo` / BFG history purge, executed, not just planned** —
  repeated for the sixth review in a row. Kept here deliberately so it
  doesn't quietly stop being said just because it's been said before.
- **GitHub push protection with a custom secret-scanning pattern** matching
  the scraped-profile JSON shape (name + LinkedIn URL + photo URL) — pairs
  with the history purge as a recurrence-prevention measure at push time,
  and is the same mechanism recommended for jobright above.
- **Krippendorff's alpha for judge-panel calibration, with concrete
  thresholds** — carried over from 08-15, still unimplemented and still
  directly actionable: sample 100–300 traces, have 2–3 humans label them,
  compute Krippendorff's alpha (below 0.4 = rubric needs a rewrite, 0.4–0.6
  = weak but tunable, above 0.6 = acceptable, above 0.8 = strong). A broader
  2026 survey of LLM-as-judge practice adds a second, cheaper-to-adopt
  companion metric worth pairing with it: position-bias measurement (run
  each comparison twice with the candidate's material in each slot, flag
  verdicts that flip on order alone) — relevant here because the panel has
  grown to five judges (technical, writing, experience-distinctiveness,
  recruiter-label, and the unmerged age-relative/obscurity work), and none
  of them have a measured agreement or bias number yet.

---

## Changelog

- **2026-08-17** — Sixth review (this one). Baselined against the unmerged
  2026-08-15 draft (`claude/epic-pasteur-kz1f9y` / `claude/busy-clarke-kz1f9y`)
  per the session-start-ritual instruction, then independently re-verified
  every carried-forward claim against current `HEAD` in both repos.
  **Resume-PDF leak (jobright) confirmed worse for the fourth review
  running**: 327 unique files now (308 on 08-15, 187 on 08-13), traced to
  three specific new commits since 08-15 (`b53b0bb`, `edb0133`, `f005c4d`);
  both root-cause code locations (`artifactScan.ts:26`, `artifactAutopush.ts:53`)
  re-verified unchanged at the same line numbers. Also noted explicitly this
  review: local pre-commit hook install state isn't checkable from this
  session's fresh clone, so that specific sub-claim from prior reviews is
  carried forward as inferred rather than independently re-confirmed — the
  two code-level causes are sufficient on their own to explain the ongoing
  leak regardless. **tSearch's PII-history exposure re-verified unpurged for
  the sixth review in a row** (direct `git cat-file` read of the same
  still-reachable blob). `docs/current-state-and-phase56.md` still wrong,
  fifth review flagging it. Zero commits landed anywhere in tSearch since
  08-15 (in fact since 08-13). jobright saw a real feature wave (PRs
  #49–#54: predictive-tier improvements, a loopback-only operator sandbox,
  hard-mode sandbox courses with an emailed-code wall, type-aware fill fixes,
  restored OTP recovery, predictor bank pruning) — spot-checked #50 and #53
  directly for safety-gate integrity, both clean; none of the six touch the
  safety-flag list or submit gating. Verify gates this review, all re-run
  directly rather than assumed: tSearch 186/186 tests passing, typecheck
  clean; jobright typecheck clean, `check:forbidden`/`check:secrets` both
  `ok`, 873/1066 tests passing with the remaining 185 traced to the same
  missing-browser-binary environment gap seen in the last two reviews — this
  time also checked that failures without a literal browser-launch error
  message are downstream symptoms of the same cause, not independent
  failures. Both repos: zero open issues, zero open PRs. Pushed to each
  repo's designated review branch (`claude/busy-clarke-kr7842` jobright,
  `claude/epic-pasteur-kr7842` tSearch) — same unmerged-branch pattern as
  the last five reviews; whoever merges these into `main`/`master` should do
  so deliberately, not assume it already happened because this entry says
  "review."
- **2026-08-15** — Fifth review (drafted on `claude/epic-pasteur-kz1f9y`,
  never merged — used as this review's baseline). Baselined against the
  unmerged 2026-08-13 draft. **Resume-PDF leak (jobright) confirmed worse
  for the third review running**: 308 unique files (187 on 08-13, 183 on
  08-11), roughly 6 more autopush commits since 08-13, all five named root
  causes verified still present by reading the current file contents
  directly. tSearch's PII-history exposure re-verified unpurged for the
  fifth review in a row. `docs/current-state-and-phase56.md` still wrong,
  fourth review flagging it. Zero commits landed anywhere in tSearch since
  08-13. jobright saw a legitimate feature wave (PRs #42–#48). Verify gates:
  tSearch 186/186, typecheck clean; jobright typecheck clean, 791/960 tests
  passing, remaining 161 traced to the same missing-browser-binary
  environment gap seen 08-13. Both repos: zero open issues, zero open PRs.
- **2026-08-13** — Fourth review (drafted on `claude/epic-pasteur-559fdc`,
  never merged — used as this review's baseline). Baselined against the
  unmerged 2026-08-11 draft. Found the Critical resume-PDF leak escalated
  rather than fixed (183 → 187 files) and found a second, independent cause:
  the secret-scanner's regex doesn't match the actual leaked filenames even
  when the hook runs. tSearch: PII-history exposure re-confirmed unchanged
  (fourth review); two new feature commits on an unmerged branch
  (obscurity/age-relative scoring, award registry) reviewed clean. Both
  repos: zero open issues, zero open PRs.
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
