---
description: Run the full verify gate and report pass/fail per check
---

Run the four-check verify gate for this repo, each check separately so a failure is
attributable:

1. `npm run typecheck`
2. `npm run test`
3. `npm run check:forbidden`
4. `npm run check:secrets`

Rules:
- Do not set or export any of the fail-closed env flags to run tests; if a test needs a
  flag enabled, the test is wrong.
- Report a one-line pass/fail table for the four checks, the test count, and — on any
  failure — the exact failing output, not a paraphrase.
- A red gate blocks committing. Do not commit, and do not "fix" the gate by weakening a
  check, extending an allowlist, or skipping a test.
