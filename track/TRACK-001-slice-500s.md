# TRACK-001 — Unguarded `.slice()` on required body fields → 500

## Symptom
POST feature sweep (135 param-free routes under `/api/*`): only **6 × HTTP 500**, all identical:
`Cannot read properties of undefined (reading 'slice')`.

| Route | Required field(s) | Line |
|-------|-------------------|------|
| POST /api/citations/score-response | response | 8537 |
| POST /api/hallucination/score | response | 6854 |
| POST /api/hallucination/groundedness | answer, context | 6862 |
| POST /api/honesty/minority-report | topic | 6712 |
| POST /api/honesty/reframe | response | 6652 |
| POST /api/honesty/sycophancy-check | response | 6615 |
| POST /api/honesty/confidence-calibrate | text | 6679 | (same class, not in 500 list only because my test body included `text`) |

## Root cause
Each handler destructures a **required** body field and calls `field.slice(0, N)` with no guard.
Missing field → `.slice()` on `undefined` → uncaught → 500. Should be **400**.

## Reachability
Real UI (`honesty.tsx`, `quality.tsx`) sends the correct field names, and empty submits send `""`
(`"".slice()` is safe). So the **live UI does not trigger these** — they are latent, reachable only by
malformed API clients. Fixing anyway: 500-on-missing-input is a correctness bug and the file already
guards other routes this exact way (`reply.code(400).send({ error: "X is required" })`, 41 uses).
→ These 6 are almost certainly NOT the user's observed break. Audit continues in TRACK-002.

## Verification (before fix)
- With correct fields → all 7 return **200** with sensible LLM output (logic is fine).
- With field omitted → **500** (`.slice` of undefined).

## Fix
Add the file's standard 400 guard at the top of each handler. Guard on `!field?.trim()`.

## Status: ✅ DONE
Applied the 400 guard to all 7 handlers (api-bridge.ts). Re-verified:
- missing field → **400** with `{ error: "X is required" }` (was 500). All 7 confirmed.
- correct field → still **200** (guard only precedes existing logic; happy path unchanged).
Not committed yet (per always-work-on-main; commit when user asks).
