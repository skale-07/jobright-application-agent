---
description: Triage open review items and latest run artifacts — propose, don't apply
---

Triage the current human-review queue and recent run evidence. This command is
read-only: propose fixes, do not apply them.

1. Run `npm run review` and list every open review item.
2. Check the newest artifacts under `artifacts/` (reports, screenshots, fill results)
   that relate to those items or to the most recent run.
3. Sort every finding into exactly one bucket:
   - **Human-only** — needs a decision or content only the operator can provide
     (essays, demographics, account actions, anything behind a disabled flag).
   - **Fixable in code** — a defect or gap this repo can address; name the file(s) and
     sketch the fix in 1–3 sentences.
   - **Stale** — already resolved or superseded; say what resolved it.
4. End with a short recommended order of attack for the fixable bucket.

Do not resolve review items (`review:resolve`) yourself — that is the operator's call.
