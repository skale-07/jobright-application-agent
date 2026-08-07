# Lever + Ashby adapters (unwired)

Status doc for the `src/ats/lever/` and `src/ats/ashby/` adapters. Both
implement the full `ApplicationAdapter` contract (`src/ats/adapter.ts`) but
are **deliberately not wired**: they are not registered in
`src/ats/registry.ts`, no CLI command reaches them, and the pipeline still
routes their URLs to the generic adapter. They are constructed only by
their own tests. Nothing here changes any pre-existing file.

## Validation levels

Every capability below is proven against **synthetic, hand-authored
fixtures** (`tests/fixtures/ats/{lever,ashby}*/SYNTHETIC_FIXTURE.json`
markers), modeled on each platform's public form conventions but **not
captured from live pages**. `FIXTURE_CONFIRMED` is therefore the hard
ceiling for every claim in this table; no live level is claimed anywhere.

| Capability | Lever | Ashby |
|---|---|---|
| detect / URL validation | UNIT_CONFIRMED | UNIT_CONFIRMED |
| discoverFields | UNIT_CONFIRMED | UNIT_CONFIRMED (incl. button-group pass) |
| inspect (captcha/login-wall/shell warnings) | UNIT_CONFIRMED | UNIT_CONFIRMED |
| plan pipeline routing (essay/demographics/file/unmapped) | UNIT_CONFIRMED | UNIT_CONFIRMED |
| full-name composition (fail-closed) | UNIT_CONFIRMED | UNIT_CONFIRMED |
| fill + read-back verify | FIXTURE_CONFIRMED | FIXTURE_CONFIRMED |
| resume upload | FIXTURE_CONFIRMED | FIXTURE_CONFIRMED |
| resetForm | FIXTURE_CONFIRMED | honest `reset:false` (SPA) |
| submit (gated) + verifySubmission | FIXTURE_CONFIRMED | FIXTURE_CONFIRMED |
| any live behavior | UNVERIFIED | UNVERIFIED |

## Design notes

- **Full-name composition** (`src/ats/shared/nameComposition.ts`): both
  platforms render a single "Full name" field; the entry rides the
  `legal_name.first` canonical with a composed "First Last" value and a
  truthful reason string, failing closed to `REVIEW_REQUIRED` when either
  component is missing. `SAFE_FACTUAL_CANONICALS` and
  `assertExecutableApprovedEntry` are untouched. Each adapter's
  `setApprovedFillPlan(plan, profile)` applies composition internally so it
  cannot be skipped.
- **Executor reuse**: the generic executor in `src/ats/greenhouse/fill.ts`
  (no greenhouse selectors inside) drives both adapters' fill/verify.
  Ashby adds `buttonGroupFill.ts` for its role=radiogroup segmented
  controls — options from the real DOM, `pickOptionLabel` matching,
  commitment confirmed by independent `aria-pressed` read-back. Ashby's
  portal combobox needed **no** variant module: the generic combobox path
  is role-based and passes as-is.
- **Submission**: per-ATS `submission.ts` mirrors the Greenhouse split —
  `submit()` opens with `assertSubmitAllowed` (fail-closed flags),
  `verifySubmission()` is read-only, screenshots either way, and throws
  `SubmissionUncertainError` unless explicitly confirmed. Lever confirms on
  markers or the `/thanks` URL; Ashby confirms only on the in-page panel
  (URL never changes and is treated as neutral).
- **Ashby is a SPA**: static fetches return an unrendered shell;
  `looksLikeUnrenderedShell` makes `inspect()` warn instead of silently
  reporting an empty form. All Ashby field work requires a rendered DOM.

## Known risks (from the build plan)

1. Synthetic-fixture fidelity: real Lever hCaptcha-gated submits, Ashby
   virtualized listboxes, and real `/thanks` redirects can invalidate
   selectors. Capture real DOM before any live milestone.
2. Real Ashby sometimes renders Yes/No as hidden radios under styled
   labels; the executor's dispatch covers both shapes but only the
   button-group flavor is fixture-proven.
3. Until wiring, `detectAts()` routes Lever/Ashby URLs to the generic
   adapter — expected and accepted.

## Operator step before any live work

Capture sanitized rendered DOM from a handful of real postings (guarded
read-only `ats:inspect`-style run once wiring exists, or the J1 authoring
sidecar) and replace the synthetic fixtures, keeping the
`SYNTHETIC_FIXTURE.json` markers updated. Only then can any claim climb
past FIXTURE_CONFIRMED.

## Future wiring milestone (will edit pre-existing files)

- `src/ats/registry.ts`: register both adapters (order: unsupported →
  greenhouse → lever → ashby → generic).
- `src/applications/atsFixtureInspect.ts`: add fixture names.
- `src/applications/applicationFiller.ts` + `submitRun.ts`: adapter
  dispatch beyond Greenhouse (idempotency + unattended caps).
- `src/pipeline/runPipeline.ts`: per-ATS URL validation dispatch.
- `src/cli/index.ts` + `docs/operator-guide.md`: inspect/fill commands.
- Per-ATS live orchestration (liveInspect/liveFill equivalents) behind
  `withPublicUrlPage`; real-DOM fixture capture.
- `src/ats/shared/` refactor: move the generic executor out of the
  greenhouse folder; give `nameComposition` companions there.
