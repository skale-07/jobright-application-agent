# browser-use evaluation (Phase 6 candidate)

Evaluation of [browser-use](https://github.com/browser-use/browser-use) as a layer for employer ATS application filling.

**Status update:** the `CDP_ATTACH` session-mode prerequisite and the J1 authoring scaffold are now **implemented** (`agent/` + `src/agent/`, inert behind `AGENT_AUTHORING_ENABLED=false`; see [operator-guide.md](./operator-guide.md) §14). The current authoring pass is deterministic DOM reading — no agent loop, no LLM call. J2 (constrained executor) remains unimplemented and gated as described below. Live authoring runs are `UNVERIFIED`.

See also: [validation-levels.md](./validation-levels.md), [architecture.md](./architecture.md), [known-limitations.md](./known-limitations.md).

## Verdict

| Question | Answer |
|---|---|
| Replace the Playwright/Chromium layer? | **No.** |
| Replace the Greenhouse adapter? | **No** — it is already `FIXTURE_CONFIRMED`. |
| Use it to reach the ATSes we currently skip (Workday / iCIMS / Oracle / Lever / Ashby)? | **Yes — this is the case.** |
| Let it decide answer values? | **Never.** |
| Let it click Submit? | **Never.** |
| Local OSS package or Browser Use Cloud? | **Local OSS package.** See [Deployment choice](#deployment-choice). |

The win is **ATS coverage**, not **per-application efficiency**. Those are different claims and only the first one holds.

## What browser-use is

- Python (`>=3.11,<4.0`), MIT, `pip install browser-use` (v0.13.7 at time of writing).
- CDP-native. Playwright was removed in v0.6; it drives Chrome over the DevTools Protocol directly.
- An LLM agent loop: serialize page state → LLM picks an action → execute → repeat, until the task is judged complete.
- Attaches to an already-running Chrome via `Browser(cdp_url=...)`.
- Pins exact dependency versions (`pydantic==2.12.5`, `openai==2.16.0`, …), so it must live in its own virtualenv.

## Why "replace the scraper" is the wrong framing

Our Playwright surface is small: `src/ats/greenhouse/fill.ts` plus the session plumbing. The bulk of what makes this repo correct is policy, and browser-use conflicts with all of it:

| Our invariant | Where | Conflict with an LLM agent loop |
|---|---|---|
| Safe-factual allowlist | `approvedFillPlan.ts` (`SAFE_FACTUAL_CANONICALS`) | Agent sees whole form; would fill anything |
| Never invent sponsorship / work auth | `resolveAnswers.ts` (`normalizeSponsorship`) | LLMs answer plausibly rather than abstaining |
| Never infer demographics | `essayDetector.ts` (`isDemographicsField`) | Explicit ban in [security.md](./security.md) |
| Essays are human-written | `resolveAnswers.ts` | Agent would happily compose one |
| Verified-submission uniqueness | `submissionGuards.ts` | Nondeterministic retry path can double-submit |
| Evidence-graded claims | [validation-levels.md](./validation-levels.md) | `"I submitted the form"` is not evidence |

`architecture.md` states the position directly: *"Not a general autonomous browser agent."* That stays true. browser-use enters as a **constrained subordinate component**, never as the driver.

## Cost direction

Per application on a supported ATS, an agent loop is *worse*: one LLM round-trip per step, ~15–40 steps for a Workday wizard, versus deterministic selector work measured in seconds with zero token cost.

Budget it as **"unlocks jobs we currently drop entirely,"** not as a saving. `src/ats/unsupported.ts` routes Workday, iCIMS, and Oracle/Taleo to `skip_unsupported_ats`; Lever and Ashby are deferred. That is the majority of the market, and hand-authoring an adapter per ATS is the actual bottleneck.

## The safety invariant

> **Separate _what to answer_ from _how to reach the widget_. browser-use may only ever do the second.**

The existing pipeline already emits an `ApprovedFillPlan`: canonical field → approved value, policy-checked, with essays, demographics, unmapped canonicals, and empty work-auth values already stripped out.

If the agent receives **only that plan**, then:

- it never sees the sensitive profile,
- it never sees an essay prompt,
- it never chooses a sponsorship answer,
- every value it types already passed `assertExecutableApprovedEntry()`.

The LLM performs element location. It performs no decision-making. That distinction is the whole design.

## Deployment choice

| Option | Verdict |
|---|---|
| **Local OSS package, Python sidecar over CDP** | **Chosen.** Data stays local; MIT; no vendor coupling; attaches to a Chrome we own. Cost: a Python toolchain in a Node repo. |
| Browser Use Cloud (`browser-use-sdk` on npm) | **Rejected.** Cleaner language fit, but an authenticated JobRight session and candidate PII would leave the machine. Contradicts [security.md](./security.md). Its stealth / proxy-rotation / CAPTCHA-solving features also cross the line drawn in `src/browser/launchOptions.ts` ("not stealth/evasion"). |
| Reimplement the agent loop in TypeScript on our Playwright | **Rejected for now.** No new language, but we would own DOM serialization, retry, and crash recovery — the exact work browser-use has already absorbed. Reconsider only if the sidecar boundary proves worse than the reimplementation. |

The Python boundary is a real cost and should be paid deliberately: pinned venv under `agent/`, invoked as a subprocess, JSON contract on stdin/stdout, no shared process state. Node stays the orchestrator and sole owner of SQLite.

## Integration design

### Phase 6a — agent as adapter author (recommended first)

Build-time only. **Zero production risk.**

1. Agent opens a live Lever / Ashby / Workday application read-only.
2. It emits a field map + selector candidates as JSON.
3. A human promotes it through the existing `recorder:promote` flow.
4. Runtime executes those selectors deterministically — no agent in the loop.

This converts unsupported ATSes into *native* adapters at a fraction of the hand-authoring cost, and takes on no runtime agent risk at all. It also doubles as selector-drift repair for `src/jobright/selectors/v1.ts` and the Greenhouse selectors.

### Phase 6b — agent as constrained executor

Only after 6a demonstrates the agent reads these forms reliably. Scope: Workday first, since multi-page wizards with account creation are where deterministic adapters are weakest.

A `BrowserUseAdapter` implementing the existing `ApplicationAdapter` contract in `src/ats/adapter.ts`:

| Method | Implemented | Notes |
|---|---|---|
| `detect` / `inspect` / `discoverFields` | Deterministic | HTML-only; unchanged, no agent |
| `fill` | Agent | Receives approved plan entries only |
| `uploadResume` / `uploadCoverLetter` | Agent | Path supplied by us; hash verified by us |
| `verify` | Deterministic | Read values back off the DOM |
| `submit` | **Absent** | Not implemented. Not stubbed. Absent. |
| `verifySubmission` | **Absent** | Same |

Registry ordering in `src/ats/registry.ts` becomes: `unsupported` (hard skips) → `greenhouse` (native) → `browser-use` (fallback) → `generic`. Greenhouse stays native.

### Prerequisite: `CDP_ATTACH` session mode

`PlaywrightServiceSession.open()` (`src/auth/serviceSession.ts`) always launches its own browser process and has no CDP-connect mode. The login path already proves the mechanism — `chromium.connectOverCDP()` at `src/auth/loginFlow.ts:115`, plus `scripts/start-chrome-debug-jobright.ts`.

Add a third `SessionPersistenceMode`:

```text
STORAGE_STATE | PERSISTENT_CONTEXT | CDP_ATTACH
```

Under `CDP_ATTACH` the session owns a debuggable Chrome carrying the JobRight storage state and exposes its CDP URL. browser-use attaches to the same endpoint, acts, and detaches; our Playwright code then verifies on the same live page. One browser, one login, no credential duplication.

This change is contained and useful independently of browser-use.

### Guards

A new fail-closed flag alongside the existing triad in `.env.example`:

```text
AGENT_FILL_ENABLED=false
```

`assertAgentFillAllowed()` in `src/applications/formFillGuards.ts` requires `AGENT_FILL_ENABLED=true` **and** `FORM_FILL_ENABLED=true` **and** `DRY_RUN=false`. `SUBMIT_ENABLED` is not consulted, because the agent path has no submit.

Additionally: any agent-driven fill records its submission as `UNCERTAIN` unless deterministic verification confirms the result. `hasUncertainSubmission()` then blocks auto-resubmit for free.

### Validation-level rule

Add to [validation-levels.md](./validation-levels.md) when this lands:

> **Agent-driven actions carry the level of the deterministic evidence collected afterward — never the level the agent reports.**

Without this, agent self-reports silently inflate confidence, which is the precise failure the ladder exists to prevent.

## J2 design — agent fallback (approved direction)

The architecture is **fallback, not agent-first**: deterministic code runs
every time; the agent consumes the *named failure states* the pipeline
already emits. Two features, built in this order:

### Model A — selector healer (Phase 6a′, IMPLEMENTED)

When fill read-back fails, before parking in `AMBIGUOUS_FIELD` /
refusing the submit click:

1. **In-process heuristic** (always on, deterministic): rescan the live
   page for the field by label evidence (`label[for]`, aria-label,
   placeholder, name, id; token-overlap scoring), retry through the normal
   fill path, re-verify by read-back. `src/ats/greenhouse/fillHealer.ts`.
2. **Sidecar escalation** (gated by `AGENT_FALLBACK_ENABLED=false`,
   budgeted per pass): `locate_field` task with the page HTML; ranked
   candidates come back through the zod contract; the retry and the verify
   stay deterministic. `src/agent/locateField.ts` +
   `agent/jobright_agent/author.py`.
3. Give up → exactly the pre-healer behavior (review item, human).

Values re-pass `assertExecutableApprovedEntry` on **every** retry — the
healer relocates fields, it never chooses values. Note the current sidecar
pass is deterministic label-similarity, not an agent loop: 6a′ builds the
*escalation seam*; the J2 executor plugs a richer task type into the same
contract.

### Model B — Workday executor (Phase 6c, NOT built)

A fourth adapter behind the existing `ApplicationAdapter` interface:

| Method | Who |
|---|---|
| `detect` / `inspect` | Deterministic (URL patterns exist in `unsupported.ts`) |
| `fill` | Sidecar agent loop: wizard navigation + fill from the approved plan |
| `verify` | Deterministic-as-possible: sidecar DOM read-back + per-page screenshots + human confirmation |
| `submit` | **Absent.** The agent's final act is to *point at* the submit control; a `runWorkdaySubmission` sibling keeps the full M3 stack — lease, PENDING row, idempotency, confirmation prompt, one click by deterministic code, receipt verification |

Routing: gate on → Workday URLs take the agent path *before* the
`UNSUPPORTED_ATS` park (which stays a dead end); gate off → parks exactly
as today.

Invariants: escalation is one-way and bounded (step/time/call caps,
persisted attempt counter); agent self-reports carry no validation level;
plan values cross into the agent loop only via browser-use's sensitive-data
placeholder mechanism (pin its 0.13.7 behavior in the spike); essays,
demographics, sponsorship never enter the agent's hands; the agent has no
submit-shaped action in its `Tools` registry — structural, not prompt-level.
Account creation and CAPTCHA remain human gates. Artifacts per attempt
(task, step log, screenshots, DOM extract) under `artifacts/agent-fallback/`.

Sequencing gate unchanged: earn live levels on the deterministic Greenhouse
path first (the control), then 6b = Workday read-only wizard census via the
authoring mode, then 6c. Cost framing: ~15–40 LLM calls per Workday
application — fine as "unlocks jobs currently dropped entirely," wrong as a
default path.

## Red lines

- No agent-initiated Submit, in any phase.
- No agent access to the sensitive profile, demographics, or essay composition.
- No CAPTCHA solving, proxy rotation, or stealth. `captcha_detected` → `needs_human_captcha` stays the correct behavior.
- No agent write path to SQLite. Node remains the sole writer.
- No candidate PII or authenticated session leaving the machine.

## Blocked on

Greenhouse fill is `FIXTURE_CONFIRMED`, not live-confirmed, and [phase56-live-validation-plan.md](./phase56-live-validation-plan.md) is unexecuted. Layering an agent on top of a deterministic path that has never run against a live board would mean debugging two unproven layers at once.

**Close Phase 5.6 before starting 6a.**

## Open questions

- Which model, and what is the measured per-application token cost on a real Workday flow?
- Does the agent handle Workday account creation, or does that stay a human gate?
- Can the sidecar JSON contract express "fill this approved plan" tightly enough that the agent cannot wander into unapproved fields — or do we need a post-hoc DOM diff to prove it did not?
- How do leases behave when a single agent step outlives the current lease TTL?
