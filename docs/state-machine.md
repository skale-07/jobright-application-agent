# State machine

Canonical application states live in SQLite (`applications.state`). Every transition inserts into `application_events` inside the same transaction.

## States (V1)

`DISCOVERED` → `DUPLICATE_CHECK` → `ELIGIBILITY_CHECK` → (`FILTERED_OUT` | `QUEUED`) → materials → application inspection → (`ESSAY_REQUIRED` | `AUTH_REQUIRED` | `CAPTCHA_REQUIRED` | `AMBIGUOUS_FIELD` | `UNSUPPORTED_ATS` | `READY_TO_SUBMIT`) → `SUBMITTING` → (`SUBMITTED` | `SUBMISSION_VERIFICATION_FAILED`) → contacts/LinkedIn/email/drafts → `COMPLETED`

Failure terminals: `FAILED_RETRYABLE`, `FAILED_FINAL`.

## Rules

- SQLite is authoritative; `state.json` is an export.
- Uncertain submission confirmation creates a `review_items` row and marks the idempotency key `uncertain` — auto-resubmit blocked.
- Leases prevent two runs from mutating the same application concurrently.

## Uncertain-submission resolution (operator only)

`SUBMISSION_VERIFICATION_FAILED` has exactly three exits, all driven by a human
through `review:resolve` — never by automation:

| Edge | Meaning |
| --- | --- |
| `→ SUBMITTED` | Operator confirmed the receipt exists (`--outcome submitted`); the submissions row is marked VERIFIED from the operator's evidence |
| `→ FAILED_RETRYABLE` | Operator confirmed nothing was submitted (`--outcome not-submitted --requeue`); idempotency key is failed so a fresh attempt may be queued |
| `→ FAILED_FINAL` | Operator abandons the application |

The `submissions` table gets a `PENDING` row **before** any submit click, so a
crash mid-submit always leaves evidence that an attempt was in flight.
