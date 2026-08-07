# Security

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
