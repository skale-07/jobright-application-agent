# House rules

Mirror of `.cursor/rules/house-rules.mdc` — keep both files identical when editing.

## Safety invariants (never negotiable)

- Every mutation capability is behind a fail-closed env flag (see `.env.example`):
  `FORM_FILL_ENABLED`, `SUBMIT_ENABLED`, `DRY_RUN`, `OUTLOOK_DRAFTS_ENABLED`,
  `EMAIL_GENERATION_ENABLED`, `AGENT_AUTHORING_ENABLED`, `AGENT_FALLBACK_ENABLED`,
  `NATIVE_AUTOFILL_ENABLED`, `JOBRIGHT_AUTOFILL_ENABLED`, `MATERIALS_DOWNLOAD_ENABLED`,
  `LINKEDIN_ENRICHMENT_ENABLED`, `NAVIGATION_ENABLED`, `GMAIL_VERIFICATION_ENABLED`,
  `SCREENER_LLM_MATCH_ENABLED`,
  `OUTLOOK_VERIFICATION_ENABLED`, `AUTOMATION_ENABLED`.
  Flags are enabled only in an operator's shell for a
  specific guarded run — never hardcoded, never defaulted on, never enabled inside tests.
- Never write Outlook send-style APIs. `scripts/check-forbidden.ts` bans the identifiers
  (source list: `src/outlook/sendGuards.ts`); do not extend its allowlist to make code compile.
- Never weaken `assertExecutableApprovedEntry` or the submit gating (submit requires an
  approved plan entry + `SUBMIT_ENABLED` + explicit operator confirmation).
- Form values come only from the approved plan. Free-text/essay fields and demographic
  (EEO/self-ID) fields are never auto-filled — they route to review items for the human.
- `chromium.launch` is allowed only in session infrastructure
  (`src/auth/serviceSession.ts`, `src/auth/loginFlow.ts`, `src/browser/fixtureSession.ts`).
  Everything else enters the browser through those seams.
- Never commit `private/`, `.env*` (except `.env.example`), `.history/`, real resumes/PDFs,
  or stored browser state. The pre-commit hook enforces this — install it once with
  `npm run hooks:install` and never bypass with `--no-verify` on a true positive.

## Verify gate (run before every commit)

```
npm run typecheck && npm run test && npm run check:forbidden && npm run check:secrets
```

All four must pass. Tests must not require live network or enabled flags
(`tests/helpers/fillEnvIsolation.ts` guards fill-related env).

## Validation ladder

Every "it works" claim states its level — `UNIT_CONFIRMED`, `FIXTURE_CONFIRMED`,
`LIVE_READ_ONLY_CONFIRMED`, `LIVE_MUTATION_CONFIRMED`, or `UNVERIFIED`
(see `docs/validation-levels.md`). A lower level never promotes a capability.
An agent's self-report (including a healer's) carries no level until independently
verified by a deterministic read-back. Demote claims on counter-evidence.

## Working protocol

- One milestone = one commit; the message says what changed and why.
- Author ≠ verifier: nontrivial diffs get a review pass (fresh eyes or `/code-review`)
  before merge.
- SQLite (`data/`) is the source of truth for application state; state transitions go
  through the state machine (`docs/state-machine.md`), never ad-hoc status writes.
- Selectors live in versioned registries, not inline in flow code.
- `docs/operator-guide.md` is the operator contract — update it when CLI behavior changes.
- Attempt caps on every retry loop; no unbounded polling or healing loops.
