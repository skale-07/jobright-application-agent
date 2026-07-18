# T-Search reuse map

Status: Phase 1 — no LinkedIn code ported yet.

| T-Search file | Function / concept | Reuse plan | Ported in Phase 1? |
| --- | --- | --- | --- |
| `src/linkedin/saveSession.ts` | Manual storageState login | Port in Phase 2 as `login:linkedin` | No |
| `src/linkedin/linkedinBrowser.ts` | Lazy session open/validate | Concept only; no module globals; `ServiceSession` | No |
| `src/linkedin/linkedinExtract.ts` | Profile extract + parsers | Port into `packages/linkedin-enrichment` Phase 10 | No |
| `src/linkedin/linkedinSearch.ts` | People search | Not on V1 critical path (JobRight supplies URLs) | No |
| `src/storage/jsonStore.ts` | Atomic JSON + TTL cache | Concept reused in `src/storage/` | Partial (atomic JSON helpers) |
| Olympiad / scoring / GitHub expand / seed tree UI | Product logic | **Do not port** | N/A |

Hardening over T-Search: coverage statuses, mid-run auth checks, per-contact pages, traces/screenshots, no committed profile artifacts.
