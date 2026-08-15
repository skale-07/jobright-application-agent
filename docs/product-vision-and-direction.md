# Product vision & technical direction — jobright-application-agent + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/jobright-application-agent`
— keep both files identical when editing. This is a **living document**, refreshed by a
scheduled review. It is not a proof log or a phase-status doc (those already
exist per-repo — see the "Deeper detail" links below) — it exists so both
projects' vision, architecture, and direction stay legible from one place, and
so risks that only show up when you look at *both* repos together (shared
lineage, shared operator, shared data-handling posture) don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-08-15 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**), `skale-07/tSearch` (**public**) |

**Note on provenance**: the most recent merged copy of this doc is still the
2026-08-07 original — three subsequent reviews (08-09, 08-11, 08-13) were
drafted on unmerged `claude/epic-pasteur-*` branches and never landed on
`main`/`master`. Per the session-start-ritual instruction to check those
branches for a fresher copy, this review baselines on the 2026-08-13 draft
(`claude/epic-pasteur-559fdc`, the most recent) and reconciles it against
everything that has actually changed since — verified directly against both
repos' current `HEAD`, not by re-reading the prior draft's claims uncritically.

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
first flagged 08-11 is now on its third consecutive review cycle without a
fix, and it has kept getting worse each time — 187 leaked files on 08-13,
308 today.** See §4, first row, for the full picture. This is no longer a
one-off miss; it is a standing gap in the product's own safety net that
nobody has closed while automated cycles keep adding to it.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI (multiple gated call sites) / Express + React console frontend.
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`) exportable via `npm run training:export`. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (full list in `CLAUDE.md`). `chromium.launch` is confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Free-text/essay and demographic fields are architecturally incapable of being auto-filled — they route to `review_items`; `ESSAY_DRAFT_ENABLED` may generate a SUGGESTION into that review item, and `ESSAY_AUTOFILL_ENABLED` may fill directly from `private/candidate/about-me.md` under the same `validateDraft` checks, with every generated answer recorded on the plan entry.
- **Flag simplification since 08-13 — verified clean.** `GENERIC_ATS_ENABLED` is gone (PR #42, `763b7db`, operator directive 2026-08-14: "why are you making the system have so many useless gates that are not relevant"). The generic (company-hosted, non-named-ATS) adapter is now a first-class adapter — detection/planning are read-only and always on, but mutation still requires `FORM_FILL_ENABLED` / `DRY_RUN=false` / `SUBMIT_ENABLED`, identical to every vendor adapter. Verified directly: the flag is gone from `.env.example` and `CLAUDE.md`'s safety-invariants list (this doc's own cached copy of that list, shown above, matches current `HEAD`), and the mutation gate itself is untouched — this is a real gate-count reduction, not a safety loosening. The same PR also stopped dead application twins (`FAILED_FINAL`/`FILTERED_OUT`/`UNSUPPORTED_ATS`) from blocking a URL a live sibling could still use, and added a capped revival sweep for previously-parked `UNSUPPORTED_ATS` apps.
- **ATS coverage today:** Greenhouse (inspect/fill/submit shipped, `FIXTURE_CONFIRMED`, live paths `UNVERIFIED`). Lever, Ashby, Workday, Workable all wired end-to-end but still `UNVERIFIED (wired, never run)` / `UNVERIFIED_SELECTOR` — no live-DOM progress since 08-11. Generic is now first-class per above.
- **Verify gate this review:** `npm run typecheck` clean (791 tests collected once `npm install` was run — the review sandbox needed a fresh `node_modules`, same as the app's own dependencies would on any new checkout). `npm run test`: 791 passed / 161 failed / 8 skipped across 173 files, but **every failure traces to the same single cause**: `chrome-headless-shell` isn't installed at this sandbox's Playwright browser path (`/opt/pw-browsers/chromium_headless_shell-1228/...`) — confirmed by inspecting the actual assertion diffs, not just the top-line count; several tests that expect a specific navigation/error code instead see the raw launch error surface through. Same environment-gap pattern as the 08-13 review (which saw 126/838 fail for the identical reason); this is not evidence of a code regression, but the claim remains `UNVERIFIED` for anything touching a real browser launch until re-run in an environment with the binary present.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **Resume-PDF leak: three reviews running, still unresolved, still growing.**
  Verified directly against current `HEAD` (`c9be0b5`): (a) `.git/hooks/pre-commit`
  is still absent and `core.hooksPath` is still unset — `npm run hooks:install`
  has never been run; (b) **308 unique `materials/resume-*.pdf` files** are now
  reachable from `HEAD` (up from 187 on 08-13, 183 on 08-11), added by roughly
  a dozen-plus autopush commits, six of them landing since the 08-13 review
  alone (`7df4b76`, `086820f`, `1c9c095`, `2ccb0e7`, `5bb6b86`, `1f3918b`); (c) no
  purge has ever been attempted against this specific leak — the one purge
  commit in the repo's history (`f0ddcff`) addresses an unrelated 08-07
  incident; (d) `src/automation/artifactAutopush.ts:53` still runs a blanket
  `git("add", "-A", "--", "artifacts")` with no `materials/` exclusion —
  confirmed unchanged by reading the file directly — so it will keep adding to
  this on every future autopush cycle, armed or not; (e) `src/security/artifactScan.ts:26`'s
  pattern is still `/resume\.pdf$/i`, confirmed unchanged, which still does not
  match the actual filenames (`resume-<hash>.pdf`) — the intended safety net
  would not have caught a single one of these 308 files even if it had been
  installed. All five root causes named across the last two reviews are still
  present, unmodified, verified by reading the current file contents rather
  than assuming carryover.
- **`docs/current-state-and-phase56.md` is still wrong — fourth review in a
  row flagging it, now four days past when it was first called a "same-day
  fix."** Line 179 still reads "The live discovery path has never produced a
  job," directly contradicted by the same class of real auto-cycle artifacts
  the 08-13 review cited. No commit since 08-13 touches this file.
- **L3 armed unattended apply: unchanged, still `FIXTURE_CONFIRMED`.** No new
  auto-cycle artifacts with a live submit appeared this review; the
  `submits_used: 1`/`per_app`-mismatch artifact flagged 08-13 is unchanged and
  still worth an operator's direct look.
- **`auto:cycle` unattended operating posture: unchanged.** Still a standing
  `.env` + scheduled task, self-arming, no per-run human click, no time-boxed
  re-arm gate.
- **Sender-trust magic-link handling: unchanged since `ecc0979`.**
- **Feature wave since 08-13** (PRs #42–#48, all merged, zero open issues,
  zero open PRs at time of review): the generic-ATS flag removal and
  dead-twin/revival fix above (#42); an agent knowledge-graph doc validated
  by a dedicated test so it can't silently rot (#43, `docs/knowledge-graph/`);
  portal sign-in landing pages now stored so fill can own portal auth (#44);
  a speed pass — less sleep, a shared browser instance, faster-failing
  rejected submits (#45); six fill fixes in one PR — iframe hop, wizard walk,
  work-authorization answers, requeue/email/popup fixes (#46); a single
  tested navigation-transition primitive that classifies every landing and
  diagnoses every stall (#47); and giving the model the actual page choices
  during fill — option harvest, board API, posting-advance detection, a skip
  button (#48). None of these touch the safety-flag list, `check:forbidden`,
  or submit gating; spot-checked #42 and #48 directly, both gate mutation
  through the existing `FORM_FILL_ENABLED`/`SUBMIT_ENABLED` pair.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  silent multi-ATS expansion beyond what's now wired, replacing any
  deterministic adapter with an LLM agent as the default path, loosening L3's
  numeric caps.
- **Next up, in priority order, unchanged from 08-13 because none of it has
  been done:** (1) install the pre-commit hook, fix the secret-scan regex to
  match `resume-*.pdf`, add a `materials/` exclusion to
  `artifactAutopush.ts`, then purge the (now 308-file) leak from history —
  still the single most overdue action item across both repos, and the gap
  between "known" and "fixed" is now measured in a growing leak count, not
  just elapsed days; (2) fix `current-state-and-phase56.md`; (3) resolve the
  `submits_used: 1`/`per_app` inconsistency with an operator; (4) live-DOM
  proof for Lever, Ashby, Workday, Workable, and generic; (5) a decision on
  tightening sender-trust domain affinity.

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
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass, joined by an experience-distinctiveness judge (routing boost only), a recruiter-label/tier judge, and (on an unmerged branch, see below) an age-relative-impressiveness judge plus an obscurity multiplier.
- **Zero commits since the 08-13 review, on any branch, in either repo.**
  Verified with `git log --all --since` across every ref: the only commit in
  that window in this repo is the 08-13 review itself. `claude/talent-discovery-pipeline-bfunzx`
  (the obscurity/age-relative-judge and award-registry work reviewed clean on
  08-13) is unchanged and still unmerged — nothing new to review this cycle.
- **Safety-flag layer — unchanged.** `CLAUDE.md` documents fail-closed
  boundaries in prose; there is still no forbidden-API checker or repo-wide
  `*_ENABLED` naming convention comparable to jobright's CI-enforced
  `check:forbidden`.
- **Verify gate this review:** `npm run typecheck` clean, `npm run test`:
  **186/186 passing across 36 files** (re-run directly this review, not
  assumed from the prior draft). Repo is not currently broken.

### 2.3 Technical direction

- **PII history exposure: unchanged, still critical, still unpurged — fifth
  review in a row confirming it.** Re-verified directly again this review:
  `git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves, and
  the blob still contains a real person's full name, LinkedIn URL, photo CDN
  URL, school, and degree. No `filter-repo`/BFG commit exists anywhere in
  `git log --all`. Current tree stays clean (`.gitignore` covers `profiles/`,
  `backup/`, `data/`, `cache/`, `output/`), which bounds new exposure but does
  nothing for what's already public in history.
