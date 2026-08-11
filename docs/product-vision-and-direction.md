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
| Last reviewed | 2026-08-11 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**), `skale-07/tSearch` (**public**) |

**Note on the field above**: both repos are public. A 2026-08-07/09 draft of
this doc described jobright as "private" — verified false this review
(`visibility: "public"` via the GitHub API). jobright's `.gitignore`/CLAUDE.md
discipline (no `.env*`, no `private/`, no browser state tracked — spot-checked
via `git ls-files`, only `.example.*` templates present) means this correction
is a documentation-accuracy fix, not a new live-exposure finding, unlike the
tSearch PII item in §4.

**Note on provenance**: a fuller "second review" was drafted 2026-08-09 on
unmerged branches (`claude/epic-pasteur-27u1xf` / `claude/busy-clarke-27u1xf`)
but never merged to either `main`/`master`. This review treats that draft as
its baseline and reconciles it against everything that has actually landed on
the default branches since, rather than starting from the last-merged
2026-08-07 version.

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

**This review's central finding is that a third surface has since emerged —
`auto:cycle` scheduled automation — whose *operating posture*, not its safety
gates, has drifted from that stated vision. See §1.3 and §4.**

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI (multiple gated call sites, no longer one) / Express + React console frontend.
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`) exportable via `npm run training:export`. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (full list in `CLAUDE.md`, plus newer additions below). `chromium.launch` is confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere — **re-verified this review by running it directly: `check-forbidden: ok`.** Free-text/essay and demographic fields are architecturally incapable of being auto-filled — they route to `review_items`; `ESSAY_DRAFT_ENABLED` may generate a SUGGESTION into that review item, but only human-approved text ever fills. **Verified this review**, reading `src/screeners/`: the answer-bank/prediction system respects the same invariant — `SCREENER_PREDICT_LLM_ENABLED` predictions land in the review item and require an explicit "Approve & save" click before ever reaching a form.
- **Flags added since last review:** `SUBMIT_REQUIRES_LOCAL_CONFIRMATION` (defaults `true` in code — `src/config/env.ts`), `MAX_UNATTENDED_SUBMISSIONS_PER_RUN` (defaults `0`, hard cap per armed session), `ESSAY_REQUIRED_GATE_ENABLED` (default off), `ARTIFACT_AUTOPUSH_ENABLED`, `CDP_AUTOLAUNCH_ENABLED`, plus console-only `CONSOLE_HOST`/`CONSOLE_PORT`.
- **LLM boundary invariant has changed — update from prior reviews:** the vision doc previously described "one narrow call site only." **That is no longer accurate.** `c137030` introduced `makeLlmClient()` (Anthropic-preferred, OpenAI fallback) and live LLM usage is now read across at least 6 call sites: outreach generation, essay drafts, screener label mapping, screener predictions, the submit-inventory healer's proposal drafting, and the Python nav-agent sidecar. Each surface is still individually flag-gated and each still routes through the same approved-plan/review-item machinery downstream — this is not a new safety gap — but the doc's own "narrow call site" framing should stop being repeated as current.
- **ATS coverage today:** Greenhouse (inspect/fill/submit shipped, `FIXTURE_CONFIRMED`, live paths `UNVERIFIED`). Lever and Ashby are wired end-to-end (registry, planner, `AtsBinding` dispatch, CLI) but **unchanged since 2026-08-09** — `docs/ats-adapters-lever-ashby.md` still reads `UNVERIFIED (wired, never run)` for both; no commit in this review window touched `src/ats/lever/` or `src/ats/ashby/`. Two **new** adapters landed this window: **Workday** (URL recognition, a new portal-auth module reusing the existing per-host credential vault, multi-page "My Information" wizard fill, submit bound through the same gates) and **Workable** ("Tier-1" fill/verify/submit/congruence pattern, 14 new tests). Both are honestly labeled `UNVERIFIED_SELECTOR` in their own docs — authored from public form conventions, not a live capture — the same discipline Greenhouse went through first.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

A very large wave of feature work has landed since the last (unmerged)
2026-08-09 draft — Workday/Workable adapters, an `auto:cycle` unattended
scheduling mode, sender-trust link-handling changes, Gmail verification via
browser scan replacing the REST API, and more. The center of gravity has
shifted again: from "prove the existing surface live" to "a new, broader
*operating mode* now exists, and its risk profile needs to be understood on
its own terms, separately from L3."

- **Live JobRight discovery: functionally resolved, but the canonical docs
  are now actively wrong, not just stale.** `docs/current-state-and-phase56.md`
  still flatly states "the live discovery path has never produced a job"
  (`jobs_inspected: 0`). This is **directly contradicted by the repo's own
  committed artifacts**: real automation-session logs (`fixture: false`) show
  discovery completing with `inspected: 8`, and 2026-08-11 auto-cycle reports
  show `apps_started: 13` and `14` in separate live cycles. `operator-guide.md`
  was already updated to describe discovery as working — so the two canonical
  docs no longer even agree with each other, and neither is being checked
  against the artifacts the system itself produces. **This is now a
  documentation-integrity risk in its own right** (see §4), independent of
  the underlying capability, which appears to actually work.
- **L3 armed unattended apply has NOT graduated past `FIXTURE_CONFIRMED`.**
  Read directly from real (non-fixture) run artifacts: every automation-session
  and auto-cycle report shows `submits_used: 0` even where `max_submits: 10`
  and the arm was live. Apps reach review states (`AMBIGUOUS_FIELD`,
  `FAILED_RETRYABLE`, `UNSUPPORTED_ATS`) but no real submit-click has occurred
  yet. `operator-guide.md` §18's own language is unchanged: "the first
  verified live submit is what promotes this path... treat everything before
  that as unverified."
- **`auto:cycle` + a standing `.env` + a Windows Scheduled Task is a new,
  broader operating mode — this is the headline finding of this review.**
  Verified by reading `src/automation/autoCycle.ts` and `src/applications/submitRun.ts`
  directly. Once an operator writes a standing gitignored `.env` with every
  capability flag enabled (including `SUBMIT_ENABLED=true`,
  `SUBMIT_REQUIRES_LOCAL_CONFIRMATION=false`,
  `MAX_UNATTENDED_SUBMISSIONS_PER_RUN=10`) and installs the documented
  Scheduled Task (`/SC HOURLY /MO 4`), the system **self-arms and runs with no
  per-run human click** — the CLAUDE.md/vision-doc language of "operator
  keeps every judgment call" now describes L3's manual-arm path but not this
  one. Every safety *gate* underneath is intact and unweakened (code defaults
  stay fail-closed, the per-click submission budget is consumed atomically,
  kill switches exist: delete the `.env`, disable the task,
  `AUTOMATION_ENABLED=false`) — but the *authorization* for an unattended real
  submission has been reduced to "a config file exists and a scheduled task is
  installed," which is a materially different operating posture than the one
  this document has been describing. No live submit has happened yet (see
  above), so the realized risk today is bounded, but the capability is armed
  and documented as intended for regular unattended use every 4 hours.
- **A real security loosening in sender-trust link handling (commit
  `ecc0979`) — flag this specifically.** Read the diff directly:
  `extractMagicLink` previously **hard-rejected** any link whose host didn't
  match the sending domain or an explicit allowlist. It now treats domain
  match as a ranking *boost* only; any `https://` link with a
  verification-shaped path (`verify|confirm|magic|auth|token|activate|login|click`)
  qualifies with **zero domain-affinity requirement**, and the nav-agent
  sidecar's `allowed_domains` is widened to the link's host and actually
  navigates there — using the operator's authenticated browser session. The
  filter behind this is a subject/preview keyword regex, not sender
  authentication (no SPF/DKIM check). Downstream congruence + final-URL
  validation still stops a bad link from ever producing stored application
  data ("wastes a turn, never stores a URL"), which bounds the *application*
  blast radius — but the browser still actively visits an attacker-influenced
  URL with a live authenticated session if a phishing-style email lands with
  a verification-sounding subject. This is a genuine, not hypothetical,
  widening of phishing surface and belongs in the risk table, not just a
  changelog line.
