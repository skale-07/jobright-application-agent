# JobRight recorder (Phase 2b)

Evidence-based DOM/accessibility capture **before** writing production selectors.

## Prerequisites

```text
npm run login:jobright:cdp
```

Default feed URL:

```text
https://jobright.ai/jobs/recommend
```

Override if needed:

```text
JOBRIGHT_FEED_URL=https://jobright.ai/jobs/recommend
```

## Commands

Default captures `job-feed` only:

```text
npm run record:jobright
```

One workflow:

```text
npm run record:jobright -- --workflow resume-generator
```

All seven workflows (interactive prompts between each):

```text
npm run record:jobright -- --all
```

Also copy sanitized DOM/labels into `tests/fixtures/jobright/{workflow}/`:

```text
npm run record:jobright -- --workflow job-feed --derive-fixtures
```

## Workflows

| Workflow | Intent |
| --- | --- |
| `job-feed` | Filtered internship feed |
| `resume-generator` | Resume tailor / add-all keywords |
| `cover-letter` | Cover letter UI |
| `apply-autofill` | Apply / Apply with Autofill |
| `school-contacts` | Find from your school |
| `beyond-network` | Beyond your network |
| `email-reveal` | Connect via email / Connect now |

## Output (gitignored)

```text
fixtures/live-captures/{workflow}/{runId}/
  meta.json
  screenshot.png
  url.txt
  dom.sanitized.html
  a11y.sanitized.yml
  labels.json
  iframes.json
  network.sanitized.json
  pages.json
  downloads.json
  route-log.json
```

Sanitization strips emails, phones, bearer tokens, script bodies, auth headers, and request bodies.

## Gate for Phase 3

Do not invent JobRight selectors until captures exist for the workflows you are automating. Prefer deriving selectors from `labels.json` + sanitized DOM + a11y snapshots.
