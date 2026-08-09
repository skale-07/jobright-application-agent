# Product vision & technical direction — jobright-application-agent + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/tSearch` — keep both
files identical when editing. This is a **living document**, refreshed by a
scheduled review. It is not a proof log or a phase-status doc (those already
exist per-repo — see the "Deeper detail" links below) — it exists so both
projects' vision, architecture, and direction stay legible from one place, and
so risks that only show up when you look at *both* repos together (shared
lineage, shared operator, shared data-handling posture) don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-08-09 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (private), `skale-07/tSearch` (**public**) |

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
invented EEO answer) is expensive and hard to undo. That bet now extends to a
second surface: an **operator console** ("Dispatch") that lets a human run,
watch, and approve the pipeline from a browser instead of the CLI, plus an
opt-in **L3 armed mode** that removes per-application confirmation only
inside a timed, capped, operator-initiated window — never the underlying
safety gates.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / OpenAI (narrow call sites) / Express + React console frontend.
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and now three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`) exportable via `npm run training:export`. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (full list in `CLAUDE.md`, plus newer additions below). `chromium.launch` is confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Free-text/essay and demographic fields are architecturally incapable of being auto-filled — they route to `review_items`; `ESSAY_DRAFT_ENABLED` may generate a SUGGESTION into that review item, but only human-approved text ever fills.
- **New flags since last review:** `SUBMIT_REQUIRES_LOCAL_CONFIRMATION` (default true — the switch L3 flips), `MAX_UNATTENDED_SUBMISSIONS_PER_RUN` (default 0, hard cap per armed session), `ESSAY_REQUIRED_GATE_ENABLED` (default off), plus console-only `CONSOLE_HOST`/`CONSOLE_PORT`.
- **Validation ladder:** `UNIT_CONFIRMED → FIXTURE_CONFIRMED → LIVE_READ_ONLY_CONFIRMED → LIVE_MUTATION_CONFIRMED`, with `UNVERIFIED` as the honest default. A capability's self-reported success (including the fill-healer's) carries no level until independently verified. This ladder is the project's main defense against "fixture green" being mistaken for "live green" — and it now has to stretch across a much larger shipped-but-unproven surface (see §1.3).
- **ATS coverage today:** Greenhouse (inspect/fill/submit shipped, `FIXTURE_CONFIRMED`, live paths still `UNVERIFIED`). Lever and Ashby are now fully **wired** — shared registry, planner, `AtsBinding` dispatch, `ats:inspect`/`ats:fill`/submit CLI (`docs/ats-adapters-lever-ashby.md`) — but proven only against synthetic hand-authored fixtures, no real-DOM captures yet; both lack essay fill and selector healing and use a weaker pre-mutation gate (no job-id cross-check) than Greenhouse. Workday/iCIMS/Oracle remain detected-and-skipped only.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

A large wave of feature work has landed since the last review — multi-ATS
wiring (W1–W7), a navigation layer with a gated LLM fallback (N1–N6), the
operator console (C1–C7), L3 armed unattended apply (A1–A7), a screener
answer-bank, an essay draft assistant, telemetry/training export, and a
branding/marketing surface ("Dispatch", `DESIGN.md`, `site/`). The center of
gravity has shifted from "build Phase 0–13" to "a much larger surface is now
`FIXTURE_CONFIRMED` and waiting on live proof, plus one new higher-stakes
capability (L3) whose guardrails deserve continued scrutiny as it's exercised
live."

- **Blocking-defect status is currently ambiguous — this is itself the
  top item to resolve.** `docs/current-state-and-phase56.md` still describes
  live JobRight feed discovery returning `jobs_inspected: 0` as the single
  blocking defect (storageState/IndexedDB hypothesis untested). But
  `docs/operator-guide.md`, written more recently, describes discovery as a
  working numbered step with no such caveat. These two canonical docs now
  disagree about whether the product has ever completed a live closed loop.
  Until an operator re-runs `npm run discover` and updates
  `current-state-and-phase56.md` accordingly, treat the blocker as
  **unconfirmed either way**, not as fixed.
- **L3 armed unattended apply is the newest and highest-blast-radius
  capability.** It only removes the per-application confirmation *transport*
  inside a timed (15–240 min), capped (`MAX_UNATTENDED_SUBMISSIONS_PER_RUN`),
  single-counter armed session — `SUBMIT_ENABLED`, the identity gate, the
  approved-plan policy, and pre-click verification all still run, and
  `AUTOMATION_ENABLED=false` is a fail-closed kill switch. The design reads
  as sound; the thing to watch is that it is new and increases the cost of a
  gating bug, so it deserves a live-fill retest and a first *armed* live run
  before it's trusted at scale.
- **Lever/Ashby need real-DOM proof, not just synthetic fixtures**, the same
  "fixture green ≠ live green" gap Greenhouse already lived through — now
  duplicated across two more adapters at once.
- **Next after the discovery-status reconciliation:** live retest of the
  navigation layer's browser-use fallback (`AGENT_FALLBACK_ENABLED`, capped
  at 3 spawns × 25 steps × 180s / 8 min, never fills or submits) and of
  Lever/Ashby live fill, both still `UNIT/FIXTURE_CONFIRMED` only.
- **Deliberately not in scope right now:** Outlook send (permanently out of
  scope), silent multi-ATS expansion beyond Lever/Ashby, replacing any
  deterministic adapter with an LLM agent as the default path, or loosening
  L3's caps.
- **Longer arc:** Workday as the first `AGENT_FALLBACK_ENABLED` fill-assist
  candidate (still gated behind the same approved-plan + read-back
  verification), and closing the console/L3 live-proof gap now that both are
  feature-complete on paper.

Deeper detail (unchanged by this doc, still canonical — though see the
discovery-status caveat above): [`architecture.md`](./architecture.md) ·
[`current-state-and-phase56.md`](./current-state-and-phase56.md) ·
[`operator-guide.md`](./operator-guide.md) ·
[`ats-adapters-lever-ashby.md`](./ats-adapters-lever-ashby.md) ·
[`known-limitations.md`](./known-limitations.md) ·
[`validation-levels.md`](./validation-levels.md)

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

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / OpenAI / Resend.
- **Pipeline:** `resolve identity (LinkedIn + website) → expand graph hop-1 (GitHub collaborators/followers, Substack) → optional hop-2 (UI-driven only) → score (final_score heuristic) → persist (candidates.json, profiles/, data/people/) → assess (LLM judges, priority_score) → digest email`.
- **Discovery/Assessment/Presentation separation is load-bearing:** assessment reads only the frozen `output/candidates.json` — it never re-runs LinkedIn discovery or corrects a wrong identity match. `final_score` (discovery) and `priority_score` (assessment) are deliberately never collapsed into one number.
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass. Judges are instructed to coerce (demote/backfill) rather than hard-fail on missing evidence IDs.
- **No safety-flag layer.** Unlike jobright, tSearch has no `CLAUDE.md`/house-rules file, no fail-closed env-flag convention, and no forbidden-API check. The closest equivalents are undocumented code-level conventions (`ASSESSMENT_MOCK_LLM`, `--skip-digest`, `digest:send --dry-run`). Given this pipeline does live scraping of a third-party site and sends real email via Resend, this is a structural gap relative to its sibling repo, not just a style difference.

### 2.3 Technical direction

No commits have landed in tSearch since the last review (2026-08-07) beyond
the vision-doc merge itself — the section below is unchanged and reconfirmed,
not stale.

- Digest delivery is currently a one-shot brief (Phase 1–2 of the documented
  4-phase roadmap in `email-digest-implementation-context.md`). Phases 3–4 —
  feedback capture (relevant / not relevant / explore-network) and
  ranking refinement from that feedback — are **designed but not built**.
- Per `all-agents-wiring-verification.md` (the most recent audit pass), the
  blog/writing/cross-artifact/Cory judge wiring that an earlier self-report
  had claimed as complete is now genuinely wired end-to-end and passes an
  offline 4-candidate smoke test — but the docs are explicit that this has
  **not** been proven safe for a full-size (~39 candidate) live run: GitHub +
  blog rate-limit and OpenAI cost exposure at that scale is untested.
  Phase-D GitHub helpers (PR files/reviews/CODEOWNERS/workflows) remain
  unwired. Priority-v2 scoring and the "Cory" persona calibration are both
  flagged `requires_calibration` — not yet trustworthy as a ranking signal
  on their own.
- Open product question the docs flag as unresolved: whether digest emails
  should surface global top-N candidates or per-seed neighbors, and whether
  Substack-only (no GitHub) candidates should be filtered out of the digest
  at all.

Deeper detail (in `skale-07/tSearch`, not this repo): `docs/implementation-prompt.md` ·
`docs/all-agents-wiring-verification.md` · `docs/email-digest-implementation-context.md`

---

## 3. How the two projects relate

jobright-application-agent is a **hardened descendant** of tSearch's session/
scraping infrastructure, not an unrelated project. `docs/tsearch-reuse-map.md`
(this repo) records the original reuse plan: tSearch's `saveSession.ts` /
`linkedinBrowser.ts` concepts (manual storageState login, lazy session
open/validate) and atomic-JSON-store pattern were the seed for jobright's
`ServiceSession` and `src/storage/` layers, explicitly rebuilt with more
hardening (coverage statuses, mid-run auth checks, traces/screenshots, no
committed profile artifacts — a design choice that, per §4 below, tSearch
itself does not currently follow). tSearch's product logic — olympiad
scoring, GitHub graph expansion, the seed-tree UI — was deliberately **not**
ported; the two products solve different problems (apply vs. discover) and
share only the "safely drive a browser session against a third-party site"
substrate. jobright's newer navigation-layer LLM fallback (`AGENT_FALLBACK_ENABLED`,
browser-use over CDP) is the clearest sign the two repos' architectural
philosophies have since diverged further, not converged: it is deliberately
scoped to *navigation only* (never fill, never submit) and sits behind its
own gate, whereas tSearch's LLM usage has no equivalent flag-gated
containment.

One document is now stale on this point: `docs/tsearch-reuse-map.md` still
describes porting `linkedinExtract.ts` into a `packages/linkedin-enrichment`
module "in Phase 10," but `current-state-and-phase56.md` records that
LinkedIn enrichment was **dropped by decision** for the MVP (JobRight contact
context only). Low-severity, but worth a one-line update to the reuse map so
a future reader doesn't plan around a decision that was already reversed.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | tSearch | `profiles/` (39 files) and `backup/` (131 files, ~2.1MB) contain scraped **real people's** LinkedIn data — full name, LinkedIn URL, profile photo URL, education, headline, country — and are **tracked in git and pushed to `origin/main`**, which is a **public** GitHub repo. `.gitignore` has no `profiles`/`backup` entry. Unchanged since 2026-08-07 — no commits have touched this repo. | Third-party PII collected via scraping (no consent from the individuals) remains publicly exposed on GitHub, indexable and clonable by anyone. Still a live exposure, not a hypothetical: gitignore + `git filter-repo`/BFG history purge (removal alone doesn't clear git history), audit `data/people/`/`cache/` for the same problem, and consider enabling GitHub push protection with a custom pattern matching the scraped-profile JSON shape so this can't silently recur once cleaned. |
| **High** | jobright | The two canonical docs now **disagree** about whether live JobRight feed discovery works: `current-state-and-phase56.md` still says `jobs_inspected: 0`; `operator-guide.md` describes discovery as a working step with no caveat. New this review — a direct consequence of the large doc/feature wave landing without a reconciling pass. | Until resolved, it's unknown whether the product has ever completed a live closed loop, which was previously the single top-priority blocker. This needs an operator to actually re-run discovery and correct whichever doc is wrong — don't let the ambiguity get carried into a third review cycle. |
| **High** | jobright | L3 "armed unattended apply" (new capability) removes per-application human confirmation inside a capped, timed window. The gating design reads as sound (env triple + identity gate + approved-plan policy + read-back verification all still enforced), but it is unproven live and is the single highest-blast-radius capability shipped this cycle — a gating bug here means a real, unintended submission. | Consistent with the project's own validation-ladder discipline: a capability this consequential shouldn't stay `UNIT/FIXTURE_CONFIRMED` for long before a supervised live-armed test closes the loop. |
| **High** | tSearch | `assessment-rubric-architecture-audit.md` flags the ownership-share metric's denominator as the candidate's own commit count, which structurally biases toward false `primary_creator` attribution on any repo where the candidate is already a heavy committer. | This is a scoring-correctness bug in the exact mechanism recruiters are meant to trust; it's silent (no error, just a wrong number feeding `priority_score`). |
| **Medium** | jobright | Lever and Ashby are fully wired end-to-end (registry, planner, CLI, submit dispatch) but proven only against synthetic hand-authored fixtures — no real-DOM captures exist yet, and both adapters use a weaker pre-mutation gate than Greenhouse (no job-id cross-check). | Two ATS adapters at once inherit the "fixture green ≠ live green" risk Greenhouse already had to work through individually; worth a live-fill retest pass before they're relied on. |
| **Medium** | tSearch | No fail-closed safety-flag layer (no `CLAUDE.md`/house-rules, no forbidden-API check) despite live third-party scraping and real outbound email via Resend. jobright's own `docs/tsearch-reuse-map.md` explicitly names "no committed profile artifacts" as one of the hardening improvements made *over* tSearch — a gap tSearch has evidently not closed on itself. | As the assessment/digest surface grows (feedback loops, more automation), the absence of an explicit gating convention increases the chance a future change accidentally auto-sends or auto-escalates something that should have needed a human. |
| **Medium** | tSearch | `tsearch-playwright-system-audit.md` (HIGH-severity items): no mid-run re-authentication detection on the LinkedIn session (a silently expired session can produce garbage extractions with no error), zero LinkedIn tests, no retry/trace/screenshot capture on scrape failures, and country is captured but never used to reject homonym mismatches. | Directly threatens data quality (wrong-person matches silently entering the candidate graph) and makes live failures hard to diagnose after the fact — same class of problem jobright already solved for its own live paths via traces/screenshots/read-back verification. |
| **Medium** | jobright | `docs/current-state-and-phase56.md` — previously the canonical phase-status doc — has not been updated to reflect the console, L3, navigation layer, telemetry, screener answer-bank, or essay draft assistant, all of which shipped after it was last written. | A phase-status doc that's silently behind the newer `operator-guide.md`/`architecture.md`/`ats-adapters-lever-ashby.md` risks becoming the wrong source of truth for whoever reads it first — same root cause as the discovery-status contradiction above. |
| **Low** | tSearch | Digest-loop design (feedback capture → ranking refinement) is speced but unbuilt; open product questions (global vs. per-seed top-N, Substack-only filtering) are unresolved in the docs. | Not a defect, just unfinished direction — worth tracking so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a Phase 10 LinkedIn-enrichment port that was later dropped by decision (§3). | Doc drift; a future reader could plan work against a stale decision. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **browser-use over CDP — already adopted, matches the prior
  recommendation.** The navigation layer's `AGENT_FALLBACK_ENABLED` sidecar
  now uses exactly this pattern (browser-use driving the operator's CDP
  Chrome, capped spawns/steps/time, never fills or submits). No action
  needed here beyond the live-proof item already tracked in §1.3/§4; noting
  it so the earlier recommendation isn't re-suggested as new.
- **`storageState({ indexedDB: true })`** (Playwright ≥1.51) — still worth
  trying if the discovery-status reconciliation in §4 confirms the blocker
  is real: Google OAuth session state for JobRight plausibly lives in
  IndexedDB, which default `storageState()` silently drops.
  https://playwright.dev/docs/auth
- **CDP session-handoff discipline** — current guidance for multi-actor CDP
  scenarios (one driver, others observe-only, force a fresh snapshot after
  any handoff, one owner per attached browser) maps directly onto the
  console-and-navigation-layer combination now sharing a single CDP Chrome
  instance; worth a deliberate check that the console's live-run view and
  the navigation sidecar never attach as simultaneous drivers.

**tSearch**

- **GitHub secret scanning custom patterns + push protection** — GitHub's
  2026 push-protection expansion supports org-level custom patterns beyond
  its default secret-provider list. A pattern matching the scraped-profile
  JSON shape (LinkedIn URL + photo URL + name fields) could be configured to
  block a *repeat* of the critical PII finding in §4 after the existing
  history is cleaned, catching it at push time rather than relying on
  `.gitignore` discipline alone.
- **Autorubric** (arXiv, 2025) — formalizes rubric-based LLM-judge design
  using psychometric/education-testing principles (decomposing criteria to
  avoid halo effects, per-criterion reliability measurement). Directly
  applicable to hardening the existing rubric YAML system and to actually
  measuring which judge dimensions are noisy, rather than assuming the
  rubric is well-calibrated. https://arxiv.org/html/2603.00077v2
- **GitHub-graph-first identity resolution** (pattern: `theArjun/github-social-graph`,
  GitHub GraphQL API over followers/stargazers/forks + NetworkX for
  community detection) — a ToS-compliant complement that could shift weight
  away from LinkedIn scraping as the primary signal, which both reduces the
  legal exposure flagged in the README and gives the identity-resolution
  step a second signal to catch the homonym-mismatch gap noted in §4.

---

## Changelog

- **2026-08-09** — Second review. tSearch: zero commits since 2026-08-07
  beyond the vision-doc merge; §2 reconfirmed unchanged. jobright: large
  feature wave landed (Lever/Ashby wiring, navigation layer, operator
  console, L3 armed automation, screener answer-bank, essay draft assistant,
  telemetry export, branding/site) — §1 rewritten. Surfaced a new high risk:
  `current-state-and-phase56.md` and `operator-guide.md` now disagree on
  whether live JobRight discovery works, and the phase-status doc has not
  been updated for any of this cycle's shipped work. Both repos: zero open
  issues, zero open PRs at time of review (verified via GitHub search, not
  just `list_issues`/`list_pull_requests`).
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state (both repos: zero open
  issues, zero open PRs at time of review). Verified the critical PII/public-repo
  finding directly (`git ls-files`, file content, repo visibility) rather
  than relying solely on subagent report.
