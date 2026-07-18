# State machine

Canonical application states live in SQLite (`applications.state`). Every transition inserts into `application_events` inside the same transaction.

## States (V1)

`DISCOVERED` → `DUPLICATE_CHECK` → `ELIGIBILITY_CHECK` → (`FILTERED_OUT` | `QUEUED`) → materials → application inspection → (`ESSAY_REQUIRED` | `AUTH_REQUIRED` | `CAPTCHA_REQUIRED` | `AMBIGUOUS_FIELD` | `UNSUPPORTED_ATS` | `READY_TO_SUBMIT`) → `SUBMITTING` → (`SUBMITTED` | `SUBMISSION_VERIFICATION_FAILED`) → contacts/LinkedIn/email/drafts → `COMPLETED`

Failure terminals: `FAILED_RETRYABLE`, `FAILED_FINAL`.

## Rules

- SQLite is authoritative; `state.json` is an export.
- Uncertain submission confirmation creates a `review_items` row and marks the idempotency key `uncertain` — auto-resubmit blocked.
- Leases prevent two runs from mutating the same application concurrently.
