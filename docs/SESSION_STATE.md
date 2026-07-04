# Nexus — Session Checkpoint (resume here)

_Last updated 2026-07-04. Read this first when resuming. Companion docs: `docs/FEATURE_AUDIT.md` (per-feature status), `docs/WIRING_TODO.md` (task runbook + smoke test)._

## What this project is
Nexus = wide "AI orchestration / council" platform (Fastify API + React Router SPA + Postgres/pgvector on Neon + Redis Cloud). ~60 nav features, uneven depth. **Not a paywall** — tier gating is disabled (`auth.ts` OPEN_TIER). Goal this session: make it run **locally with zero paid APIs**, fix broken wiring.

## Current state = WORKING locally, no paid APIs
Everything runs on **local Ollama** (LLM + embeddings). Verified green via smoke test.

| Feature | Status |
|---|---|
| Boot / health | ✅ |
| Register / login (`/api/v1/auth/*`) | ✅ JWT |
| Memory: write+embed+recall+list | ✅ local Ollama `nomic-embed-text` (768-dim = pgvector col, no migration) |
| LLM features (reasoning, moderation, honesty, hallucination, negation, task-routing, specialisation, voice/chat, related-questions) | ✅ local Ollama `qwen2.5:7b`, 0 MODEL_NOT_FOUND |
| Sandbox JS | ✅ Node vm |
| Sandbox Python | ✅ **Pyodide** (local WASM, no Docker) |
| Stability | ✅ one bad request no longer crashes server |

## Local stack requirements
- **Ollama** running on `:11434` with models: `qwen2.5:7b`, `nomic-embed-text`, `llama3.2:3b`.
  - Start: `nohup ollama serve > /tmp/ollama.log 2>&1 & disown`
- Neon Postgres + Redis Cloud (cloud, already in `.env`, free tiers). Neon host is IPv6-only and can `ENOTFOUND` on cold boot — just retry.
- Node 26, pnpm 9.

