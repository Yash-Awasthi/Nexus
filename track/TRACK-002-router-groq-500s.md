# TRACK-002 — LLM-router routes to groq (404) instead of local Ollama

## Symptom
Comprehensive POST sweep (131 previously-untested v1 + bridge routes). 11 × 500 total, split 3 classes.
**Class A (this track)** — 3 routes hard-500 with:
`ALL_PROVIDERS_FAILED — model "nexus/fast": groq API error 404: Unknown request URL: POST /openai/chat/completions`
- POST /api/v1/nlp/entities
- POST /api/v1/nlp/relationships
- POST /api/v1/knowledge-graph/ingest

## Root cause (two stacked bugs)
The platform has **two LLM stacks**:
- `@nexus/llm-drivers` — `DriverRegistry` with `OllamaDriver` **always registered**; `getDefaultDriver()`
  respects `NEXUS_LLM_PROVIDER`. This is why api-bridge features (reasoning/honesty/hallucination) work local.
- `@nexus/llm-router` — providers are Groq/Claude/OpenAI/Null only. **No Ollama.** Used by nlp.ts,
  knowledge-graph.ts, llm.ts, council.ts, gateway.ts.

`nlp.ts`/`knowledge-graph.ts` `buildNlp*Client()` registered a provider **only** from `GROQ_API_KEY` /
`ANTHROPIC_API_KEY` — ignoring `NEXUS_LLM_PROVIDER=ollama`. A stale `GROQ_API_KEY` in `.env` forced the
groq path. Two defects compounded:
- **A1** (route bug): no Ollama option + no null fallback (`fallbacks:{}`, strategy `first` → only the
  first alias entry is ever tried; the `claude` entry was dead code). groq fails → hard 500.
- **A2** (driver bug): `GroqProvider` default baseUrl was `https://api.groq.com/openai`; the shared helper
  appends `/chat/completions` → `…/openai/chat/completions` (missing `/v1`) → groq 404 for everyone.

## Fix
- **A1** — `nlp.ts` + `knowledge-graph.ts`: when `NEXUS_LLM_PROVIDER=ollama`, register an `OpenAIProvider`
  pointed at Ollama's OpenAI-compatible `/v1` endpoint (`OLLAMA_BASE_URL/v1`, model `NEXUS_DEFAULT_MODEL`)
  as the first `nexus/fast` alias. Reuses the existing `OpenAIProvider` class — no new code. groq/claude
  kept as lower-priority aliases when their keys exist. (Router resolves alias→provider without validating
  the model against the provider's static list, so `qwen2.5:7b` routes fine.)
- **A2** — `@nexus/llm-router` `GroqProvider` default baseUrl → `https://api.groq.com/openai/v1`.

## Verification (valid bodies, local Ollama)
- /nlp/entities → **200**, real entities, `llmBacked:true`
- /nlp/relationships → **200**, `llmBacked:true`
- /knowledge-graph/ingest → **201**, 4 nodes + 2 edges, entities extracted
No more groq 404. This is the systemic user-facing "feature returns error".

## Follow-ups (noted, not yet done)
- **council.ts / gateway.ts / llm.ts** use the SAME llm-router groq aliases but have a `null` fallback,
  so they DON'T 500 — they **degrade to null/empty in local mode** (possible "returns wrong data").
  Need to confirm whether council/deliberate, gateway/race, llm/complete produce real local output or
  silently degrade. → TRACK-003 candidate.
- A2 (groq url) only affects non-local groq users; can't verify locally (no valid groq key). Code-correct.

## Status: ✅ Class A DONE (nlp + kg). Classes B & C pending (TRACK-004).
