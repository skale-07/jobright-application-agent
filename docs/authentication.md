# Authentication

## Google Sign-In / "browser may not be secure"

Installing Chrome is **not enough**.

Google blocks Sign-In when the browser is **launched/controlled by Playwright**, including system Chrome via `channel: "chrome"`. That is why you still see:

> This browser or app may not be secure

We do **not** add stealth plugins or fingerprint spoofing.

### Required path for JobRight (Google OAuth)

1. Start a normal Chrome with remote debugging (dedicated profile, not your everyday Chrome):

```text
npm run chrome:debug:jobright
```

2. In that window, click Sign in with Google and finish login until JobRight loads.

3. Save the session (Playwright only attaches; it does not drive Google login):

```text
npm run login:jobright -- --cdp http://127.0.0.1:9222
```

Or:

```text
npm run login:jobright:cdp
```

This writes `private/auth/jobright.storage.json`. After that, recorder/automation can reuse storageState.

### What will keep failing

```text
npm run login:jobright
```

(Playwright launches Chrome → Google rejects OAuth)

```text
BROWSER_CHANNEL=chrome
npm run login:jobright -- --mode PERSISTENT_CONTEXT
```

(Same rejection — still Playwright-controlled)

## Separate services

| Service | storageState | Persistent profile |
| --- | --- | --- |
| JobRight | `private/auth/jobright.storage.json` | `private/browser-profiles/jobright/` |
| LinkedIn | `private/auth/linkedin.storage.json` | `private/browser-profiles/linkedin/` |
| Outlook | `private/auth/outlook.storage.json` | `private/browser-profiles/outlook/` |

CDP debug profile for JobRight: `private/browser-profiles/jobright-cdp/` (gitignored).

Never share a browser context or persistent profile across services.
Never copy the user’s normal Chrome profile.

## Session modes

```text
STORAGE_STATE          # default after CDP save
PERSISTENT_CONTEXT     # fallback for non-Google flows
CDP attach             # required for JobRight Google OAuth login capture
```

Override per service:

```text
SESSION_MODE_JOBRIGHT=PERSISTENT_CONTEXT
```

## Login (non-Google services)

LinkedIn / Outlook can often use:

```text
npm run login:linkedin
npm run login:outlook
```

JobRight with Google: use CDP steps above.

## Mid-run expiry

If validation fails mid-workflow, create a `review_items` row (`AUTH_REQUIRED`), stop work that needs that service, and preserve completed application data.

## Sensitive candidate profile

1. Copy `private/candidate/sensitive-profile.example.json` → `sensitive-profile.draft.json`
2. Fill values locally
3. `npm run candidate:encrypt-sensitive`
4. Draft is deleted; `sensitive-profile.enc` remains
5. On Windows, AES key is wrapped with DPAPI into `master.key.dpapi` (CurrentUser scope)

Do not put the raw key in `.env` next to the enc file. Tests may use `ALLOW_INSECURE_CANDIDATE_KEY=1` + `CANDIDATE_DATA_KEY`.
