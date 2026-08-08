# Where LLM / agent APIs buy the most time

Assumes PRs #12–#14 merged. The question is placement: given the mission
(the operator's time back), where does a model call return the most
minutes per dollar — and where must one never sit?

The evidence baseline is the first live L3 session: 7 apps, 5 killed by
navigation walls, 1 by a submit-control miss, 0 referral drafts. Time is
lost to **walls**, not to typing — deterministic code already types fast.

## Ranked surfaces (highest time-return first)

### 1. Navigation phase C — the agent that clears walls

**The 71% problem.** Every nav wall an agent clears converts a parked
app (≈5–10 min of human untangling) into a submitted one. The seam
exists (`navigateViaSidecar`, browser-use over the operator's CDP
Chrome); PR #14 made armed sessions able to use it. Optimization now is
throughput: keep the step/turn budgets tight (25 steps, 3 turns — an
agent that can't clear a wall in that budget won't clear it in twice
that), and feed `navigation_attempts` back into a per-host
deterministic-first policy: once a host's walls are learned, skip the
model entirely. **Model shape**: a fast computer-use-capable model;
latency matters more than brilliance — walls are shallow puzzles.

### 2. Selector healing from inventories — the self-repairing adapter

Every `submit control not found` and upload miss now ships a CTA/input
inventory. An LLM that maps inventory → selector-registry patch (human
reviews, registry stays versioned) turns each new ATS variant from a
debugging session into a one-click review. Cheap (text-only, small
context), async (runs after the session, not during), and compounding.
The healer seam exists; point it at the inventories.

### 3. Referral email generation — already placed, optimize for batch

The one surface already using an LLM (OpenAI, drafts only). Time
optimization is not the model call (seconds) but the pipeline: generate
for the whole session's verified submits in one batch after the session,
not inline per app — an armed session should never wait on a text API.
Keep validation + persona checks; drafts stay in the operator's mailbox.

### 4. Field mapping for unknown forms — the Workday unlock (future)

Expanding past Greenhouse/Lever/Ashby means unmapped labels. An LLM that
proposes label → canonical-field mappings (verified by the existing
read-back layer, unknowns parked) is how a new ATS goes from "unsupported"
to "80% filled" without a hand-built adapter. The fill corpus is the
few-shot library. Only worth building when a second discovery platform
lands postings off the big three.

### 5. Contact ranking / essay retrieval — small, later

Rank JobRight-extracted contacts (title relevance) and retrieval-match
banked essay answers to new questions (suggestion only — the human
approves; generation stays banned). Embedding-scale, not agent-scale.

## Where a model must never sit

- **The submit gate, verification, or receipts** — evidence chain stays
  deterministic; a model never decides "did it submit".
- **Essay/self-ID content** — house rule, non-negotiable.
- **Inside the fill loop for known ATSes** — deterministic is faster and
  auditable; a model there adds latency and risk for nothing.
- **Anything unbounded** — every agent call keeps attempt caps and
  wall-clock budgets; self-reports stay UNVERIFIED until read back.

## The shape that falls out

Deterministic spine, model at the edges: models clear walls (1), heal
selectors offline (2), draft outreach in batch (3), and map unknown
forms (4) — each behind its existing fail-closed flag, each feeding the
telemetry corpus that eventually replaces it with learned deterministic
policy. The endgame of every model surface here is its own retirement.
