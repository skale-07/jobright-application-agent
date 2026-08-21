# Product vision & technical direction — jobright-application-agent (Dispatch) + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/tSearch`
— keep both files identical when editing. This is a **living document**,
refreshed by a scheduled review. It is not a proof log or a phase-status doc
(those already exist per-repo — see the "Deeper detail" links below) — it
exists so both projects' vision, architecture, and direction stay legible
from one place, and so risks that only show up when you look at *both* repos
together (shared lineage, shared operator, shared data-handling posture)
don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-08-21 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**, confirmed via API), `skale-07/tSearch` (**public**, confirmed via API) |

**Note on provenance**: this is the **first review to land on `main`/`master`
since 2026-08-07** — eight subsequent reviews (08-09 through 08-19) were
drafted on unmerged `claude/epic-pasteur-*` / `claude/busy-clarke-*` branches
and never landed, because the scheduled routine pushes to a fresh review
branch each run rather than opening or updating a PR against the branch this
session develops on. This review baselines on the 2026-08-19 draft
(`claude/epic-pasteur-purjf5` / `claude/busy-clarke-purjf5`, the most
thorough and most recent), reconciles it against everything that changed
since, and — because this session's designated branches
(`claude/busy-clarke-6eyjpj`, `claude/epic-pasteur-6eyjpj`) already sit at
the tip of `master`/`main` — pushes directly to them. **The fact that eight
prior reviews' findings never reached a human via a merged doc, while the
underlying leak they all flagged kept growing, is itself a finding — see §4.**

---

