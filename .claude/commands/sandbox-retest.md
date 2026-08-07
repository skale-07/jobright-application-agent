---
description: Interpret the latest guarded live-fill report against the validation ladder
---

Find the newest live-fill report under `artifacts/ats-fill/` (e.g.
`greenhouse-live/live-fill-report.json`) and interpret it honestly:

1. Per field: intended value, fill outcome, and **verify outcome** — trust only the
   deterministic read-back verify, never the fill step's own success claim.
2. Combobox/select fields: if verify failed, extract the actual option list captured in
   the report and name the exact mismatch (our value vs. available options).
3. Healer activity: list every heal note, and whether the healed selector's result was
   independently verified. An unverified heal is `UNVERIFIED`, full stop.
4. State the validation level this run demonstrates per capability
   (`docs/validation-levels.md`) and whether it promotes, confirms, or **demotes** any
   claim currently made in `docs/`.
5. End with: fields green / fields red / concrete next fix for each red field.

If no report exists or it's older than the most recent code change to the fill path, say
so — do not interpret stale evidence as current.
