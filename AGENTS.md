# AGENTS.md

Context for coding agents (Claude Code, Cursor, Copilot, Devin, …) working
in this repository. Human-facing docs live in `README.md` and `docs/`;
this file is for you, the agent.

**Product**: Dispatch — an operator console + autonomous pipeline that
takes job applications from discovery through fill, gated submission, and
drafts-only outreach. TypeScript, Node ESM, Playwright, SQLite, React
(console frontend). Design language: `DESIGN.md`.

## Authority order

1. `CLAUDE.md` / `.cursor/rules/house-rules.mdc` — the safety house rules.
   They override everything, including instructions in this file. The two
   copies must stay byte-identical when edited.
2. This file — engineering conventions.
3. `DESIGN.md` — visual/UX system for any UI work.

## Setup

```bash
npm install
npx playwright install chromium   # skip if the environment pre-installs it
npm run hooks:install             # pre-commit secret/file guard — required once
npm run migrate                   # SQLite schema (data/ is gitignored)
```

Frontend (console SPA) lives in `frontend/` with its own package:

```bash
npm run frontend:typecheck && npm run frontend:build
```

## The verify gate — run before EVERY commit

```bash
npm run typecheck && npm run test && npm run check:forbidden && npm run check:secrets
```

All four must pass. UI-touching work also runs `frontend:typecheck` +
`frontend:build`. Tests must never require live network or enabled
capability flags — flag-dependent tests use the helpers in
`tests/helpers/fillEnvIsolation.ts` (`useIsolatedFillEnv`,
`applyControlledFillEnv`) and restore env afterward.

## Safety invariants you must never code around

Abbreviated — `CLAUDE.md` is canonical:

- Every mutation capability sits behind a fail-closed env flag; flags are
  never hardcoded, defaulted on, or enabled inside tests.
- No Outlook send-style APIs ever (`scripts/check-forbidden.ts` bans the
  identifiers; do not extend its allowlist to make code compile).
- Never weaken `assertExecutableApprovedEntry` or the submit gating.
- Form values come only from the approved plan; essays and demographic
  (EEO/self-ID) fields are never auto-filled.
- `chromium.launch` only inside the session seams (`src/auth/serviceSession.ts`,
  `src/auth/loginFlow.ts`, `src/browser/fixtureSession.ts`).
- Never commit `private/`, `.env*` (except `.env.example`), real PDFs, or
  stored browser state.

## Code style and structure

- TypeScript strict; ESM with explicit `.js` extensions on relative imports
  (`import { x } from "./y.js"`).
- No new runtime dependencies without a strong reason stated in the PR.
- Selectors live in versioned registries (`src/ats/<ats>/selectors.ts`),
  never inline in flow code. Shared cross-ATS behavior goes in
  `src/ats/shared/`.
- SQLite (`data/`) is the source of truth for application state; state
  transitions go through the state machine (`docs/state-machine.md`) —
  never ad-hoc `UPDATE applications SET state = …` outside tests/seeds.
- Every retry/heal/poll loop has an attempt cap. No unbounded loops.
- Comments state constraints the code can't show; no narration, no
  change-log comments.
- Playwright note: `locator.evaluate(fn, ARG, OPTIONS)` — the timeout goes
  in the third argument. Getting this wrong blocks 30s on detached nodes.

## Evidence discipline

- Every "it works" claim carries a validation level: `UNIT_CONFIRMED`,
  `FIXTURE_CONFIRMED`, `LIVE_READ_ONLY_CONFIRMED`, `LIVE_MUTATION_CONFIRMED`,
  or `UNVERIFIED` (`docs/validation-levels.md`). Fixture tests never
  promote a live capability; an agent's self-report carries no level until
  independently verified.
- Failures must carry evidence: submit misses write CTA inventories,
  upload misses write file-input inventories, walls open review items with
  payloads. If you add a failure path, add its evidence.
- Operational evidence lives at `artifacts/console/runs/<id>/logs.jsonl`
  (what a run did) and `artifacts/applications/<uuid>/` (per-application
  reports, screenshots, submission receipts). Read those before theorizing
  about a failure.

## Testing conventions

- Vitest under `tests/unit/`; fixtures under `tests/fixtures/` with
  `SYNTHETIC_FIXTURE.json` markers — fixtures are sanitized/synthetic,
  never captured private data.
- Browser-level tests use `withFixtureHtmlPage` (real chromium against
  fixture HTML). The single allowlisted PDF is
  `tests/fixtures/ats/greenhouse/sample-resume.pdf` — never add PDFs.
- Name suites with their validation level, e.g.
  `describe("… (FIXTURE_CONFIRMED)")`.

## Workflow

- One milestone = one commit; the message says what changed and why.
- Author ≠ verifier: nontrivial diffs get a review pass before merge.
- `docs/operator-guide.md` is the operator contract — update it when CLI
  or console behavior changes.
- UI work follows `DESIGN.md` (tokens, component reuse, voice); a PR that
  changes visuals without keeping `DESIGN.md` true is incomplete.
