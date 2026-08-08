# JobRight → employer application inspection (Phase 4)

## Scope

Stage 1 only: **detect ATS, discover fields, map aliases, classify essays, route**.

- `FORM_FILL_ENABLED` defaults to `false` — no fill
- `SUBMIT_ENABLED` defaults to `false` — no submit
- Unsupported ATS (Workday, iCIMS, Oracle/Taleo): skip and continue batch

## Adapters

| Adapter | Version | When selected |
|---------|---------|---------------|
| `unsupported` | 1 | Workday / iCIMS / Oracle URL or HTML markers |
| `greenhouse` | 1 | boards.greenhouse.io + `#application_form` / branding |
| `generic` | 1 | Fallback when a form + inputs exist |

## CLI

```bash
# Inspect a built-in HTML fixture
npm run ats:inspect -- --fixture greenhouse

# All fixtures
npm run ats:inspect -- --all-fixtures

# Inspect raw HTML file + URL
npm run ats:inspect -- --html path/to/page.html --url https://boards.greenhouse.io/...
```

Reports write to `artifacts/ats-inspect/<name>/inspect-report.json`.

## Routing decisions

| Route | Meaning |
|-------|---------|
| `ready_for_fill_later` | Mapped; fill deferred to later phase |
| `needs_essay` | Long / essay-like questions present — **only when `ESSAY_REQUIRED_GATE_ENABLED=true`** (default off; heuristics false-positive on demographic wording). Textareas still never auto-fill. |
| `needs_review_unmapped` | Required fields lack answer aliases |
| `needs_login` / `needs_human_captcha` / `needs_account_creation` | Human gate |
| `skip_unsupported_ats` | Do not attempt fill |

## Verify

```bash
npm run verify:phase4
```
