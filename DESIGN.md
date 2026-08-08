# DESIGN.md — Dispatch design system

**Product**: Dispatch — the application operator console (this repo's web UI
and every operator-facing surface: CLI output, reports, docs).
**Audience**: humans building the UI **and** coding agents generating it.
This file is the single source of design truth. If a rule here disagrees
with code, the code is wrong or this file must be amended in the same PR.

---

## 1. Brand identity

### 1.1 Name and wordmark

- Product name: **Dispatch**. Lowercase in the wordmark, capitalized in prose.
- Wordmark: `dispatch·console` — monospace, the `·console` segment in the
  accent color. Rendered in text, never as an image asset.
- The engine underneath keeps its technical name (`jobright-application-agent`)
  in package metadata and docs; **Dispatch** is what the operator sees.

### 1.2 What the brand is

Dispatch is **mission control for job applications**. The metaphor the
product already speaks — arming a session, walls that park an application,
budgets, evidence artifacts, verified receipts — is an operations-room
metaphor. The design leans into it: dark-first, log-dense, monospace where
data lives, color used as signal rather than decoration.

Tagline: **"Every application accounted for."**

### 1.3 What the brand is not

- Not a chatbot. The agent never speaks in first person in the UI; the UI
  reports what the *system* did ("submission verified", never "I submitted").
- Not aspirational-startup. No gradients-for-mood, no illustration mascots,
  no exclamation marks. Calm surfaces, loud signals.
- Not a black box. Every failure surfaces its evidence (inventories,
  artifacts, report paths). A screen that says "failed" without a path to
  *why* violates the design system, not just the house rules.

### 1.4 Voice and tone

| Rule | Do | Don't |
|---|---|---|
| Report, don't narrate | "Submission verified · receipt saved" | "We successfully submitted your application!" |
| Name the gate | "Refused: SUBMIT_ENABLED is false" | "Something went wrong" |
| Honest uncertainty | "UNCERTAIN — needs your review" | silently counting it as done |
| Human owns judgement | "Essay required — write it in Review" | auto-drafting an essay |
| Terse over friendly | "Disarm now" | "Would you like to stop the session?" |

Validation-ladder words (`UNIT_CONFIRMED`, `FIXTURE_CONFIRMED`,
`LIVE_READ_ONLY_CONFIRMED`, `LIVE_MUTATION_CONFIRMED`, `UNVERIFIED`) are
part of the brand voice. They appear verbatim, uppercase, monospace.

---

## 2. Design tokens

Tokens live in `frontend/src/styles/tokens.css` and are **authoritative
there**; this section documents meaning and usage. Never hardcode a color,
radius, or font in a component — consume the variable.

### 2.1 Themes

Dark is the primary theme (operator tool, log-heavy); light is derived.
A manual toggle sets `data-theme` on `<html>`; otherwise the OS decides.
Every token below has a value in both themes — new tokens must be added to
both palettes and the light values must hold ≥ 4.5:1 contrast for text.

### 2.2 Typography

| Token | Value (intent) | Use |
|---|---|---|
| `--font-ui` | Inter / system sans | prose, labels, buttons |
| `--font-mono` | SFMono / Cascadia / Menlo | ids, hashes, states, evidence, log lines, the wordmark |

Type scale (rem): page title 1.25, card heading 0.95 (uppercase-tracked),
body 0.875 (14px base), meta/mono 0.78. Never introduce sizes outside the
scale; if a new size feels needed, the layout is too dense.

**Monospace is semantic**: anything the operator might copy, grep, or
compare (uuids, sha256, states, flag names, file paths, counts like
`3/10`) renders in `--font-mono`. Prose never does.

### 2.3 Color

Neutral surfaces (dark values shown; light equivalents in tokens.css):

| Token | Role |
|---|---|
| `--bg` `#0d1117` | page ground |
| `--bg-raised` `#161b22` | cards, modals |
| `--bg-inset` `#010409` | sidebar, wells, code blocks |
| `--bg-hover` `#1c2129` | hover rows |
| `--border` / `--border-strong` | hairlines / emphasized hairlines |
| `--text` / `--text-dim` / `--text-faint` | primary / secondary / metadata |

Signal colors — **each is bound to a domain meaning**. Using a signal color
for anything outside its meaning is a design defect:

| Token | Meaning in Dispatch |
|---|---|
| `--accent` (blue) | navigation, links, in-progress/filling states, primary buttons |
| `--ok` (green) | verified facts only: verified submission, passed gate, ready session |
| `--warn` (amber) | needs attention but not human-blocked: READY_TO_SUBMIT, unverified draft, degraded signal |
| `--danger` (red) | human required or destructive: needs-human walls, failed states, Disarm, **the ARMED condition** |
| `--purple` | agent/LLM-touched surfaces: outreach generation, agent nav phase |

Every signal color has a `-dim` companion (≈12–15% alpha) for chip and
banner fills. Text on a `-dim` fill uses the full-strength color.

**The ARMED law**: while an unattended session is armed, the UI must show
it loudly and globally — danger-toned border on the arm card **and** the
global `⚡ ARMED` banner. No surface may downplay an armed session. Danger
red for ARMED is deliberate: unattended mutation is the highest-stakes
state the product has, even when everything is going well.

### 2.4 Shape, depth, spacing

| Token | Value | Use |
|---|---|---|
| `--radius` | 8px | cards, modals, banners |
| `--radius-sm` | 5px | buttons, inputs, chips |
| `--shadow` | soft 24px | modals and popovers only — cards use borders, not shadows |
| `--sidebar-w` | 13.5rem | fixed sidebar width |

