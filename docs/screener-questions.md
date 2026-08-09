# Screener questions — the set, and how each gets answered

The "Additional Questions" block is where applications used to park. This
is the curated set (reference specimen: Cohere's Ashby intern form),
each with its policy. Your literal answers live in
`private/candidate/screeners.json` (`npm run screeners:init`, then edit —
answers are typed into forms **verbatim**).

## How an answer is produced (the accuracy ladder)

1. **Label → key**: deterministic patterns first; the flag-gated LLM
   assist (`SCREENER_LLM_MATCH_ENABLED`) maps only leftover labels, sees
   only labels + options + key *descriptions* (never your answers), and
   its output is discarded unless the key exists. Mappings cache per
   label — one model call per novel question, ever.
2. **Key → answer**: your bank answer wins. If the bank is empty and the
   key is *predictable* (education level from your degree, closest
   location from your address), the prediction tier derives one.
3. **Answer → the page**: for choice controls the answer must literally
   match a page option (exact → case-insensitive → curated synonyms).
   No match ⇒ the field parks with the reason named. Never first-option,
   never fuzzy.
4. **Fill → proof**: the existing verify layer re-reads every filled
   value; a wrong screener answer blocks the submit like any other field.
5. **Worked → label**: predictions that pass live verification surface
   via `npm run screeners:suggest` as ready-to-paste bank entries — the
   leeway loop: predict once, verify, promote to a label you own.

## The question set

| Key | Typical wording | Kind | Policy |
|---|---|---|---|
| `availability_full_time` | "Are you available for a full-time internship?" | yes/no | auto-fill from bank |
| `education_level` | "Select the current level of education you are pursuing" | option | auto-fill · **predictable** (from degree) |
| `closest_location` | "Which location are you the closest to?" | option | auto-fill · **predictable** (from address) |
| `how_heard` | "How did you hear about this role?" | text | auto-fill |
| `referral_name` | "(Optional) If you were referred, tell us who" | text | skip when empty |
| `willing_to_relocate` | "Are you willing to relocate?" | yes/no | auto-fill |
| `remote_or_onsite` | "Remote, hybrid, or on-site?" | option | auto-fill |
| `start_availability` | "Earliest start date?" | text | auto-fill |
| `internship_term` | "Which term are you applying for?" | option | auto-fill |
| `hours_per_week` | "Hours per week you can commit?" | text | auto-fill |
| `previously_applied_or_worked` | "Have you previously worked/applied here?" | yes/no | auto-fill |
| `age_over_18` | "Are you at least 18?" | yes/no | auto-fill |
| `non_compete` | "Are you bound by a non-compete?" | yes/no | auto-fill |
| `government_employment` | "Are you a current/former government official?" | yes/no | auto-fill |
| `security_clearance` | "Do you hold a security clearance?" | yes/no | auto-fill |
| `twitter_url` / `portfolio_url` | Social/portfolio links | url | skip when empty |
| `salary_expectations` | "Expected compensation?" | text | **review-only** — your call, every time |
| `notice_period` | "Notice period?" | text | **review-only** |

Never routed here at all (upstream policy, unchanged): **essays** ("What
makes you a good fit…" — yours to write, banked answers via the essay
workflow), **demographics/EEO** (sensitive-profile path only),
**consent checkboxes**, file uploads.

## Growing the set

New question in the wild → it parks with its label in the review item →
add a pattern (or let the LLM mapper catch it) and, if it's a new *kind*
of question, add a registry key + bank entry. The registry is
code-reviewed; the bank is yours.
