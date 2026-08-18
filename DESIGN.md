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
- The engine shares the name: package metadata and the GitHub repo are
  `dispatch` (renamed from `jobright-application-agent`, 2026-08-18 operator
  directive). "jobright" survives only where it names the external
  JobRight.ai service (`src/jobright/`, `JOBRIGHT_*` flags, the Python
  sidecar module) — those are service references, not project branding.

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

### 1.4 Mission and values

**Mission**: put one operator confidently in command of many applications —
every submission deliberate, every state honest, every outcome accounted
for.

Values, in priority order (each traces to an enforced mechanism — a value
without a mechanism is marketing):

1. **Operator sovereignty** — capability flows only from the operator's
   shell and explicit arming; the UI can narrow it, never widen it.
   *(flag ceiling, arm sessions, typed confirmations)*
2. **Evidence over reassurance** — every claim carries its receipt; every
   failure carries its inventory. *(artifacts, validation ladder, CTA and
   file-input inventories)*
3. **Fail closed, visibly** — the refused path names its gate; the default
   state of every capability is off. *(fail-closed flags, named refusals)*
4. **Calm surfaces, loud signals** — quiet backgrounds and dense data,
   with color reserved for meaning; ARMED is never quiet. *(signal-color
   law §2.3, ARMED law)*
5. **Connect, don't replace** — outreach ends as a draft in the operator's
   own mailbox; essays and self-ID answers are always the human's words.
   *(sendGuards, essay/demographic non-fill policy)*

### 1.5 Logo — the waypoint track

The mark is three stations on a rising track, the final one filled: an
application's route through the pipeline, delivered and **accounted for**.
It is monoline and geometric — drawn from the same visual family as the
data surfaces (dots, tracks, monospace), not decoration imported from
elsewhere.

**Assets** (all theme-aware SVG, no raster variants):

| Asset | Path | Use |
|---|---|---|
| Mark (component) | `frontend/src/components/DispatchMark.tsx` | sidebar, in-app surfaces; inherits `currentColor` |
| Favicon | `frontend/public/favicon.svg` | browser tab |
| Horizontal lockup | `design/logo.svg` | docs, READMEs, external headers |
| Stacked lockup | `design/logo-stacked.svg` | square-ish placements (cards, badges) |
| Mark, standalone | `design/logo-mark.svg` | anywhere the wordmark is already nearby |
| Wordmark only | `design/logo-wordmark.svg` | tight horizontal spaces (mark would fall below 14px) |
| Monochrome lockup | `design/logo-mono.svg` | dense docs / co-branding rows where the accent would fight |
| App icon | `design/logo-appicon.svg` | avatars, app grids, social — the ONE sanctioned container context; fixed dark tile, deliberately single-theme |

Pick by context, never by taste: accent lockup by default; mono when the
accent would compete; app icon only where a platform demands a tile.

The marketing site (`site/index.html` + `site/pricing.html`, shared
`site/dispatch.css`, no build step) is the brand's outward voice:
student-focused, leading with the mission (your time back from job apps),
structured as the machine's own loop (watch → arm → report → compound),
with the journey, stack diagrams, and onboarding told in plain language.
Palette-bound to the tokens and honest — no invented user numbers, no
testimonials, every claim traceable to an enforced mechanism. Positioning
is explicit: Dispatch is **closed-source, paid, local-first** software;
during beta, JobRight Premium is required for unlimited applying and
referral drafting. Referral drafts are presented as the second half of
every application, never as sent mail. Motion is orchestrated, sparse,
and fully disabled under `prefers-reduced-motion`.

**Construction**: 24×24 grid; track from (6,18) to (18,6), stroke 2,
round caps; open stations r=2.4 at the ends of each segment, filled
terminal station r=3. The lockup pairs the mark with the wordmark
`dispatch·console` in `--font-mono` semibold, the `·console` segment in
`--accent`.

**Usage rules**:

- The mark renders in `currentColor` — accent in chrome, text color in
  prose. Never recolor stations individually, never use signal colors
  (`--ok`/`--warn`/`--danger`) for the mark: the logo is identity, not
  status.
- Minimum size 14px; below that use nothing rather than a mushy mark.
- No rotation, gradients, shadows, outlines, or containers. On busy
  backgrounds, don't use the mark.
- The wordmark is always lowercase `dispatch·console`; prose uses
  "Dispatch".
- Asset colors must come from the palette — enforced by
  `tests/unit/design-tokens.test.ts`.

### 1.6 Voice and tone

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
there**; `design/tokens.json` is the machine-readable mirror (W3C design
tokens shape) for tooling and agents, and
`tests/unit/design-tokens.test.ts` fails the build if the two drift. This
section documents meaning and usage. Never hardcode a color, radius, or
font in a component — consume the variable.

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

1. **The operator commands; the agent executes.** Capability comes from
   the operator's `.env` (the flag ceiling); the UI can narrow, never
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
4. Copy follows §1.6 voice: terse, factual, gates named, no first person.
5. UI claims follow the validation ladder: a screen for an unexercised
   live path must not present itself as proven (see
   `docs/validation-levels.md`).
6. Keep this file, `tokens.css`, and the components consistent — a PR that
   changes one without the others is incomplete.

---

## 7. Governance

- This file changes by PR like code, ideally in the same PR as the visual
  change it describes.
- Palette changes touch three places in one PR: `tokens.css`,
  `design/tokens.json`, and this file — the drift test enforces the first
  two; review enforces the third.
- `AGENTS.md` covers engineering conventions; `CLAUDE.md` /
  `.cursor/rules/house-rules.mdc` remain the canonical safety rules. On
  any conflict: safety rules > AGENTS.md > DESIGN.md > personal taste.
