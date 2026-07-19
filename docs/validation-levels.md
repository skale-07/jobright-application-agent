# Validation levels

Every capability and test result uses exactly one level:

| Level | Meaning |
|-------|---------|
| `UNIT_CONFIRMED` | Pure logic / DB / policy — no external website |
| `FIXTURE_CONFIRMED` | Local HTML/JS/PDF fixtures controlled by this repo |
| `LIVE_READ_ONLY_CONFIRMED` | Real external page, no mutation |
| `LIVE_MUTATION_CONFIRMED` | Real page mutated; submit still impossible |
| `UNVERIFIED` | Not demonstrated at the required level |

## Ladder

1. **Logic test** → `UNIT_CONFIRMED`
2. **Static HTML fixture** → `FIXTURE_CONFIRMED`
3. **Interactive local fixture** → `FIXTURE_CONFIRMED`
4. **Guarded live read-only** → `LIVE_READ_ONLY_CONFIRMED`
5. **Guarded live mutation** → `LIVE_MUTATION_CONFIRMED`

A lower level never promotes a capability to a higher level.

Do not say a feature “works” without stating the level.
