# jobright-agent (Phase 6 J1 sidecar)

Build-time authoring aid based on [browser-use](https://github.com/browser-use/browser-use).
It reads an employer application page through the operator's debug Chrome and
emits **candidate selectors** for a human to review and promote into fixtures.
It is **not** part of the application pipeline and can never touch application
state, fill a form, or submit anything.

## Inert by default

- npm never installs or invokes this package. The TS entry (`agent:author`)
  is gated behind `AGENT_AUTHORING_ENABLED=false`.
- Without the venv below, the sidecar exits non-zero with
  `{"status":"error","reason":"browser-use not installed"}`.

## Operator setup (explicit, one time)

```powershell
cd agent
python -m venv .venv
.venv\Scripts\pip install -e .
```

Pinned dependency: `browser-use==0.13.7`. Upgrades are deliberate edits to
`pyproject.toml`, never implicit — this project moves fast and the JSON
contract must stay stable.

## Contract

One JSON task on stdin, one JSON result on stdout. The authoritative schemas
live in `src/agent/contract.ts` (zod). Malformed sidecar output is rejected
on the TypeScript side.

Task: `{"task_version":1, "url":"…", "cdp_url":"http://127.0.0.1:9222", "allowed_domains":[…], "timeout_ms":60000}`
Result: `{"status":"ok"|"error", "field_candidates":[{label,type,selector_candidates,confidence}], "warnings":[…]}`

## Keys

No LLM keys are stored in this directory or read from any file. If a future
authoring mode needs one, the operator passes it via environment variables at
run time only.

## Chrome

Start the debug Chrome first (same flow as CDP login):

```powershell
npm run chrome:debug:jobright
```

The sidecar attaches to `http://127.0.0.1:9222`; it never launches or kills a
browser.

## Navigate task (nav layer)

`task_type: "navigate"` — reach the employer application form from a
JobRight job page or an intermediate wall. Contract in
`src/agent/contract.ts` (`agentNavigate*Schema`); implementation in
`jobright_agent/navigate.py`. Attaches to the operator's CDP Chrome
(never launches one). Hard rules: never fill application-form fields,
never click submit (report `wall:"submit_risk"`), stay on
`allowed_domains` (audited mechanically from history), stop on
captcha/phone walls, `needs_input` + `need` for email verification (the
Node orchestrator services it via the readonly Gmail tool and re-invokes
with `resume`). Credentials, when provided, arrive on stdin only and ride
browser-use's `sensitive_data` seam; they must never be printed.
