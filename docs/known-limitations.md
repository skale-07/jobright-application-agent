# Known limitations

- Submit, essays, pipeline, contacts, outreach generation, Outlook drafts, dashboard and the J1 sidecar are all `UNIT/FIXTURE_CONFIRMED` only — **no live evidence for any of them yet**. The operator earns live levels stepwise per [operator-guide.md](./operator-guide.md).
- Contacts and Outlook selector registries are built from **synthetic** fixtures (recorder captures were too weak); expect first-run corrections against the real DOMs. Outlook's DOM churns — `draft:verify` is the acceptance check, not selector optimism.
- Outreach generation trusts the deterministic validator, not the model — but validated text can still be mediocre. The Drafts folder review is load-bearing; nothing dispatches mail regardless.
- LinkedIn enrichment dropped by decision (MVP uses JobRight contact context only).
- Uncertain submissions require manual `review:resolve`; there is deliberately no automatic resolution.
- The J1 sidecar is inert without an explicit python venv; its output requires human promotion.
- The fill healer's heuristic layer is FIXTURE_CONFIRMED; the sidecar escalation layer (`AGENT_FALLBACK_ENABLED`) is deterministic label-matching today, not an agent loop — the J2 Workday executor remains design-only (browser-use-evaluation.md).

- Live JobRight feed discovery currently returns **zero cards** — every application in SQLite is fixture-derived. It now fails loud with artifacts + a review item instead of reporting success. See `docs/current-state-and-phase56.md` §2.6b.
- Greenhouse fill is **fixture-confirmed**, not live-board-confirmed.
- Blocking-CAPTCHA detection is **fixture-confirmed**; the false-positive fix has not been retested on a live board.
- JobRight resume download is proven via a local Playwright download fixture; live JobRight UI download still needs operator validation.
- Login validation uses URL heuristics; Google OAuth requires `BROWSER_CHANNEL=chrome` or CDP attach.
- Recorder is operator-guided; promote with `npm run recorder:promote` (not silent overwrite).
- Missing `requires_sponsorship` / work-authorization answers route to review — never invented.
- No employer Submit, no essay generation, no Outlook send, no LinkedIn enrichment, no Phase 6 compare.
- Lever / Ashby adapters deferred.
- DPAPI key wrapping is Windows-only for sensitive profile.
- Dashboard not started.