- **`operator-guide.md`'s claim that the improvement loop "opens AND (by
  standing operator grant) merges the gated loop PR" autonomously is
  unsupported by anything found in this repo** — `.claude/commands/improve.md`
  itself still says "the human still merges and still arms sessions," and no
  merge-automation exists in-repo (no CI workflows, no `gh pr merge` calls).
  This is either stale/aspirational doc text, or a real capability that lives
  entirely outside this repo (e.g. a Claude Code session permission granted
  out-of-band). **This document does not assert which is true — it needs an
  operator to confirm**, since "agent proposes a PR" and "agent unattendedly
  merges changes to its own safety-relevant codebase" are very different risk
  profiles and the doc currently can't tell you which one is real.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  silent multi-ATS expansion beyond the four now wired, replacing any
  deterministic adapter with an LLM agent as the default path, loosening L3's
  numeric caps.
- **Next up:** reconcile `current-state-and-phase56.md` against reality (an
  operator re-run + doc update, not new code); a first live-armed submit to
  actually promote L3 past `FIXTURE_CONFIRMED`; live-DOM proof for Lever,
  Ashby, Workday, and Workable; and a direct decision on whether the
  sender-trust relaxation should be tightened back toward domain affinity
  now that it's been surfaced.

Deeper detail (unchanged by this doc, still canonical — though see the
staleness note above for `current-state-and-phase56.md` specifically):
[`architecture.md`](./architecture.md) ·
[`current-state-and-phase56.md`](./current-state-and-phase56.md) ·
[`operator-guide.md`](./operator-guide.md) ·
[`ats-adapters-lever-ashby.md`](./ats-adapters-lever-ashby.md) ·
[`ats-adapter-workday.md`](./ats-adapter-workday.md) ·
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

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / Anthropic + OpenAI (provider-selectable) / Resend.
- **Pipeline:** `resolve identity (LinkedIn + website) → expand graph hop-1 (GitHub collaborators/followers, Substack) → optional hop-2 (UI-driven only) → score (final_score heuristic) → persist (candidates.json, profiles/, data/people/) → assess (LLM judges, priority_score) → digest email`, now with an optional autopilot chain (sweep → resolve → discovery → assessment → digest → send) and an in-repo GitHub-first "footprint sweep" that pre-qualifies olympiad-CSV names before ever touching LinkedIn.
- **Discovery/Assessment/Presentation separation is load-bearing:** assessment reads only the frozen `output/candidates.json` — it never re-runs LinkedIn discovery or corrects a wrong identity match. `final_score` (discovery) and `priority_score` (assessment) are deliberately never collapsed into one number — **re-confirmed this review**: the new experience-distinctiveness judge and recruiter-label judge both verified (by grep) to never touch `priority_score`.
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass, now joined by an experience-distinctiveness judge (routing boost only) and a label judge that maps outputs to recruiter-facing archetypes/tiers. Judges are instructed to coerce (demote/backfill) rather than hard-fail on missing evidence IDs.
- **Safety-flag layer — partially closed, real gap remains.** `CLAUDE.md` and `.cursor/rules/tsearch.mdc` now exist (added 2026-08-10) and document fail-closed boundaries in prose (no PII in git, gated email sends, paced LinkedIn scraping, mock-LLM default). **Verified this review**: there is still no forbidden-API checker equivalent to jobright's `check:forbidden`, and no repo-wide `*_ENABLED` naming convention (`grep -rn "_ENABLED\b" src/ server/` returns nothing) — instead a looser pattern of individually-named, individually-verified-safe flags (`ASSESSMENT_MOCK_LLM`, `AUTOPILOT_LIVE_LLM`, `AUTOPILOT_SEND`, `AUTO_ASSESS_LIVE`, `ORACLE_LLM`, UI/`server` dry-run defaults). Each one checked defaults safe, but nothing mechanical would catch a *future* flag added without the same discipline, unlike jobright's CI-enforced check. Downgrade from "no house-rules file" (fixed) to "no enforcement mechanism" (still open).

