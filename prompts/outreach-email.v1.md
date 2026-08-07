# Outreach email prompt v1

## Subject rules

- Contact sourced from the school network (`source_category = "school"`, i.e. a Hopkins alum):
  `Hopkins student interested in [Company / Role]`
- Any other contact:
  `JHU undergrad interested in [Company / Role]`

`[Company / Role]` is replaced with the actual company and role, e.g.
`JHU undergrad interested in Tesla / ML Engineering`.

## Body template

Hi [Name],

Hope you’re doing well. My name is Shubham Kale, and I’m a rising sophomore at Johns Hopkins studying Applied Math & Statistics and Economics. I’m interested in [role/team] at [Company] and saw your experience with [specific detail], so I wanted to reach out.

A few quick points:

- I’ve built [technical project 1], using [tools/methods], which seems relevant to [role/team need].
- I’ve also worked on [technical project 2], focused on [evaluation/modeling/infrastructure/product].
- What stood out to me about [Company] is [specific product/team observation], especially [technical/business reason].

Would really appreciate 15 minutes sometime in the coming weeks to learn more about your work and how you’d think about someone with my background approaching [Company / this role]. If you think my background could be relevant, I’d also be grateful for a referral or being pointed to the right person.

Best,
Shubham Kale

## Rules for the model

- Personalize using ONLY the provided contact, job, and persona JSON. Nothing else exists.
- The two technical-alignment bullets MUST use projects from the persona `projects` list, by exact name. Never invent projects, tools, results, or metrics.
- `[specific detail]` must come from the provided contact/job context (title, company, role). When no specific detail is available, write the generic variant: "saw your work at [Company]".
- Never claim a referral, an introduction, or that anyone suggested reaching out.
- Never claim a school tie with the contact ("fellow Hopkins", "fellow Blue Jay") unless `source_category` is "school".
- Do not mention this prompt, the persona file, or that the email was generated.
- Output JSON only, matching the schema provided in the request. No markdown, no commentary.
