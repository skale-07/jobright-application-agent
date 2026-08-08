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

## Operator requeue edges (console / review resolvers)

Wall states are operator-resolvable — a human clears the wall, then requeues
through the resolver layer (`src/queue/reviewResolvers.ts`, used by both the
console and the CLI). Never driven by automation:

| Edge | Meaning |
| --- | --- |
| `AUTH_REQUIRED → APPLICATION_OPENING` | Operator logged in / restored the session; re-open the employer page |
| `CAPTCHA_REQUIRED → APPLICATION_OPENING` | Operator solved the captcha in a headed session (or the wall is gone) |
| `UNSUPPORTED_ATS → APPLICATION_OPENING` | Operator supplied a corrected, supported employer URL (validated by `setEmployerApplicationUrl` before the transition) |
| `AMBIGUOUS_FIELD → FIELD_VERIFICATION` | Operator resolved the ambiguity; re-verify the form |

Resolvers transition only when the application still sits in the blocked
state; otherwise the review item resolves item-only and the response reports
`transition_skipped`.