### 2.3 Technical direction

A large amount of work landed since the 2026-08-07 review, addressing two of
the four risks flagged at that time and adding meaningful new surface. **This
is the opposite of the 2026-08-09 draft's note that "no commits have landed
in tSearch" — that was true as of 08-09, but a full day-plus of work landed
2026-08-10, all after that draft was written.**

- **Ownership-share scoring bug: fixed, verified by reading the code and a
  new regression test.** The previous fallback path synthesized a commit
  sample entirely from the candidate's own commits when no real sample was
  available, forcing `candidate_commit_share ≡ 1.0` and enabling false
  `primary_creator` attribution. The fix removes the synthetic fallback
  entirely — with no real sample, share is now correctly omitted rather than
  inflated. `tests/assessment/ownership.test.ts` asserts this. **This risk is
  resolved**, not just claimed.
- **Mid-run LinkedIn auth-guard: added, verified by reading the code.**
  `assertLinkedInAuth(page)` now runs after every LinkedIn navigation (4 call
  sites) and throws loudly on a login/checkpoint/authwall redirect instead of
  silently extracting garbage. First LinkedIn test suite in the repo
  (`tests/linkedin/authGuard.test.ts`). **This risk is resolved.** The
  broader `tsearch-playwright-system-audit.md` audit item this came from also
  flagged zero retry/trace/screenshot capture on scrape failures and no
  homonym-mismatch rejection using captured country — **neither of those two
  is addressed yet**; the audit item should be downgraded, not closed.