## HOW TO RUN (critical — process management is finicky)
```bash
cd /home/yash/Desktop/PROJECTS/Nexus
# 1. ensure ollama up:  curl -s localhost:11434/api/tags
# 2. kill any stale api (do these as SEPARATE commands, they exit 1 harmlessly):
pkill -9 -f index.ts; pkill -9 -f tsx
sleep 3
# 3. start API (STANDALONE nohup command — do NOT combine with pkill in one line,
#    the harness shell aborts at pkill before reaching nohup):
nohup bash scripts/dev-local.sh api > /tmp/napi.log 2>&1 & disown
# 4. poll: curl -s -o /dev/null -w '%{http_code}' localhost:3000/health   (want 200)
# UI (separate terminal):  set -x NEXUS_API_URL http://localhost:3000; pnpm dev:ui   (port 5173)
```
**Gotchas learned the hard way:**
- Zombie API holds `:3000` → `EADDRINUSE`. If health=000, `fuser -k 3000/tcp` then kill by pid: `for p in $(pgrep -f index.ts); do kill -9 $p; done`.
- `tsx watch` hot-reloads code but keeps **old env** — after `.env` change you MUST fully kill+restart, not rely on reload.
- `scripts/dev-local.sh` loads `.env` into shell (pnpm/turbo don't). It only exports well-formed `KEY=VALUE` lines and won't abort on bad ones.
- If you edit a `packages/*` file, rebuild it: `pnpm --filter @nexus/<pkg> build` (API imports built `dist`).

## Env added to `.env` (local mode)
```
NEXUS_JWT_SECRET=<hex>            # was missing → auth 500s without it
NEXUS_LLM_PROVIDER=ollama
NEXUS_DEFAULT_MODEL=qwen2.5:7b
OLLAMA_BASE_URL=http://localhost:11434
NEXUS_EMBED_PROVIDER=ollama
NEXUS_EMBED_MODEL=nomic-embed-text
```

## Changes made this session (all uncommitted, on `main`)
- `packages/memory/src/index.ts` — added `OllamaEmbedder` (768) + `OpenAIEmbedder`; `createBestEmbedder` local-first (Ollama→OpenAI→Groq-if-forced→Fixed768).
- `packages/llm-drivers/src/index.ts` — `OllamaDriver` routes any `provider/model` string → local model (so hardcoded cloud aliases work).
- `apps/api/src/routes/api-bridge.ts` — removed **duplicate** `/archetypes` route (was crashing boot); register `OllamaDriver`; `DEFAULT_MODEL`+`getDefaultDriver` env-driven; **Pyodide** Python sandbox; hardened `parseJsonResponse` (extract JSON from prose); embedder warm-up in `getMemory`; de-stubbed `task-routing/classify`, `specialisation/detect`, `research/related-questions` to real LLM; gauntlet null-check (crash fix).
- `apps/api/src/routes/voice.ts` — `voice/chat` echo → real LLM.
- `apps/api/src/routes/memory.ts`, `agents.ts`, `gateway.ts`, `context.ts`, `doc-pipeline.ts` — use `createBestEmbedder`.
- `apps/worker/src/handlers/agent-handler.ts`, `packages/runtime/src/runtime-context.ts` — catch fallback `GroqEmbedder`→`FixedEmbedder(768)`.
- `apps/api/src/index.ts` + `server.ts` — global error handler / unhandledRejection logs-not-exits (already mostly present).
- `apps/ui/app/routes/register.tsx` — send `email` not `username` (backend contract).
- `apps/ui/vite.config.ts` — alias `react-router-dom`→`react-router` (stray v5 broke UI build).
- `apps/api/package.json` — added `pino-pretty` (was missing, crashed boot) + `pyodide`.
- New files: `scripts/dev-local.sh` (launcher), `docs/FEATURE_AUDIT.md`, `docs/WIRING_TODO.md`, this file.

## Key findings (don't re-investigate)
- The original audit's "~8 path mismatches" were **false positives** — it GET-probed POST routes (→404) and used empty bodies. archetypes/drift/evaluate/codegen/craft/fallback-chains all work. `/api/v1/agents` isn't called by the UI.
- Groq has **no embeddings API** → old memory always 500'd. Fixed by local Ollama embeddings.
- Public Piston (`emkc.org`) went whitelist-only Feb 2026 → non-JS sandbox dead. Fixed Python via Pyodide; Go/Rust/etc still need a local Piston (`PISTON_URL`).

## SMOKE TEST (run after every change — must be all PASS)
Full block is in `docs/WIRING_TODO.md` §9. Checks: health, memory-write, memory-recall, local-llm, sandbox-js, sandbox-python, server-survives-badreq.

## TODO (resume here)
1. ~~**§6 remaining stubs**~~ — ✅ **DONE 2026-07-04** (this session). All wired to real local data/LLM or honestly labeled:
   - `analytics/overview` → real `gatewayLog.stats()` (falls back to `_costLog` tokens; no more `Math.random`).
   - `semantic-cache` → real Ollama-embedding cosine sim + threshold; added `POST /semantic-cache/store`.
   - `admin/users` → real Postgres `users` table (GET+PUT); `admin/audit-logs` → real hash-chained `audit_log` table.
   - Fixed `audit-emitter` (neon-http has no transactions → non-tx append fallback; log now populates on register/provider-key).
   - `feedback` → real `_feedbackStore` + reactions signal; added `POST /feedback`.
   - `connectors sync-jobs` → PersistentStore; `costs/limits` → real env + `_costLog` spend/remaining.
   - `echo-chamber/inject-dissent` + `cross-memory/context` → real LLM; `echo-chamber/config` persists.
   - `member-evolution/recompute,apply` + `negation/inject` → read real stored state; `token-conservation/status` → real active-budget count.
   - `leaderboard` → labeled `measured:false` + disclaimer (curated static, kept visible); `video/transcript` → honest 503 kept.
2. Optional next: sandbox Go/Rust/etc via local Piston; UI end-to-end click-through; fix repo-wide drizzle dual-version tsc noise (pg 8.21 vs 8.22 pnpm dedupe — pre-existing, not runtime-blocking).

## Golden rule
Before adding any `app.get/post("/x")`, **grep first**: `grep -n '"/x"' apps/api/src/routes/*.ts`. A duplicate = `FST_ERR_DUPLICATED_ROUTE` = boot crash (this already bit us once with `/archetypes`).
