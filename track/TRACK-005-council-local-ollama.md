# TRACK-005 — Council runs fully key-free on local Ollama

## Goal
Make Deliberations (the #1 headline feature) work with **zero API keys** in local mode.
Before: `/council/deliberate*` + `/council/trigger` → 400 "No API key configured for the council
provider groq" because council was BYOK-strict and its alias table had no Ollama entry.

## Changes (apps/api/src/routes/council.ts)
- Added `nexus/local` → `{ provider: "ollama", model: NEXUS_DEFAULT_MODEL }` to `COUNCIL_DRIVER_ALIASES`.
- `COUNCIL_MODEL` default is `nexus/local` when `NEXUS_LLM_PROVIDER=ollama` (else `nexus/smart`).
- `buildCouncilServiceForUser`: **graceful local fallback** — if the resolved council provider has no
  stored key AND `NEXUS_LLM_PROVIDER=ollama`, register a keyless `OllamaDriver` and switch the effective
  model to `nexus/local` instead of throwing `NoCouncilKeyError`. Cloud providers stay strict-BYOK.
  (Mirrors the existing gateway.ts local-fallback pattern. `.env` has `COUNCIL_MODEL=nexus/smart`, so the
  fallback — not the default — is what fires locally; both are covered.)

## Cosmetic fix (packages/council/src/engine.ts)
Votes hardcoded `provider: "groq"`. Replaced with `providerFromModel(response.model)` — infers
anthropic/openai/google/mistral/deepseek/ollama/groq from the model id (prefers "ollama" when
`NEXUS_LLM_PROVIDER=ollama`). Rebuilt `@nexus/council` (consumed as dist).

## Build note
`@nexus/council` and `@nexus/llm-router` resolve via `./dist/index.js`, so src edits need
`pnpm --filter <pkg> build` to go live (tsx watch only recompiles apps/api/src). Both rebuilt.

## Verification (local Ollama, zero keys used)
- `/council/deliberate` → **200**, `ok:true`, 5 archetype votes on `qwen2.5:7b`, provider label `ollama`,
  votes genuinely split (3 yes / 2 no) — real deliberation. ~40-50s (5 sequential LLM calls).
- `/council/deliberate/stream` → SSE `event: vote` stream works.
- `/council/trigger` with a real signal id → **200**, `ok:true`, persists verdict.

## Status: ✅ DONE — Deliberations fully local.
