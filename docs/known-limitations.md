# Known limitations (Phase 2b)

- Login validation uses URL heuristics; Google OAuth requires `BROWSER_CHANNEL=chrome` (system Chrome), not bundled Chromium.
- Recorder requires a prior `npm run login:jobright` session.
- Captures are operator-guided (press Enter); not fully automatic navigation.
- JobRight production selectors are still not implemented (Phase 3).
- DPAPI key wrapping is Windows-only; non-Windows needs insecure test key for sensitive profile.
- Dashboard and Express API not started.
- LinkedIn enrichment package not created.
