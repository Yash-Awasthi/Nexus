# TRACK-003 — /llm/complete 502 + council/gateway local-routing review

## /api/v1/llm/complete → 502 (FIXED)
`llm.ts` built its `LLMRouter` from groq/claude only; `nexus/fast`→groq (404) and the `null` fallback
alias was unreachable (`strategy:"first"` picks only the first entry per alias). → 502 in local mode.
**Fix:** same as TRACK-002 — when `NEXUS_LLM_PROVIDER=ollama`, register `OpenAIProvider`→Ollama `/v1`
first and alias `nexus/fast` + `nexus/smart` → ollama.
**Verified:** `/llm/complete` with `nexus/fast` and `nexus/smart` → 200, `provider:"ollama"`,
`model:qwen2.5:7b`, real content.

## gateway.ts — NOT a bug
Uses `@nexus/llm-drivers` (not llm-router) with an explicit local-Ollama fallback (gateway.ts:539-548).
Returns 200. With a `GROQ_API_KEY` present it *prefers* groq over the ollama fallback (the fallback only
fires when the cloud driver is absent) — a local-vs-paid *preference* question, not an error. Left as-is.
If you want gateway to force-local, change the fallback condition to also trigger when
`NEXUS_LLM_PROVIDER==="ollama"`. Not done (behavior change, no error).

## council/deliberate — NOT a bug (BYOK by design)
`buildCouncilServiceForUser` is intentionally strict: it throws `NoCouncilKeyError`→**400** ("Add one
under Settings → Provider Keys") when the user has no *stored* key for the council provider.
`resolveUserProviderKey` reads only the user's encrypted DB key — **no env fallback by design**
(explicit code comment). `COUNCIL_MODEL=nexus/smart`→groq, and `COUNCIL_DRIVER_ALIASES` has **no ollama
entry**. So council needs a stored provider key; it cannot run on local Ollama key-free.
This is a deliberate product/security decision, not a defect — the 400 is a clear, correct message.
**To make council work fully-local (future, optional):** add an ollama entry to `COUNCIL_DRIVER_ALIASES`,
include ollama in `COUNCIL_PROVIDERS`, allow keyless ollama registration, and set `COUNCIL_MODEL` to it.
Touches a BYOK/tier-gated path — do carefully, own track.

## Status: ✅ /llm/complete fixed. council/gateway reviewed — no error to fix.