- **Digest feedback loop is now built, not just designed.** The 2026-08-07
  doc described Phase 3–4 (feedback capture, ranking refinement) as "designed
  but not built." That's now stale: `src/digest/feedbackStore.ts` plus
  `/api/feedback*` routes and Relevant/Not-relevant/Explore-network UI
  buttons are live, and `buildDigest` uses stored feedback to hide
  not-relevant candidates and boost relevant ones — without ever touching
  `priority_score` directly, preserving the discovery/assessment separation.
  Ranking-refinement-*from* feedback (vs. filtering/reordering) is still the
  open remainder of that roadmap.
- **New: a "system-knowledge oracle"** — a deterministic Tier 0 system-brief
  generator (`npm run brief`) plus a Tier 1 BM25-indexed MCP server
  (`src/oracle/`) that explicitly excludes PII-bearing directories from its
  index (confirmed by a dedicated test), with LLM synthesis opt-in only
  (`ORACLE_LLM=1`).
- **New: an "autonomy package"** — cross-run network-bridge scoring
  (`convergence.ts`), a GitHub-first footprint sweep that never touches
  LinkedIn or promotes an unverified guess into `links.github_url`
  (`footprintSweep.ts`), and an `autopilot.ts` chain that is fail-closed by
  default (mock LLM, dry-run send, hard-fails if `cookies.json` is missing
  rather than proceeding without a session).
- **New risk worth tracking: auto-assess now runs by default at the end of
  every pipeline run.** Previously assessment was a fully separate, explicit
  step. `runPipeline.ts` now auto-triggers assessment for qualifying
  candidates unless `AUTO_ASSESS=0` is explicitly set. It's individually
  fail-closed (mock LLM unless `AUTO_ASSESS_LIVE=1`), but an operator who sets
  `AUTO_ASSESS_LIVE=1` in `.env` for convenience now gets live LLM spend on
  *every* future pipeline run, not just when they intend to assess. Worth a
  line in the risk table (§4) as low-grade scope creep, not a safety gap.
- Anthropic API is now a selectable provider (`LLM_PROVIDER=anthropic`)
  alongside OpenAI — **verified this is not a new gating pattern**, it extends
  the pre-existing `llmUseMock()` fail-closed-without-a-key logic to be
  provider-aware rather than introducing new live-by-default behavior.
- Open product question, still unresolved: whether digest emails should
  surface global top-N candidates or per-seed neighbors, and whether
  Substack-only (no GitHub) candidates should be filtered out of the digest
  at all.
