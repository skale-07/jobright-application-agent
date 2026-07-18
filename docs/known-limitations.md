# Known limitations (Phase 2)

- Login validation uses URL heuristics only (JobRight DOM selectors still unknown).
- JobRight workflow automation / recorder not implemented until Phase 2b–3.
- Persistent-context fallback exists but is not auto-promoted; switch via config/CLI.
- DPAPI key wrapping is Windows-only; non-Windows needs Phase 2 follow-up or insecure test key.
- Dashboard and Express API not started.
- LinkedIn enrichment package not created.
- Throughput targets deferred; correctness metrics come first.