- **Ownership-share fix and mid-run LinkedIn auth-guard: still holding.**
  `tests/assessment/ownership.test.ts` and `tests/linkedin/authGuard.test.ts`
  both confirmed still present this review — the two risks resolved 08-10/08-11
  have not regressed (trivially true this cycle, since nothing changed).
- **Everything else in this section: unchanged since 08-13**, because zero
  commits landed anywhere in the repo. Digest feedback loop/oracle/autopilot,
  the open product question on global-vs-per-seed digest ranking and
  Substack-only filtering, zero retry/trace/screenshot capture on LinkedIn
  scrape failures, and auto-assess-by-default all carry forward unchanged.
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
more hardening (coverage statuses, mid-run auth checks — now matched on
tSearch's side too, see §2.2 — traces/screenshots, no committed profile
artifacts, a design choice tSearch has now also adopted going forward per
§2.2, though not retroactively into history per §4). tSearch's product
logic — olympiad scoring, GitHub graph expansion, the seed-tree UI — was
deliberately **not** ported; the two products solve different problems
(apply vs. discover) and share only the "safely drive a browser session
against a third-party site" substrate.

**Both repos still share the same unresolved shape of risk: a personal/PII
document exposure on a public repo, found and re-confirmed unpurged across
multiple review cycles, with the underlying automation still capable of
adding more.** tSearch's is third-party LinkedIn PII in history only (current
tree is clean, and the count is stable — no new commits since 08-13);
jobright's is the operator's own resume PDFs, still actively growing with
every automation cycle (308 files now vs. 187 two days ago) — which keeps
jobright's the more urgent of the two, since it is the one still getting
worse in real time while tSearch's has simply gone unaddressed. Both repos
also carry a genuinely unattended, scheduled-automation surface — jobright's
`auto:cycle` (§1.3, real submissions possible) and tSearch's autopilot
(§2.3, fail-closed to mock/dry-run by default) — worth watching as a shared
pattern, since a gating bug in either would look similar from the outside (a
scheduled task silently doing something consequential).

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
| **Critical** | jobright | **Third consecutive review finding this unfixed and worse.** `ARTIFACT_AUTOPUSH_ENABLED` continues pushing the operator's real resume PDFs to this public repo: at least 6 more autopush/manual-artifact commits landed since 08-13, bringing the total to **308 unique leaked resume PDFs** (up from 187 on 08-13, 183 on 08-11). `.git/hooks/pre-commit` is still not installed. `src/security/artifactScan.ts`'s regex (`/resume\.pdf$/i`) still does not match the actual filenames (`resume-<hash>.pdf`) — verified unchanged, line 26. `src/automation/artifactAutopush.ts:53` still has no `materials/` exclusion in its `git add -A` — verified unchanged. No purge has ever been attempted against this specific leak. | This is now the single longest-standing, actively-worsening item across both repos. The fix is small and well-specified (install hook, fix one regex, add one path exclusion, then purge history) and has been specified identically for three review cycles running without being picked up. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII (name, LinkedIn URL, photo URL, school, degree) is untracked from the current tree but still fully present and fetchable in git history on this public repo — re-verified directly this review (`git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves). No purge has been attempted since the finding was first raised. | Fifth review in a row confirming this is unchanged: a live public exposure of real third-party people's data, not a hypothetical. `git filter-repo`/BFG + force-push + collaborator re-clone is still the concrete, unexecuted unblock. |
| **High** | jobright | `docs/current-state-and-phase56.md` remains actively contradicted by the repo's own committed artifacts (it still says live discovery "has never produced a job"). Fourth review in a row flagging this, now four days past when it was first called a "same-day fix." | An operator or future agent trusting this doc would materially misjudge the product's current state. The fix is a doc edit, not new code. |
| **High** | jobright | `auto:cycle` + a standing `.env` + a scheduled task remains a genuinely unattended fill-and-submit operating mode with no per-run human click and no time-boxed re-arm gate, unchanged since 08-11. Realized risk stays bounded (no confirmed live submit yet), but the capability is armed and intended for regular use. | Still an open, deliberate product decision: whether unattended real-submission automation needs an additional standing-authorization gate before being treated as normal operation. |
| **High** | jobright | Sender-trust magic-link handling (`ecc0979`) remains a keyword-match-only qualification with no sender-domain-affinity requirement; the browser still navigates to matching links using the operator's authenticated session. Unchanged since 08-11. | Still a genuine, code-verified phishing-surface widening with no decision made yet on tightening it. |
| **Medium** | jobright | `operator-guide.md`'s claim that the improvement loop autonomously merges its own gated PR remains unsupported by anything in-repo. Unchanged, still unconfirmed either way. | Needs a direct operator confirmation — "agent proposes" vs. "agent unattendedly merges to its own safety-relevant codebase" are very different risk profiles. |
| **Medium** | jobright | Lever, Ashby, Workday, Workable, and generic are all wired but unverified against real DOM — no live-DOM progress on any of them since 08-11. | The live-proof backlog isn't shrinking; the honest `UNVERIFIED_SELECTOR` labeling is good discipline but doesn't reduce the backlog itself. |
| **Medium** | tSearch | No fail-closed safety-flag *enforcement* — `CLAUDE.md` documents boundaries in prose but there is still no forbidden-API checker or `*_ENABLED` naming convention comparable to jobright's CI-enforced `check:forbidden`. Unchanged since 08-11. | A future change could silently violate the frozen-candidates-snapshot or `final_score`/`priority_score` separation invariants and nothing in CI would catch it. |
| **Medium** | tSearch | `tsearch-playwright-system-audit.md` remaining items unchanged: zero retry/trace/screenshot capture on scrape failures; captured country still never used to reject homonym mismatches. | Wrong-person matches can still silently enter the candidate graph; live failures are still hard to diagnose after the fact. |
| **Low** | jobright | An older run artifact (`run-47082d9f`, 2026-08-08) still shows `submits_used: 1` at the top level while all 7 of its `per_app` entries show `submitted: false`/`FAILED_RETRYABLE` — an internal inconsistency, not a confirmed live submit. Unchanged since 08-13. | Doesn't change L3's overall `FIXTURE_CONFIRMED` status, but a validation-ladder document should not have an unresolved contradiction sitting in its own evidence. |
| **Low** | tSearch | Auto-assess still runs by default at the end of every pipeline run (`AUTO_ASSESS=0` to opt out). Unchanged since 08-11. | Cost/scope-creep item, not a safety gap. |
| **Low** | tSearch | Digest-loop ranking-*refinement*-from-feedback still unbuilt; global-vs-per-seed and Substack-only-filtering product questions remain unresolved. Unchanged since 08-07. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase 10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **The full three-layer secret-prevention stack, not just a fixed pre-commit
  hook** — a 2026 survey of current practice (Gitleaks/TruffleHog + GitHub
  push protection guidance) converges on: a pre-commit hook for local
  feedback, the same scanner re-run in CI to catch `--no-verify` bypasses,
  and host-side push protection as the last line. jobright currently has
  none of the three actually active (§4). A Gitleaks `.gitleaks.toml` with a
  path rule like `materials/.*\.(pdf|docx?)$` would independently catch this
  review's filename-regex finding, since it blocks the *path shape* rather
  than a specific spelling of "resume." https://gitleaks.org/
- **Human-oversight-by-design browser-agent patterns** (e.g. Asteroid,
  Straiker's runtime guardrails for agentic browsers) — carried over, still
  directly relevant to the unresolved `auto:cycle` posture question in §4.
- **CDP session-handoff discipline** — carried over, still relevant now that
  the console, the nav-layer sidecar, and `auto:cycle` can all potentially
  want the same CDP Chrome instance.

**tSearch**

- **`git filter-repo` / BFG history purge, executed, not just planned** —
  repeated for the fifth review in a row. Kept here deliberately so it
  doesn't quietly stop being said just because it's been said before.
- **GitHub push protection with a custom secret-scanning pattern** matching
  the scraped-profile JSON shape (name + LinkedIn URL + photo URL) — pairs
  with the history purge as a recurrence-prevention measure at push time.
- **Krippendorff's alpha for judge-panel calibration, with concrete
  thresholds** — current 2026 LLM-as-judge practice recommends sampling
  100–300 production traces, having 2–3 humans label them, and computing
  Krippendorff's alpha (Cohen's kappa only applies to exactly two raters):
  below 0.4 means the rubric itself needs a rewrite, 0.4–0.6 is weak but
  tunable, above 0.6 is acceptable, above 0.8 is strong. Directly actionable
  now that the judge panel (technical, writing, experience-distinctiveness,
  recruiter-label, and soon age-relative/obscurity) has grown past the point
  where "each judge looks reasonable in isolation" is a substitute for a
  measured agreement number between them.

---

## Changelog

- **2026-08-15** — Fifth review (this one, and the first to actually merge).
  Baselined against the unmerged 2026-08-13 draft (`claude/epic-pasteur-559fdc`)
  per the session-start-ritual instruction, then independently re-verified
  every carried-forward claim against current `HEAD` in both repos rather
  than trusting the draft's numbers. **Resume-PDF leak (jobright) confirmed
  worse for the third review running**: 308 unique files now (187 on 08-13,
  183 on 08-11), roughly 6 more autopush commits since 08-13, all five named
  root causes (missing hook, unfixed regex, missing `materials/` exclusion,
  no purge attempted, ongoing autopush) verified still present by reading the
  current file contents directly. **tSearch's PII-history exposure
  re-verified unpurged for the fifth review in a row** (direct
  `git cat-file` read of the same still-reachable blob). `docs/current-state-and-phase56.md`
  still wrong, fourth review flagging it. Zero commits landed anywhere in
  tSearch since 08-13 — §2 and its risk items carry forward as verified-
  unchanged rather than assumed-unchanged. jobright saw a legitimate feature
  wave (PRs #42–#48: generic-ATS flag removal per operator directive,
  knowledge-graph docs, portal-auth storage, speed pass, six fill fixes, one
  navigation-transition primitive, richer in-page choice signals for fill) —
  spot-checked two of these directly for safety-gate integrity, both clean.
  Verify gates this review, both re-run directly rather than assumed:
  tSearch 186/186 tests passing, typecheck clean; jobright typecheck clean,
  791/960 tests passing with the remaining 161 traced to the same missing-
  browser-binary environment gap seen 08-13 (not a regression). Both repos:
  zero open issues, zero open PRs. This review's copy is merged directly to
  `main`/`master` in both repos rather than left on an unmerged draft branch,
  breaking the pattern of the last three reviews.
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
