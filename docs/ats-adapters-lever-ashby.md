# Lever + Ashby adapters (wired)

Status doc for the `src/ats/lever/` and `src/ats/ashby/` adapters. Both
implement the full `ApplicationAdapter` contract and are **wired** into the
system: registered in `src/ats/registry.ts` (between greenhouse and
generic), reachable from the fixture inspector, `planApplicationFill`
(`src/applications/applicationFiller.ts`), the pipeline URL gates and
`NATIVE_AUTOFILL_RUNNING`/`READY_TO_SUBMIT` stages, `runAtsSubmission`
(via the `ATS_BINDINGS` capability table in
`src/applications/atsBindings.ts`), the shared guarded live fill
(`src/applications/atsLiveFill.ts`), enqueue `--employer-url` validation,
and the `ats:inspect`/`ats:fill`/`submit` CLI commands.

## Validation levels

Every capability below is proven against **synthetic, hand-authored
fixtures** (`tests/fixtures/ats/{lever,ashby}*/SYNTHETIC_FIXTURE.json`
markers), modeled on each platform's public form conventions but **not
captured from live pages**. `FIXTURE_CONFIRMED` is the ceiling for every
claim in this table. The live paths are wired and guarded but **no live
run has been performed** — live rungs stay UNVERIFIED until an operator
executes one.

| Capability | Lever | Ashby |
|---|---|---|
| detect / URL validation / registry routing | UNIT_CONFIRMED | UNIT_CONFIRMED |
| discoverFields | UNIT_CONFIRMED | UNIT_CONFIRMED (incl. button-group pass) |
| inspect + inspector routing | UNIT_CONFIRMED | UNIT_CONFIRMED |
| plan pipeline routing (essay/demographics/file/unmapped) | UNIT_CONFIRMED | UNIT_CONFIRMED |
| full-name composition (fail-closed) | UNIT_CONFIRMED | UNIT_CONFIRMED |
| fill + read-back verify (incl. wired dispatcher) | FIXTURE_CONFIRMED | FIXTURE_CONFIRMED |
| combobox commit/read (own module, `ashby/comboboxFill.ts`) | n/a (native selects) | FIXTURE_CONFIRMED |
| resume upload | FIXTURE_CONFIRMED | FIXTURE_CONFIRMED |
| resetForm | FIXTURE_CONFIRMED | honest `reset:false` (SPA) |
| submit (gated) + verifySubmission | FIXTURE_CONFIRMED | FIXTURE_CONFIRMED |
| pre-mutation live gate (`preMutationGate.ts`) | FIXTURE_CONFIRMED | FIXTURE_CONFIRMED |
| live fill / live inspect / live submit | UNVERIFIED (wired, never run) | UNVERIFIED (wired, never run) |

## Capability differences vs greenhouse (encoded in ATS_BINDINGS)

- **Essays**: `supportsEssayFill: false`. An application with human essay
  answers on Lever/Ashby fails closed BEFORE any page mutation
  (`FAILED_BEFORE_CLICK` + MANUAL review item; the app stays
  READY_TO_SUBMIT and retryable once essay fill is wired).
- **Healing**: `supportsHealing: false` — the selector healer is
  greenhouse-proven only; failed verifies go straight to refusal.
- **Live page gate**: `verifyPageBeforeMutationGeneric` is DELIBERATELY
  WEAKER than greenhouse's identity verification — Lever/Ashby URLs carry
  no board-token/job-id pair to cross-check, so the gate proves only:
  trusted final host, no login wall, no blocking CAPTCHA, application form
  present. An ATS-mismatch double-check (URL claim vs page-detected
  adapter) runs in both submit and live fill.
- **Cover letters**: no file input on either ATS; callers skip with a note.
- **Full name**: single field composed from `legal_name.first` +
  `legal_name.last` (`src/ats/shared/nameComposition.ts`), fail-closed on
  incomplete names; annotation happens inside `planApplicationFill`.

## Known risks

1. Synthetic-fixture fidelity: real Lever hCaptcha-gated submits, Ashby
   virtualized listboxes, and real `/thanks` redirects can invalidate
   selectors. Capture sanitized real DOM before promoting any claim past
   FIXTURE_CONFIRMED.
2. Real Ashby sometimes renders Yes/No as hidden radios under styled
   labels; dispatch covers both shapes but only the button-group flavor is
   fixture-proven.
3. The greenhouse embed-URL form (`/embed/job_app?for=…`) has no
   Lever/Ashby equivalent handling — parity gap only, not a defect.

## Operator step before any live claim

Run the guarded read-only path first:

```
npm run ats:inspect -- --url https://jobs.lever.co/<company>/<uuid>/apply
npm run ats:fill -- --url <url>            # plan_only, no flags needed
npm run ats:fill -- --url <url> --execute  # FORM_FILL_ENABLED=true DRY_RUN=false, operator shell only
```

Then replace the synthetic fixtures with sanitized captures and re-run the
suites before any submit attempt.

## Deferred follow-ups

- Essay fill + selector healing for Lever/Ashby (capability flags flip in
  `atsBindings.ts` when proven).
- Real-DOM fixture capture replacing the synthetic set.
- `src/ats/shared/` extraction of the deliberate duplication left by the
  pre-wiring constraint: URL-validator rejection battery (3 copies),
  upload/reset helpers, `isApprovedExecutable` guard, adapter plan-context
  plumbing. The upload name-OR-size verification should be tightened when
  extracted.
- Greenhouse `liveFill`/`liveInspect` remain greenhouse-specific by design;
  fold them into the shared runner only after the lever/ashby live paths
  have real-world mileage.