- **Verify gate re-run this review** (after `npm install`, since
  `node_modules` wasn't current in this checkout): `npm run typecheck` clean,
  `npm run test` 186/186 passing across 36 files. Repo is not currently
  broken.

Deeper detail (in `skale-07/tSearch`, not this repo): `docs/implementation-prompt.md` ·
`docs/all-agents-wiring-verification.md` · `docs/email-digest-implementation-context.md` ·
`docs/system-brief.md` (generated, Tier 0 oracle context)

---

## 3. How the two projects relate

jobright-application-agent is a **hardened descendant** of tSearch's session/
scraping infrastructure, not an unrelated project. `docs/tsearch-reuse-map.md`
(tSearch repo) records the original reuse plan: tSearch's `saveSession.ts` /
`linkedinBrowser.ts` concepts (manual storageState login, lazy session
open/validate) and atomic-JSON-store pattern were the seed for jobright's
`ServiceSession` and `src/storage/` layers, explicitly rebuilt with more
hardening (coverage statuses, mid-run auth checks — now matched on tSearch's
side too, see §2.3 — traces/screenshots, no committed profile artifacts, a
design choice tSearch has now also adopted going forward per §2.2, though not
retroactively into history per §4). tSearch's product logic — olympiad
scoring, GitHub graph expansion, the seed-tree UI — was deliberately **not**
ported; the two products solve different problems (apply vs. discover) and
share only the "safely drive a browser session against a third-party site"
substrate.

**The architectural-philosophy gap between the two repos has narrowed on
safety documentation (tSearch now has a CLAUDE.md) but widened on LLM
containment.** jobright's LLM usage was previously "one narrow call site,"
tighter than tSearch's; that is no longer true (§1.2) — jobright's surface
has grown to match tSearch's multi-call-site pattern. What still
differentiates them is *enforcement*: jobright's flags are backed by a CI
`check:forbidden` script and a named `*_ENABLED` convention; tSearch's are
individually-safe-by-inspection but mechanically unenforced (§2.2). Both
repos now also have a genuinely unattended, scheduled-automation surface —
jobright's `auto:cycle` (§1.3, real submissions possible) and tSearch's
autopilot (§2.3, fail-closed to mock/dry-run by default) — worth watching as
a shared pattern, since a gating bug in either would look similar from the
outside (a scheduled task silently doing something consequential).

One document is stale on the reuse-plan point specifically: `docs/tsearch-reuse-map.md`
still describes porting `linkedinExtract.ts` into a `packages/linkedin-enrichment`
module "in Phase 10," but `current-state-and-phase56.md` records that
LinkedIn enrichment was **dropped by decision** for the MVP (JobRight contact
context only). Low-severity, unchanged since 2026-08-07.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | tSearch | `profiles/`/`backup/` (202 files) real-people LinkedIn PII is **untracked from the current tree** (fixed 2026-08-10, `.gitignore` now covers it) but **still fully present and fetchable in git history** on this public repo — verified directly this review by reading a PII blob out of an old, still-reachable commit. The fix commit's own message says "history purge still required separately," and nothing since has scheduled that purge. | Unchanged in substance from the original finding: this is a live public exposure of real people's data, not a hypothetical, and current-tree cleanliness does not fix it. `git filter-repo`/BFG + force-push + collaborator re-clone is still the concrete unblock, and it is the single highest-priority item across both repos this review. |
| **High** | jobright | **New this review.** `auto:cycle` + a standing `.env` + an installed Windows Scheduled Task (`/SC HOURLY /MO 4`) is a genuinely unattended fill-and-submit operating mode: no per-run human click, self-arming, running indefinitely on a schedule. All underlying gates are intact (fail-closed defaults, atomic per-click budget, kill switches), but "operator keeps every judgment call" no longer describes this path — the authorization is reduced to "a config file exists." No live submit has occurred yet (verified from real run artifacts), so realized risk is currently bounded, but the capability is armed and intended for regular use. | This is the kind of drift that's easy to miss because no individual gate was weakened — the *posture* changed instead. Worth a deliberate decision: is 4-hourly unattended real-submission automation actually the intended product shape, or does it need an additional standing-authorization gate (e.g. a time-boxed re-arm requirement, matching L3's timed-window design) before it's treated as normal operation? |
| **High** | jobright | **New this review.** Sender-trust magic-link handling (`ecc0979`) replaced a hard sender-domain-affinity filter with a soft ranking boost; a link now qualifies on a subject/preview keyword match alone (no sender authentication), and the nav-agent sidecar actively navigates to it using the operator's authenticated browser session. Downstream congruence checks stop a bad link from producing stored application data, but the browser still visits an attacker-influenced URL on a phishing-style email. | This is a genuine, code-verified security loosening (not a hypothetical) — a textbook phishing-surface widening that's easy to wave through under "improves magic-link handling" framing. Worth a direct decision on whether to tighten domain affinity back to a hard filter, or add sender-authentication (SPF/DKIM) as a precondition. |
| **High** | jobright | `docs/current-state-and-phase56.md` is now **actively contradicted by the repo's own committed artifacts** — it says live discovery "has never produced a job" while real, non-fixture automation logs show `inspected: 8` and auto-cycle reports show 13–14 real applications started. `operator-guide.md` was already updated and no longer agrees with it. | This has moved from "ambiguous, needs reconciliation" (2026-08-09 framing) to "flatly wrong and nobody is checking the phase doc against the system's own output." An operator or future agent trusting this doc would materially misjudge the product's actual state — worth a same-day fix (it's a doc update, not new code) given how easy the fix is relative to the cost of leaving it. |
| **High** | tSearch | ~~`assessment-rubric-architecture-audit.md` ownership-share denominator bug~~ — **RESOLVED this review**, verified by reading the fix and its regression test (`tests/assessment/ownership.test.ts`). Moved out of the active table; see §2.3 and the changelog. | (Resolved — kept here only to make the resolution visible against the prior review's table, will drop next cycle.) |
| **Medium** | jobright | `operator-guide.md` claims the improvement loop "opens AND (by standing operator grant) merges the gated loop PR" autonomously. Nothing in this repo supports that — `.claude/commands/improve.md` itself still says a human merges, and no merge-automation exists in-repo. | This document cannot currently tell you whether "agent proposes, human merges" or "agent unattendedly merges to its own safety-relevant codebase" is the real state of affairs — those are very different risk profiles. Needs an operator to confirm directly; flagged rather than asserted either way. |
| **Medium** | jobright | Lever, Ashby, Workday, and Workable are all wired end-to-end but **unverified against real DOM** — Lever/Ashby unchanged since 2026-08-09 (`UNVERIFIED (wired, never run)`); Workday and Workable are new this window and honestly labeled `UNVERIFIED_SELECTOR` in their own docs. | Four adapters now share the "fixture green ≠ live green" gap Greenhouse already worked through individually — the honest labeling is good discipline, but the live-proof backlog has grown, not shrunk. |
| **Medium** | tSearch | No fail-closed safety-flag *enforcement* — `CLAUDE.md` now documents the boundaries in prose (closing the "no house-rules file" gap from last review), but there is still no forbidden-API checker or `*_ENABLED` naming convention comparable to jobright's CI-enforced `check:forbidden`. | Downgraded from the prior review (the documentation gap is closed) but the mechanical gap remains: a future change could silently violate "assessment reads frozen `candidates.json` only" or collapse `final_score`/`priority_score` and nothing in CI would catch it. |
| **Medium** | tSearch | `tsearch-playwright-system-audit.md` HIGH items — **partially addressed**: mid-run re-authentication detection is now live (§2.3, resolved). Still open: zero retry/trace/screenshot capture on scrape failures, and captured country is still never used to reject homonym mismatches. | Downgraded from the prior review's framing (one of the two named risks is fixed) but the remainder is unchanged — wrong-person matches can still silently enter the candidate graph, and live failures are still hard to diagnose after the fact. |
| **Low** | tSearch | **New this review.** Auto-assess now runs by default at the end of every `runPipeline` invocation (opt-out via `AUTO_ASSESS=0`), individually fail-closed (mock unless `AUTO_ASSESS_LIVE=1`) but a global convenience setting of `AUTO_ASSESS_LIVE=1` would mean every future run silently spends on live LLM calls. | Not a safety gap — a cost/scope-creep item worth knowing about before it surprises someone's OpenAI/Anthropic bill. |
| **Low** | jobright | The "one narrow LLM call site" description in earlier reviews is no longer accurate — live LLM usage now spans 6+ gated call sites (outreach, essays, screener mapping/prediction, inventory-healer proposals, nav sidecar). Each stays individually flag-gated and routes through existing review/approval machinery; this is a documentation-accuracy item, not a new safety gap. | Worth correcting so future reviews don't cite a stale invariant as if it still bounds the system's LLM surface area. |
| **Low** | tSearch | Digest-loop ranking-*refinement*-from-feedback (as opposed to feedback capture, which is now built — §2.3) is still unbuilt; the global-vs-per-seed and Substack-only-filtering product questions remain unresolved in the docs. | Not a defect, tracked so it doesn't silently drop off the roadmap now that feedback capture might read as "done enough." |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a Phase 10 LinkedIn-enrichment port that was dropped by decision (§3). Unchanged since 2026-08-07. | Doc drift; low cost to fix, low cost of leaving it. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **Human-oversight-by-design browser-agent patterns** (e.g. Asteroid,
  Straiker's runtime guardrails for agentic browsers) — externally validate
  the shape jobright already has for L3 (scoped credentials, human-approval
  gates on irreversible actions, action logging, a kill switch), and are
  directly relevant to the new `auto:cycle` finding in §4: the general 2026
  guidance for unattended browser automation is consistently "human-approval
  gates for irreversible actions" as a *structural* requirement, not an
  optional extra — worth using as an external reference point when deciding
  whether `auto:cycle`'s standing-config authorization model needs an
  additional time-boxed re-arm gate to match that guidance.
- **CDP session-handoff discipline** — carried over from the last review,
  still relevant now that the console, the nav-layer sidecar, and `auto:cycle`
  can all potentially want the same CDP Chrome instance; worth a deliberate
  check that only one driver ever attaches at a time.
- **`storageState({ indexedDB: true })`** (Playwright ≥1.51) — no longer
  urgent given discovery appears to work in practice (§1.3), but still worth
  trying if the phase-56 doc reconciliation turns up a real remaining gap.

**tSearch**

- **`git filter-repo` / BFG history purge, executed, not just planned** — the
  concrete unblock for the Critical PII finding in §4. This is not a new
  suggestion (recommended last review too) but it's now the single most
  overdue action item in either repo, so it's repeated here deliberately
  rather than dropped for being "already noted."
- **GitHub push protection with a custom secret-scanning pattern** matching
  the scraped-profile JSON shape (name + LinkedIn URL + photo URL) — still
  relevant as a recurrence-prevention measure to pair with the history purge
  above, so a future scrape-and-commit accident is caught at push time.
- **Judge Reliability Harness** (arXiv 2603.05399) and the broader 2026
  LLM-as-judge literature's emphasis on Krippendorff's-alpha-style
  inter-rater reliability and calibration-context anchoring — directly
  applicable now that tSearch has *two more* judges than last review
  (experience-distinctiveness, recruiter-label) stacked on top of the
  already-`requires_calibration`-flagged priority-v2 scoring and Cory
  persona. Each new judge widens the surface that's shipped without a
  measured agreement number; this pairs with the existing Autorubric
  recommendation rather than replacing it.
- **Autorubric** (arXiv, 2025) — repeated from last review, still unapplied,
  still the right fit for hardening the rubric YAML system.

---

## Changelog

- **2026-08-11** — Third review (this one). Baselined against the unmerged
  2026-08-09 draft rather than the last-merged 2026-08-07 version, per the
  session-start-ritual instruction to check `claude/epic-pasteur*` branches
  for a fresher copy. tSearch: verified two previously-flagged risks
  genuinely resolved (ownership-share bug, mid-run auth guard) by reading the
  fix code and its tests directly, not just the commit message; verified the
  PII-history risk is *unchanged* (current tree clean, history still
  unpurged — read a real PII blob out of a still-reachable old commit to
  confirm); found one new low-severity risk (auto-assess on by default).
  jobright: found the discovery-status question has flipped from "ambiguous"
  to "docs actively contradicted by the system's own artifacts"; found L3
  still has not graduated past `FIXTURE_CONFIRMED` (verified via real
  run-artifact JSON, zero live submits so far); found two new High risks —
  the `auto:cycle` unattended-scheduling operating-posture shift, and a real
  security loosening in sender-trust magic-link handling — both verified by
  reading the actual diffs/code, not inferred from commit messages; corrected
  this doc's own "private" mislabel for the jobright repo (it's public, but
  cleanly gitignored, so no new live exposure); flagged an unresolved
  documentation/reality question about claimed autonomous PR-merge capability
  rather than asserting either way. Both repos: zero open issues, zero open
  PRs at time of review.
- **2026-08-09** — Second review (drafted on `claude/epic-pasteur-27u1xf` /
  `claude/busy-clarke-27u1xf`, never merged — used as this review's baseline
  per above). tSearch: zero commits since 2026-08-07 beyond the vision-doc
  merge itself at that point in time; §2 reconfirmed unchanged. jobright:
  large feature wave landed (Lever/Ashby wiring, navigation layer, operator
  console, L3 armed automation, screener answer-bank, essay draft assistant,
  telemetry export, branding/site) — §1 rewritten. Surfaced the
  discovery-status doc disagreement (since escalated, see 2026-08-11 above).
  Both repos: zero open issues, zero open PRs at time of review.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state (both repos: zero open
  issues, zero open PRs at time of review). Verified the critical PII/public-repo
  finding directly (`git ls-files`, file content, repo visibility) rather
  than relying solely on subagent report.
