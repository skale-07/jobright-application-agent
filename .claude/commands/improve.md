---
description: One improvement cycle — analyze newest run artifacts, fix, gate, PR with a testable prediction
---

Run ONE cycle of the stage-1 self-improvement loop: turn the newest live run
data into a reviewed, gated pull request. This command changes code; the
human still merges and still arms sessions.

## 0. Freshness check

`git fetch origin master` and compare against the last artifact commit you
analyzed. If there is no new run data (no new `artifacts/console/runs/`,
`artifacts/navigation/`, or `artifacts/ats-fill/` content on master), STOP
and report "no new run data" — do not invent work.

## 1. Analyze (evidence before code)

For each new automation run: read `report.json` (per-app stop reasons, notes,
`nav_audit`, `artifact_autopush`), the nav reports (`phase_trace`,
`congruence`, agent turn logs, `agent-trace.jsonl` when present), live fill
reports (`plan_fields`, `form_snapshot_*.html`), and `logs.jsonl` for the
streamed phase/agent events. First check the PREDICTION made by the previous
improvement PR (its body states one) against this run's artifacts — record
CONFIRMED or REFUTED with the evidence line.

Rank findings by what blocks a verified submission, in this order: wrong
behavior > silent gap > parked-by-design friction > cosmetics. Infrastructure
failures (wedged CDP Chrome, missing operator files) are OPERATOR notes, not
code fixes — name them in the PR body instead of coding around them.

## 2. Fix (bounded)

- Work on the designated feature branch off latest master; one cycle = one PR.
- Prefer fixes reproducible offline from captured artifacts (snapshots,
  traces) with a pinned regression test. A fix with no test is not a fix.
- At most 3 distinct fixes per cycle; park the rest as findings in the PR body.

### Protected paths — NEVER modify in this loop

`src/outlook/sendGuards.ts`, `scripts/check-forbidden.ts`,
`scripts/check-secrets.*`, `src/applications/formFillGuards.ts`,
`src/applications/submissionGuards.ts`, `src/applications/submitConfirmation.ts`,
`tests/helpers/fillEnvIsolation.ts`, `CLAUDE.md` / `.cursor/rules/house-rules.mdc`
safety invariants, `.husky/` hooks, and this file. If a fix seems to require
touching one of these, STOP and write it up as a human decision instead. Never
weaken a gate to make evidence look better; never change flag defaults.

## 3. Gate

`npm run typecheck && npm run test && npm run check:forbidden && npm run check:secrets`
(+ frontend typecheck/build when frontend changed). All green or the cycle
does not ship.

## 4. Ship with a prediction

Push the branch and open a PR. The body MUST contain:
- **Evidence**: which artifacts drove each fix (paths, not vibes).
- **Prediction**: one falsifiable sentence about what the NEXT session's
  artifacts will show if the fix works (e.g. "the Lever card questions will
  appear in the prediction queue with real labels"). The next cycle scores it.
- **Prior prediction verdict**: CONFIRMED/REFUTED/NOT-EXERCISED from step 1.
- **Operator notes**: anything only the human can fix (environment, files,
  merges pending).

Per the validation ladder, every claim ships at the level the evidence
supports — an unexercised fix is UNVERIFIED until a live run's deterministic
read-backs (congruence verdicts, verify results, receipts) confirm it.
