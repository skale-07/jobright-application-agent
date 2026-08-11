# Workday adapter (Tier-2: portal auth + multi-page wizard)

Status: **selectors UNVERIFIED_SELECTOR** until the first live capture. The
`/improve` loop promotes them from the form snapshots each run writes.

Workday differs from the Tier-1 ATSes (Greenhouse/Lever/Ashby/Workable) in
two ways that shaped this adapter:

1. **Per-tenant account wall.** Every `<tenant>.wdN.myworkdayjobs.com` site
   requires signing in or creating an account before the application form
   is reachable. `src/verification/portalAuth.ts` handles this
   deterministically (operator directive 2026-08-11): on a recognized
   Workday host it signs in with the standing candidate email + the vault's
   per-host password, or creates the account, and completes the emailed
   verification **only when the page actually shows a verification prompt**.
2. **Multi-page wizard.** The application is My Information → Experience →
   questions → Voluntary Disclosures → Review, not a single form. This
   adapter fills **My Information** from the approved plan and uploads the
   resume; pages it does not model route to human review via the pipeline's
   completeness gate rather than being force-filled. `submit()` only ever
   clicks the FINAL `bottom-navigation-submit-button` and is gated exactly
   like every other adapter.

## Pieces

| File | Role |
|---|---|
| `src/ats/workday/urlValidation.ts` | `<tenant>.wdN.myworkdayjobs.com/[locale/]<site>/job(details)/<slug>_<REQ>`; normalizes off apply/login suffixes; extracts tenant + requisition id |
| `src/ats/workday/selectors.ts` | `data-automation-id` hooks (apply button, auth form, wizard nav, My Information fields) |
| `src/ats/workday/v1.ts` | `WorkdayAdapterV1` — detect / inspect (flags the account wall) / fill My Information / upload / submit final page |
| `src/ats/workday/submission.ts` | final-submit click + confirmation classification (Lever-shaped) |
| `src/ats/workday/fill.ts` | resume upload + honest no-op reset (wizards have no form reset) |
| `src/verification/portalAuth.ts` | deterministic sign-in / create-account / emailed-verification, host-gated |

## Safety rails specific to Workday

- **Credential-spray guard**: `portalAuth` types credentials ONLY on a
  recognized ATS auth host (`isRecognizedAtsAuthHost`). "A page said Sign
  In" is never enough on an arbitrary host.
- **Same email, unique password**: the candidate email is the one the
  verification scanner reads; the password is the vault's per-host random
  value (never a shared secret). Passwords/codes ride memory only and are
  scrubbed from every artifact.
- **Verification only on demand**: the mailbox is scanned only when the
  page shows a verification prompt (`verificationEvidencePresent`), never
  speculatively.
- **Submit unchanged**: `AUTOMATION_ENABLED` + arm budget + `assertSubmitAllowed`
  + the final-page-only submit selector all still apply.

## Wiring

- URL recognition: `detectAtsFromUrl` (dispatch) + `KNOWN_ATS_HOSTS`
  (`myworkdayjobs.com` suffix) + jobright `externalAtsAnchors`.
- Adapter registry: `listAdapters()` (detection order after workable).
- Live fill: `runAtsLiveFill` runs `authenticateAtsPortal` before planning
  when the binding is `workday` and the page is on a recognized host
  (execute-only, `NAVIGATION_ENABLED`-gated); an uncleared wall parks with
  `AUTH_REQUIRED`.
- Congruence: `extractOrgSlug` returns the tenant subdomain as the
  employer slug.

## Operator prerequisites

- `NAVIGATION_ENABLED=true` for portal auth to run (it mutates a
  third-party site).
- A mailbox provider (`GMAIL_VERIFICATION_ENABLED` /
  `OUTLOOK_VERIFICATION_ENABLED`) for tenants that email a code.
- First live run against a real tenant will capture the DOM; expect to
  promote selectors from `UNVERIFIED_SELECTOR` once verified.