Spacing rides a 0.25rem base scale: `0.25 / 0.5 / 0.75 / 1 / 1.5 / 2rem`.
Components use rem paddings from that scale; no pixel-odd one-offs.

---

## 3. Component rules

These are the canonical patterns. Reuse the existing CSS classes; do not
invent parallel variants of an existing component.

### 3.1 Sidebar + shell

Fixed left sidebar (`--bg-inset`), wordmark on top, one nav entry per page,
active entry filled with `--accent-dim`. Content area max-width free but
tables scroll inside their own wrapper — the page never scrolls sideways.

### 3.2 Cards

`--bg-raised`, 1px `--border`, `--radius`, heading in small uppercase
tracked type. One concept per card. A card that needs a scrollbar should
usually be a page.

### 3.3 Badges and chips

- `StateBadge`: machine state verbatim (`READY_TO_SUBMIT`), monospace,
  colored by state family.
- Status chip (`badge` + semantic class): the coarse operator vocabulary —
  `queued / filling / ready / submitted / needs-human / failed` — colored
  by the signal-color table (§2.3). Chips are lowercase; machine states are
  uppercase. Never mix the two vocabularies in one element.

### 3.4 Banners

Full-width rounded strip in a `-dim` fill: `ok` for confirmations, `warn`
for degraded conditions, `danger` for blockers. Banners state the fact and
the next action ("Excluded from automation — the worker will skip this
application"). The global ARMED banner is a special case: always visible on
every page while armed, links to the arm card, shows countdown + budget.

### 3.5 Buttons

- `primary`: one per view at most — the action the screen exists for.
- `danger`: destructive or safety-relevant (Disarm, Abandon). Never used
  for merely-important actions.
- `ghost`: inline toggles and secondary verbs.
- Disabled is a real state: no spinner-only buttons; a busy button keeps
  its label ("Starting…").
- Any action that fires a mutation the operator can't take back gets a
  typed confirmation (the submit modal's type-the-company pattern), not a
  bare "Are you sure?".

### 3.6 Tables

Dense, monospace ids truncated to 8 chars, timestamps `toLocaleString` in
faint mono, row hover `--bg-hover`. Empty states are a sentence ("No
applications match these filters."), not an empty grid.

### 3.7 Stat tiles

Label (faint, small) over value (large). Counts that draw from a budget
render as `used / cap` with the cap in faint. A stat that can carry an
error code shows it in `--warn` mono (the arm card's "last error").

### 3.8 Evidence surfaces

Log viewers, JSON views, timelines: `--bg-inset` wells, monospace, never
reflowed or prettified in ways that break copy-paste. Artifact paths are
rendered as paths (`artifacts/applications/<uuid>/submission/`), clickable
when the console can serve them. **Every failure view links to its
evidence** — report path, inventory, screenshot — or says why none exists.

---

## 4. Agentic UX principles

How Dispatch behaves as an agent product — these shape every new feature:

1. **The operator commands; the agent executes.** Capability comes only
   from the operator's shell (the flag ceiling); the UI can narrow, never
   widen. Any surface that asks for trust must show its bounds (duration,
   caps, countdown) at the moment of asking — the arm card is the template.
2. **Visible when it matters, quiet when it doesn't.** Autonomous work runs
   in the background and surfaces exactly three kinds of interrupts:
   walls that need a human (review queue), confirmations (submit modal),
   and the ARMED condition. Everything else is a log line, not a popup.
3. **Connect, don't replace.** Outreach ends at a *draft* in the
   operator's own mailbox; essays and self-ID answers are always the
   human's words. UI copy never suggests otherwise.
4. **Evidence over reassurance.** Progress UIs show counters and states,
   not vibes. "7 apps started, 1 submit used, stopped: queue_drained"
   beats a progress bar.
5. **Fail closed, visibly.** A refused action names its gate. A disabled
   button that can't explain itself is a bug.

---

## 5. Responsive + accessibility

- Desktop-first (an operator tool), functional down to ~960px; below that
  the sidebar collapses to a top bar. Tables always scroll in their own
  wrapper.
- Interactive targets ≥ 32px tall; focus states visible (accent outline);
  every icon-only control carries `aria-label`.
- Color is never the only signal: chips carry words, badges carry state
  names, the ARMED banner carries text alongside red.
- Both themes must hold WCAG AA contrast for text tokens; check when
  touching the palette.

---

## 6. How coding agents apply this file

When generating or modifying UI in this repo:

1. Read this file and `frontend/src/styles/tokens.css` before writing
   components. Consume tokens; never hardcode values.
2. Reuse the existing classes (`card`, `badge`, `banner`, `stat`,
   `toolbar`, `table-wrap`, `field`) before adding CSS. New CSS goes in
   `base.css` under the matching section comment.
3. Map any new state or signal onto the color-meaning table in §2.3. If a
   new meaning genuinely has no color, propose a token in the same PR —
   in both themes — and document it here.
4. Copy follows §1.4 voice: terse, factual, gates named, no first person.
5. UI claims follow the validation ladder: a screen for an unexercised
   live path must not present itself as proven (see
   `docs/validation-levels.md`).
6. Keep this file, `tokens.css`, and the components consistent — a PR that
   changes one without the others is incomplete.

---

## 7. Governance

- This file changes by PR like code, ideally in the same PR as the visual
  change it describes.
- `AGENTS.md` covers engineering conventions; `CLAUDE.md` /
  `.cursor/rules/house-rules.mdc` remain the canonical safety rules. On
  any conflict: safety rules > AGENTS.md > DESIGN.md > personal taste.
