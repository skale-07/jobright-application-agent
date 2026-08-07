# Security

## Incident log

**2026-08-07 (commit 774cc9b):** VS Code's Local History extension shadow-copied `.env` (containing a live OpenAI API key) and real `public-profile.json` snapshots into `.history/`, which was neither gitignored nor matched by `check:secrets` patterns; the real resume PDF was committed alongside. Files were removed delete-forward (they remain in git history) — **the leaked key was rotated and must be treated as burned regardless.** Prevention shipped: `.history/` + `.env_*` gitignored; scan patterns extended (`.env*` non-example, `.history/`, non-example `public-profile*/answer-aliases*` JSON); `check:secrets` is now a pre-commit hook (`npm run hooks:install`, one-time).

## Commit-time enforcement

`npm run hooks:install` (once per clone) points git at `.githooks/`; every commit then runs `check:secrets`. Bypassing with `--no-verify` is for confirmed false positives only.

## Gitignored

`private/`, `artifacts/`, `data/`, `cache/`, `traces/`, `screenshots/`, `fixtures/live-captures/`, `.env`, `*.storage.json`, `*.enc`, browser profiles.

## Sensitive candidate data

- Public profile: gitignored plaintext JSON (Phase 1: `.example.json` only committed).
- Sensitive profile: encrypted `sensitive-profile.enc`. AES-256-GCM; Windows wraps the master key with DPAPI (`master.key.dpapi`, CurrentUser). Do **not** put the raw key in `.env` beside the enc file.
- Auth: `*.storage.json` and `private/browser-profiles/*` are gitignored. Passwords are never stored.
- Never infer demographics; never let an LLM choose them.

## Dashboard

Bind `127.0.0.1` only. Do not expose publicly.

## Outlook

No production `sendEmail` — ever. Drafts only: `createOutlookDraft` / `verifyOutlookDraft` (Phase 12, built) write into the mailbox Drafts folder; sending is the operator's manual act in Outlook. `npm run check:forbidden` fails the build if send paths appear in code or docs.

## Outreach LLM boundary

Outreach email generation is the only LLM call in the codebase (OpenAI, `EMAIL_GENERATION_ENABLED` + `OPENAI_API_KEY` gated). The key lives in `.env` (gitignored), is covered by log redaction, and is never written to artifacts. Generated text is deterministically re-validated; rejected output cannot become a draft.

## Checks

- `npm run check:forbidden` — bans Outlook send and related flags.
- `npm run check:secrets` — rejects staging of storage states, resumes, drafts, sensitive JSON, etc.
