# Known limitations (Phase 5.5)

- Greenhouse fill is **fixture-confirmed**, not live-board-confirmed.
- JobRight resume download is proven via a local Playwright download fixture; live JobRight UI download still needs operator validation.
- Login validation uses URL heuristics; Google OAuth requires `BROWSER_CHANNEL=chrome` or CDP attach.
- Recorder is operator-guided; promote with `npm run recorder:promote` (not silent overwrite).
- Missing `requires_sponsorship` / work-authorization answers route to review — never invented.
- No employer Submit, no essay generation, no Outlook send, no LinkedIn enrichment, no Phase 6 compare.
- Lever / Ashby adapters deferred.
- DPAPI key wrapping is Windows-only for sensitive profile.
- Dashboard not started.
