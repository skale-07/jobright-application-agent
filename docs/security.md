# Security

## Gitignored

`private/`, `artifacts/`, `data/`, `cache/`, `traces/`, `screenshots/`, `fixtures/live-captures/`, `.env`, `*.storage.json`, `*.enc`, browser profiles.

## Sensitive candidate data

- Public profile: gitignored plaintext JSON (Phase 1: `.example.json` only committed).
- Sensitive profile: encrypted `sensitive-profile.enc` (Phase 2). Key via DPAPI / OS secret store — **not** in `.env` beside the file.
- Never infer demographics; never let an LLM choose them.

## Dashboard

Bind `127.0.0.1` only. Do not expose publicly.

## Outlook

No production `sendEmail`. Only `createDraft` / `verifyDraft` (stubs until Phase 12). `npm run check:forbidden` fails if send paths appear.

## Checks

- `npm run check:forbidden` — bans Outlook send and related flags.
- `npm run check:secrets` — rejects staging of storage states, resumes, drafts, sensitive JSON, etc.
