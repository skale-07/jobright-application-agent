# Greenhouse live read-only inspection

## Purpose

Open exactly one real Greenhouse application URL, discover and classify visible fields, and produce a **proposed** fill plan — without mutating the page.

## Read-only safety model

Requires:

```text
FORM_FILL_ENABLED=false
DRY_RUN=true
SUBMIT_ENABLED=false
```

Enforced by `assertReadOnlyInspectionAllowed`.

Never fills, uploads, clicks Submit, answers essays, or infers sponsorship.

## Supported URL patterns (initial)

```text
https://boards.greenhouse.io/<board>/jobs/<jobId>
https://job-boards.greenhouse.io/<board>/jobs/<jobId>
https://job-boards.greenhouse.io/<board>/jobs/<jobId>?gh_jid=<jobId>
```

Initial URL validation checks the *requested* URL only.

## Initial URL vs final URL

1. **Initial validation** — reject unsafe schemes, non-Greenhouse hosts, marketing paths.
2. **Navigate** — open only the normalized Greenhouse URL.
3. **Final URL validation** — after navigation, require the final origin to remain on a trusted Greenhouse application host.
4. **Only then** — CAPTCHA, high-confidence login wall, closed-job, form, and field checks.

A redirect from `boards.greenhouse.io` to an employer careers homepage (e.g. Okta → `www.okta.com`) is **not** a Greenhouse application. Classification:

```text
GREENHOUSE_APPLICATION_UNAVAILABLE
```

Neutral wording: the posting is no longer available at that URL / redirected outside supported Greenhouse hosts. Do not claim the role is “closed” unless Greenhouse itself shows an explicit closed-job signal.

### Sanitized regression case (Okta)

```text
Requested: https://boards.greenhouse.io/okta/jobs/7617090
Final:     https://www.okta.com/company/careers/
Expected:  GREENHOUSE_APPLICATION_UNAVAILABLE
Login wall: false  (nav "Login" link is insufficient)
```

## Failure precedence

```text
1. Navigation failure
2. Unsafe / malformed final URL
3. Untrusted final-host redirect → GREENHOUSE_APPLICATION_UNAVAILABLE
4. CAPTCHA
5. High-confidence login wall → LOGIN_WALL
6. Closed / unavailable application (explicit Greenhouse signal)
7. Greenhouse error page
8. Missing application form
9. Zero visible fields
10. Successful identity verification
```

Structural final-host failures always win over page-text heuristics.

## Login-wall evidence

A generic nav/footer **Login** link is **not** a login wall.

High-confidence detection requires strong signals (combinations of auth URL path, password input, email+password, Sign in heading, auth form action, known IdP markers).

Medium/low signals may appear as warnings but must not override an untrusted-host failure.

## Field classifications

| Classification | Proposed action |
| --- | --- |
| DETERMINISTIC | FILL_CANDIDATE |
| SPONSORSHIP | REVIEW_REQUIRED |
| ESSAY | SKIP_ESSAY |
| DEMOGRAPHIC | SKIP_DEMOGRAPHIC |
| FILE_UPLOAD | UPLOAD_CANDIDATE |
| CONSENT | REVIEW_REQUIRED |
| UNSUPPORTED | UNSUPPORTED |
| UNKNOWN | REVIEW_REQUIRED |

## Proposed vs approved plans

- **proposed_fill_plan** — inspection output; contains no candidate values; not executable.
- **approved_plan** — Phase 5 fill path only after human/policy approval; not produced by this command.

## Artifact schema

Written to `artifacts/inspection/greenhouse-inspect-<jobId>-<timestamp>.json`.

Failed runs still write artifacts, including:

```text
validation_level, requested_url, final_url, requested_host, final_host,
redirect_observed, remained_on_trusted_greenhouse_host, failure_code,
failure_reason, login_wall_detection, captcha_detected, form_detected,
field_count, mutation_attempted, upload_attempted, submit_attempted, artifact_path
```

Full HTML and screenshots are not saved by default.

## Manual validation

Preferred integration-sandbox target (Greenhouse-hosted, not a targeted employer app):

```powershell
$GREENHOUSE_URL="https://job-boards.greenhouse.io/simplifyjobsintegrationsandbox/jobs/4344358003"
$env:FORM_FILL_ENABLED="false"; $env:DRY_RUN="true"; $env:SUBMIT_ENABLED="false"
npm run ats:inspect -- --url $GREENHOUSE_URL --headed
```

## Abort conditions

Stop if URL redirects off trusted Greenhouse, CAPTCHA, high-confidence login wall, closed job, field values change, file chooser opens, submit interaction, or raw PII in the artifact.

## Known limitations

**Greenhouse fixture tests do not prove live Greenhouse compatibility.**

A successful manual inspection proves only:

```text
LIVE_READ_ONLY_CONFIRMED
```

It does **not** prove filling, uploading, conditional-field behavior, custom-widget mutation, employer-side file processing, or submission.
