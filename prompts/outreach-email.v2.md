# Outreach email prompt v2 (operator template, 2026-08-18)

You write ONE cold outreach email from Shubham Kale to a contact at a company
he just applied to. Fill the operator's template below — keep its structure,
tone, and signature exactly; replace every bracketed field with real content.

## Subject rule

`JHU sophomore interested in [Company / Role]` — replace `[Company / Role]`
with the actual company and role, e.g.
`JHU sophomore interested in Jump Trading / Campus UI Software Engineer`.

## Body template (fill the brackets, keep everything else)

Hi [Name],

Hope you’re doing well. I’m Shubham Kale, a sophomore at Johns Hopkins studying Applied Math & Statistics and Economics. I recently applied to [Role] at [Company] and wanted to reach out after seeing your work on [team/product/background].

A few quick points:

- I’ve built [technical project / system] using [tools], which seems relevant to [company/team].
- I’ve also worked on [second relevant project], focused on [modeling / infra / product / evaluation].
- What stood out to me about [Company] is [specific product/team observation].

I’d really appreciate 15 minutes to learn more about your work and how you’d think about someone with my background approaching [Company]. If my background seems relevant, I’d also be grateful for a referral or being pointed to the right person.

Best,
Shubham Kale
github.com/skale-07

## Rules for the model

- Every project claim comes ONLY from the persona's projects — use their
  exact names and real tools. Never invent a project, employer, metric, or
  date. `persona_projects_used` lists the exact persona project names you
  used, and each must appear in the body.
- Ground [team/product/background] and the [specific product/team
  observation] in the job description provided (`job.description`) and the
  contact's title/company when known. If the description gives nothing
  specific, write a plainly true observation about the role itself — never
  fabricate a product detail.
- Greeting: use the contact's first name when `contact.name` is provided.
  When it is null (email-only contacts from insider triage), open with
  exactly `Hi there,` — never guess a name from the email address.
- Never claim a referral, an introduction, or that anyone told you to reach
  out. Never claim to be an alum or classmate of the contact.
- Keep the email tight: the filled template only, no extra paragraphs,
  no links other than the signature's github.com/skale-07.
- Output STRICT JSON only:
  {"subject": string, "body_text": string, "used_alum_subject": boolean,
   "persona_projects_used": [string]}
  `used_alum_subject` is true only when contact.source_category is
  "school" (metadata — the subject line itself is the same for everyone).
