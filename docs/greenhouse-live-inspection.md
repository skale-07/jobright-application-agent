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

1. **Initial validation** — reject unsafe schemes, non-Greenhouse *requested* hosts, marketing paths. This is the URL we open, not a lock on where the employer may send the browser.
2. **Navigate** — open the normalized Greenhouse URL.
3. **Final URL** — record host and redirect. A company-domain landing (`jumptrading.com/hr/job?gh_jid=…`, `careers.datadoghq.com/…?gh_jid=…`) is not a refuse. Host is never a gate.
4. **Then** — CAPTCHA, high-confidence login wall, closed-job, form, and field checks. If the form lives in an iframe, hop into that frame and re-check.

A redirect from `boards.greenhouse.io` to an employer **careers homepage with no form** fails as `FORM_NOT_FOUND`. A redirect onto the employer's apply page (same `gh_jid`, or an embedded Greenhouse frame) proceeds. Do not claim the role is “closed” unless Greenhouse itself shows an explicit closed-job signal.

### Sanitized regression case (Okta careers homepage — no form)

```text
Requested: https://boards.greenhouse.io/okta/jobs/7617090
Final:     https://www.okta.com/company/careers/
Expected:  FORM_NOT_FOUND
Login wall: false  (nav "Login" link is insufficient)
```

## Failure precedence

```text
1. Navigation failure
2. Unsafe / malformed final URL
3. CAPTCHA
4. High-confidence login wall → LOGIN_WALL
5. Closed / unavailable application (explicit Greenhouse signal)
6. Greenhouse error page
7. Missing application form
8. Zero visible fields
9. Successful identity verification
```

Host is recorded (`remained_on_trusted_greenhouse_host`) and never overrides page-state checks.

## Login-wall evidence

A generic nav/footer **Login** link is **not** a login wall.

High-confidence detection requires strong signals (combinations of auth URL path, password input, email+password, Sign in heading, auth form action, known IdP markers).

Medium/low signals may appear as warnings but must not abort inspection.

## Field classifications

| Classification | Proposed action |
| --- | --- |
| DETERMINISTIC | FILL_CANDIDATE |
| SPONSORSHIP | REVIEW_REQUIRED |
| ESSAY | SKIP_ESSAY |
| DEMOGRAPHIC | SKIP_DEMOGRAPHIC |
| FILE_UPLOAD | UPLOAD_CANDIDATE |
| CONSENT | FILL_CANDIDATE (terms / privacy / certify only; marketing stays unmapped) |
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