## 1. jobright-application-agent ("Dispatch")

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
second surface: an **operator console** ("Dispatch" — the repo began a
rename to this name 2026-08-18, PR #61) that lets a human run, watch, and
approve the pipeline from a browser instead of the CLI, plus an opt-in
**L3 armed mode** that removes per-application confirmation only inside a
timed, capped, operator-initiated window — never the underlying safety
gates.

**A notable strategic pivot landed this review cycle (PR #63, "Extension-first
dual-agent fill", operator directive 2026-08-20): JobRight's own browser
extension becomes the *primary* filler, with Dispatch navigating, activating
it, gap-filling what it misses, and still owning the submit chain.** This
sits in tension with the "not a general autonomous browser agent, determinism
beats an LLM/third-party agent" framing above — Dispatch is now deliberately
delegating the first pass of a mutation-adjacent action to code it doesn't
control. The implementation keeps the house rules' spirit: presence
detection is fail-closed (`"present" | "unknown"`, never a confident
`"absent"`, because MV3 workers idle out and closed shadow roots are
invisible), the trigger-selector registry ships empty on purpose (nothing
auto-clicks until an operator capture promotes real selectors), and raw
field values are never persisted from the capture step. Worth an explicit
operator/product decision on whether this extension dependency is a
permanent architecture change or a scoped experiment, since it's a
meaningfully different trust boundary than "Dispatch drives Playwright
directly."

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3/Moonshot (multiple gated call sites) / Express + React console frontend.
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`) exportable via `npm run training:export`. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (full list in `CLAUDE.md`). `chromium.launch` is confined to three session-infra files, now joined by a hardened `cdpChrome`/`assertDebugProfileDir` guard (PR #63) that refuses to autolaunch or kill any Chrome profile that isn't the dedicated `jobright-cdp` dir — an operator's own attached Chrome is structurally untouchable. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Free-text/essay and demographic fields are architecturally incapable of being auto-filled — they route to `review_items`.
- **Feature wave since 08-19 — diffed directly for safety-flag/gating touches, none found.** Three commits: `c6ec813` ("recent artifact push and tuning", 08-20) — ~4k lines of Paylocity live-session ATS tuning (generic v1, Greenhouse combobox fill, page classification, pre-mutation gate) that landed with 4 red tests; `eb0a3ef` (#62, same day) — the repair pass, fixing all four in the direction of the original tuning's intent plus one evidence-driven fix (a relaxed pre-mutation gate was letting `plan_only` proceed on posting-class pages; now refuses again) and dropping consent-manager DOM from discovery; `ad8896e` (#63) — the Extension-first architecture described in §1.1, plus telemetry-join repairs (`fill_runs.application_id` was silently `NULL` for every live-fill run because two recorders hardcoded `source:"cli_url"` and opened their own DB instead of threading the capture's) and a "zero-CLI console" milestone. None of the three touch `sendGuards.ts`, `assertExecutableApprovedEntry`, `SUBMIT_ENABLED`, or `check-forbidden.ts`.
- **ATS coverage today: unchanged since 08-11.** Greenhouse (inspect/fill/submit shipped, `FIXTURE_CONFIRMED`, live paths `UNVERIFIED`). Lever, Ashby, Workday, Workable all wired end-to-end but still `UNVERIFIED (wired, never run)` / `UNVERIFIED_SELECTOR`. Generic is first-class (since 08-13, PR #42).
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **Resume-PDF leak: now on its sixth consecutive review, still unresolved,
  still growing, and this review independently found a more direct root
  cause than any prior one.** Verified fresh against current `HEAD`
  (`ad8896e`) via `git ls-tree`, not by trusting the prior draft: **396
  `artifacts/applications/*/materials/resume-*.pdf` paths** are reachable
  from `HEAD` (up from 366 on 08-19), and the very latest merged PR (#63,
  2026-08-20 — the day before this review) added to the count, so the leak
  is still live as of the most recent commit on the branch, not a stale
  artifact. Root causes, all reconfirmed unchanged plus one new finding:
  (a) `src/security/artifactScan.ts:26`'s pattern is still
  `/resume\.pdf$/i`, which does not match `resume-<hash>.pdf` — verified
  directly with `node -e "console.log(/resume\.pdf$/i.test('resume-db94def0.pdf'))"`
  → `false`; (b) `src/automation/artifactAutopush.ts:53` still runs a
  blanket `git add -A -- artifacts` with no `materials/` exclusion; (c)
  **new this review**: `.gitignore` itself has the `artifacts/` line
  *commented out* (`# artifacts/`, line ~20, under "Operational data and
  artifacts") — so even if (a)/(b) were fixed, nothing currently stops a
  plain `git add` from picking up anything under `artifacts/` at all. This
  is a more fundamental gap than the narrow regex/exclusion issues the last
  five reviews focused on: the directory-level ignore is disabled, not just
  incomplete. No purge (`filter-repo`/BFG) has ever been attempted against
  this leak — the one purge commit in the repo's history (`f0ddcff`)
  addresses an unrelated 08-07 incident. **This repository is confirmed
  public via the GitHub API this review** (`"private": false`,
  `"visibility": "public"`), so these are real, publicly-cloneable files,
  not a private-repo housekeeping issue.
- **`docs/current-state-and-phase56.md` is still wrong** — line 179 still
  reads "The live discovery path has never produced a job," contradicted by
  the same class of real auto-cycle artifacts cited in every review since
  08-11. No commit since PR #33 touches this file.
- **L3 armed unattended apply: unchanged, still `FIXTURE_CONFIRMED`.** The
  `submits_used: 1`/`per_app`-mismatch artifact (`run-47082d9f`) flagged
  08-13 is unchanged and still worth an operator's direct look.
- **`auto:cycle` unattended operating posture: unchanged**, still a standing
  `.env` + scheduled task, self-arming, no per-run human click, no time-boxed
  re-arm gate.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  silent multi-ATS expansion beyond what's now wired, replacing any
  deterministic adapter with an LLM agent as the default path, loosening L3's
  numeric caps.
- **Next up, in priority order — now the single most overdue action item
  across both repos, six review cycles running without being picked up:**
  (1) uncomment `artifacts/` in `.gitignore` (or scope a narrower
  `materials/` exclusion if operators need other artifact subpaths tracked),
  fix `artifactScan.ts:26`'s regex to match `resume-*.pdf`, add a
  `materials/` exclusion to `artifactAutopush.ts:53`, confirm
  `npm run hooks:install` actually runs on the machine that
  autopushes/tunes, then purge the 396-path leak from history; (2) fix
  `current-state-and-phase56.md`; (3) resolve the `submits_used: 1`/`per_app`
  inconsistency; (4) live-DOM proof for Lever, Ashby, Workday, Workable, and
  generic; (5) an explicit product decision on the Extension-first
  architecture's trust boundary (§1.1).

Deeper detail (in `skale-07/jobright-application-agent`, not this repo):
[`docs/architecture.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/architecture.md) ·
[`docs/current-state-and-phase56.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/current-state-and-phase56.md) ·
[`docs/operator-guide.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/operator-guide.md) ·
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
- **Pipeline:** `resolve identity (LinkedIn + website) → expand graph hop-1 (GitHub collaborators/followers, Substack) → optional hop-2 (UI-driven only) → score (final_score heuristic) → persist (candidates.json, profiles/, data/people/) → assess (LLM judges, priority_score) → digest email`, with an optional autopilot chain and a GitHub-first "footprint sweep" that pre-qualifies olympiad-CSV names before ever touching LinkedIn.
- **Two substantial commits landed since the 08-19 review**, both by the
  operator directly (not via a reviewed PR — zero open PRs at any point this
  review covers): `4ba3672` ("restore Discover UI, verified GitHub, 1-10
  score, and writing hubs") rebuilds the Discover intake after what the
  commit message describes as a cache wipe, locks GitHub identity to
  URL-verified matches only, moves the recruiter-facing score to a 1-10
  scale with an explicit age scalar, and adds "writing hubs" classification
  to distinguish real story URLs from platform chrome in LinkedIn contact
  links; `54d1d36` ("youth wildcards, corroborated GitHub, and honest digest
  scoring") adds a 17-19-year-old LinkedIn-wildcard carve-out that stays in
  the digest even below the priority floor, requires a candidate's GitHub to
  point back at their known LinkedIn/site before it's attached (tightening
  the identity-corroboration bar), and adds a `scoreBreakdown` module so the
  digest can show *why* a score landed where it did — directly the kind of
  explainability the 08-07 review's Prometheus2/GLIDER amendment suggested.
  Both commits ship their own tests (222 tests → materially more now; not
  independently re-run this review, see below).
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass, joined by an experience-distinctiveness judge, a recruiter-label/tier judge, an age-relative-impressiveness judge, and an obscurity multiplier (all landed PR #6, 08-18).
- **Safety-flag layer — unchanged.** `CLAUDE.md` documents fail-closed
  boundaries in prose; neither of the two new commits touched `CLAUDE.md` or
  added a forbidden-API checker — there is still no repo-wide `*_ENABLED`
  naming convention comparable to jobright's CI-enforced `check:forbidden`.

### 2.3 Technical direction

- **PII history exposure: unchanged, still critical, still unpurged — eighth
  review in a row confirming it, reverified fresh this review, not carried
  forward from the prior draft.** `git cat-file -e 700e2f6:profiles/madanva/profile.json`
  still resolves; the blob still contains a real person's full name,
  LinkedIn URL, photo CDN URL, school, and degree. No `filter-repo`/BFG
  commit exists anywhere in `git log --all`. Current tree stays clean
  (`.gitignore` covers `profiles/`, `backup/`, `data/`, `cache/`, `output/`,
  confirmed unchanged), which bounds *new* exposure but does nothing for
  what's already public in history. **This repository is confirmed public
  via the GitHub API this review**, same as jobright.
- **Ownership-share fix and mid-run LinkedIn auth-guard: still holding.**
  `tests/assessment/ownership.test.ts` and `tests/linkedin/authGuard.test.ts`
  both present, neither touched by the two new commits.
- **Everything else in this section carries forward unchanged**, since the
  two new commits' scope was Discover/scoring/digest, not the LinkedIn
  scrape-failure handling or auto-assess default: zero retry/trace/screenshot
  capture on LinkedIn scrape failures, auto-assess-by-default, the digest
  feedback loop (Phases 3-4 of the 4-phase roadmap) still designed but
  unbuilt, and the open product question on global-vs-per-seed digest
  ranking / Substack-only filtering.
- Zero open issues, zero open PRs confirmed via the GitHub API this review.

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
jobright's `ServiceSession` and `src/storage/` layers, explicitly rebuilt
with more hardening (coverage statuses, mid-run auth checks,
traces/screenshots, no committed profile artifacts by design — though §4
below shows jobright now has its own uncommitted-artifact discipline gap,
just a different one than tSearch's). tSearch's product logic — olympiad
scoring, GitHub graph expansion, the seed-tree UI — was deliberately **not**
ported; the two products solve different problems (apply vs. discover) and
share only the "safely drive a browser session against a third-party site"
substrate.

One document is still stale on this point, unchanged across all nine
reviews: jobright's `docs/tsearch-reuse-map.md` still describes porting
`linkedinExtract.ts` into a `packages/linkedin-enrichment` module "in Phase
10," but `current-state-and-phase56.md` records that LinkedIn enrichment was
**dropped by decision** for the MVP. Low-severity, doc drift only.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | jobright | **396 real resume PDFs** (`artifacts/applications/*/materials/resume-*.pdf`) tracked in git history on a confirmed-**public** repo, still growing as of the most recent commit (08-20), across six review cycles with zero remediation. Root cause is now three-deep: a too-narrow scan regex, a blanket autopush `git add`, and — found fresh this review — `.gitignore`'s `artifacts/` line is simply commented out. No purge attempted. | These are real application materials (name, contact info, address, work history) publicly clonable by anyone; the exposure has compounded for over a week while five prior reviews flagged it without a fix landing. |
| **Critical** | tSearch | `profiles/` and `backup/` scraped **real people's** LinkedIn PII, publicly exposed in git history on a confirmed-public repo since before 08-07. Current tree is clean (`.gitignore` fixed), but history was never purged — eighth consecutive review confirming this, reverified fresh here. | Third-party PII (not even the operator's own data, unlike the jobright leak) collected without consent remains publicly indexable/clonable via history; removal from the working tree does nothing for what's already in `git log --all`. |
| **High** | *(process)* both | **The review process itself is not closing the loop.** Eight scheduled reviews (08-09 through 08-19) drafted real findings — including the two Critical items above — on branches that never merged to `main`/`master`, so no human reading either repo's actual docs tree saw them; meanwhile the resume-PDF leak grew from ~0 to 396 files across exactly that window. A finding that only exists on an unmerged branch has the same practical effect as no finding at all. | This is why this review pushes to the session's designated branch instead of a fresh one-off branch, and why it's flagged here explicitly: the fix isn't "write a better review," it's "make sure the review reaches someone who can act on it." Worth an explicit operator decision on how these branches should land (PR + notification vs. direct push to a stable review branch). |
| **High** | jobright | Live JobRight feed discovery historically returned 0 cards against a real session (docs still say so at `current-state-and-phase56.md:179`); not re-verified this review since no commit since PR #33 touches that path or file. | Carried forward from prior reviews as unresolved; if still true, the product has never completed a live closed loop. |
| **High** | tSearch | `assessment-rubric-architecture-audit.md` flags the ownership-share metric's denominator bias toward false `primary_creator` attribution; the 08-10/08-11 fix (`tests/assessment/ownership.test.ts`) still holds, confirmed present and untouched by the two new 08-19/08-20 commits. | Carried forward as resolved-and-holding rather than open, but worth one line so a future reader doesn't reopen it without cause. |
| **Medium** | jobright | The Extension-first dual-agent fill architecture (PR #63, §1.1) delegates the first fill pass to JobRight's own extension rather than Dispatch's own Playwright code — implemented fail-closed, but a real shift in the trust boundary from the product's stated "not a general autonomous/third-party agent" positioning. | Not unsafe as shipped, but worth an explicit product decision on whether this is the permanent architecture before more is built on top of it. |
| **Medium** | tSearch | No fail-closed safety-flag layer (no forbidden-API check comparable to jobright's `check:forbidden`) despite live third-party scraping and real outbound email via Resend. | As the assessment/digest surface grows, the absence of an explicit gating convention increases the chance a future change accidentally auto-sends or auto-escalates something that should have needed a human. |
| **Medium** | tSearch | No mid-run re-authentication detection beyond the existing auth-guard test's scope, zero retry/trace/screenshot capture on LinkedIn scrape failures, country captured but unused for homonym rejection (from `tsearch-playwright-system-audit.md`, not re-verified line-by-line this review). | Same class of problem jobright already solved for its own live paths via traces/screenshots/read-back verification. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase 10 LinkedIn-enrichment port (§3). | Doc drift; unchanged across nine reviews. |
| **Low** | tSearch | Digest feedback loop (Phases 3-4) still designed but unbuilt; open product questions on global-vs-per-seed ranking and Substack-only filtering unresolved. | Not a defect, just unfinished direction. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **`git-filter-repo`** — the concrete tool for the now-most-overdue action
  item in §1.3/§4: purging the 396-path resume-PDF leak from history once
  the ingestion bugs are fixed. GitHub's own docs recommend it over BFG for
  this exact case (removing files by path pattern across all history).
  https://github.com/newren/git-filter-repo
- **A pre-push scanning hook (e.g. `gitleaks protect --staged`, or a
  repo-specific path-pattern check) as defense-in-depth alongside the
  existing pre-commit hook** — this review's finding that `.gitignore`'s
  `artifacts/` line was silently commented out, combined with the prior
  review's finding that a corrupted binary fixture got past the local hook
  once already, suggests the single-hook, single-layer model has a gap; a
  second, independent check at push-time (which can't be silently
  bypassed by an edited `.gitignore` the way the local hook's assumptions
  can) would catch this class of leak even when the primary gate doesn't
  fire. https://github.com/gitleaks/gitleaks
- **`storageState({ indexedDB: true })`** (Playwright ≥1.51) — still
  relevant if the live-discovery blocker in `current-state-and-phase56.md`
  is in fact still open (not re-verified this review): Google OAuth session
  state for JobRight plausibly lives in IndexedDB, which default
  `storageState()` silently drops. https://playwright.dev/docs/auth
- **Stagehand** (`browserbase/stagehand`) — still a closer architectural fit
  than a full autonomous agent for the still-planned Workday fallback, and
  arguably also a more auditable pattern than the extension-delegation
  approach PR #63 just shipped: narrow, cached LLM calls per step, replayed
  deterministically once resolved, versus handing the whole first pass to
  opaque third-party extension code. https://github.com/browserbase/stagehand

**tSearch**

- **Autorubric** (arXiv, 2025) — still applicable to hardening the rubric
  YAML system now that `scoreBreakdown.ts` (landed 08-19) is already
  exposing per-criterion score components in the digest; Autorubric's
  per-criterion reliability measurement would give a principled way to
  decide which of those newly-visible components are actually trustworthy
  signal. https://arxiv.org/html/2603.00077v2
- **Prometheus 2 / GLIDER** — partially subsumed by `scoreBreakdown.ts`
  shipping its own explainability this cycle; still worth a look for
  span-level ("which part of this repo/post triggered the score") rather
  than component-level explanation.
- **GitHub-graph-first identity resolution** — directly relevant to the
  08-19 tightening of GitHub-attachment to require a URL back-link to the
  known LinkedIn/site: a GraphQL-based collaboration-graph approach could
  extend that same corroboration logic to hop-1/hop-2 expansion without
  needing LinkedIn as the anchor at all, continuing the shift away from
  LinkedIn as primary discovery mechanism that Proxycurl's 2025 shutdown
  already argues for.

---

## Changelog

- **2026-08-21** — Ninth review, first to reach `main`/`master` since
  08-07. Baselined on the 08-19 draft (`claude/epic-pasteur-purjf5`),
  reconciled against current `HEAD` in both repos (independently re-verified
  the resume-PDF count via `git ls-tree`, found the commented-out
  `artifacts/` `.gitignore` line as a new root cause, re-verified the
  tSearch PII blob directly, confirmed both repos' public visibility and
  zero open issues/PRs via the GitHub API). Added §4's new "review process
  itself isn't closing the loop" finding and pushed this update directly to
  the session's designated review branches
  (`claude/busy-clarke-6eyjpj` / `claude/epic-pasteur-6eyjpj`) rather than a
  fresh one-off branch, so it's discoverable without spelunking through
  eight prior unmerged drafts.
- **2026-08-09 through 2026-08-19** — Eight reviews drafted on unmerged
  branches (`claude/epic-pasteur-27u1xf/by0hjn/559fdc/kr7842/kz1f9y/purjf5`
  and jobright equivalents); never merged. See git history on those branches
  for the full incremental record.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state (both repos: zero open
  issues, zero open PRs at time of review). Verified the critical PII/public-repo
  finding directly (`git ls-files`, file content, repo visibility) rather
  than relying solely on subagent report.
