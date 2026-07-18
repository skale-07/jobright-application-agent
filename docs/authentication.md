# Authentication

## Separate services

| Service | storageState | Persistent profile |
| --- | --- | --- |
| JobRight | `private/auth/jobright.storage.json` | `private/browser-profiles/jobright/` |
| LinkedIn | `private/auth/linkedin.storage.json` | `private/browser-profiles/linkedin/` |
| Outlook | `private/auth/outlook.storage.json` | `private/browser-profiles/outlook/` |

Never share a browser context or persistent profile across services.
Never copy the user’s normal Chrome profile.

## Session modes

```text
STORAGE_STATE          # default
PERSISTENT_CONTEXT     # per-service fallback if storageState is insufficient
```

Override per service:

```text
SESSION_MODE_JOBRIGHT=PERSISTENT_CONTEXT
```

Or:

```text
npm run login:jobright -- --mode PERSISTENT_CONTEXT
```

## Login

```text
npm run login:jobright
npm run login:linkedin
npm run login:outlook
```

Flow: headed Chromium → manual sign-in → Enter in terminal → validate URL heuristics → save state → never store passwords.

## Mid-run expiry

If validation fails mid-workflow, create a `review_items` row (`AUTH_REQUIRED`), stop work that needs that service, and preserve completed application data.

## Sensitive candidate profile

1. Copy `private/candidate/sensitive-profile.example.json` → `sensitive-profile.draft.json`
2. Fill values locally
3. `npm run candidate:encrypt-sensitive`
4. Draft is deleted; `sensitive-profile.enc` remains
5. On Windows, AES key is wrapped with DPAPI into `master.key.dpapi` (CurrentUser scope)

Do not put the raw key in `.env` next to the enc file. Tests may use `ALLOW_INSECURE_CANDIDATE_KEY=1` + `CANDIDATE_DATA_KEY`.
