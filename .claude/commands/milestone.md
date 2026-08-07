---
description: Execute one bounded milestone — implement, gate, commit
argument-hint: <milestone description or doc reference>
---

Execute exactly one milestone: $ARGUMENTS

Protocol (house rules in CLAUDE.md apply throughout):

1. **Restate scope** in 2–3 sentences: what will exist after this milestone that doesn't
   now, and what is explicitly out of scope. If the scope is ambiguous, stop and ask
   before writing code.
2. **Implement** — smallest diff that completes the scope. New behavior gets tests at the
   appropriate validation level; state the level you're claiming.
3. **Gate** — run `/gate`. Red gate → fix and re-run; never commit red.
4. **Commit** — one commit for the milestone. Message says what changed and why (the
   motivation, not a file list). Never commit `private/`, `.env*`, artifacts, or fixtures
   containing real personal data.
5. **Report** — scope delivered, test delta (before → after counts), validation level of
   each new claim, and anything deferred with the reason.
