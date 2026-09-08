# Nexus — Feature Status (local, no paid APIs)

_Last verified 2026-09-08. Stack: Fastify API (`:3000`) + React Router UI (`:5173`) + local Ollama (`:11434`, `qwen2.5:7b` + `nomic-embed-text`) + Neon Postgres + local Redis (`:6379`). Tier gating is OFF — the only gate is login._

**How to test the AI quickly:** register in the UI, then any LLM page works locally. Or curl:

```bash
API=http://localhost:3000
T=$(curl -s -X POST $API/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@x.io","password":"LocalDev12345!"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
curl -s -X POST $API/api/reasoning/run -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{"question":"hi"}'
# → {"reasoning":"Hello! How can I assist you today?", ...}
```

---

## ✅ Working (verified end-to-end, local)

| Nav item                       | Notes                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dashboard                      | loads                                                                                                                                            |
| Deliberations                  | real council: 5 **archetypes** each cast an LLM vote (`packages/council/engine.ts`)                                                              |
| Archetypes                     | roster of the council personas used in Deliberations (not decorative)                                                                            |
| Workflows                      | CRUD + DAG run engine (see below)                                                                                                               |
| Prompts                        | Postgres CRUD + versions                                                                                                                         |
| Skills                         | store-backed                                                                                                                                     |
| Knowledge Bases                | KG-store backed list + docs; **ingest inert by design (zero entities) — §16.9 pending extractor wiring**                                            |
| Repositories                   | GitHub API when `GITHUB_TOKEN` set, else empty list                                                                                              |
| Memory                         | write + embed + recall + list — embedder via `NEXUS_EMBED_PROVIDER`: ollama (default, 768-dim), groq, openai, voyage, jina, cohere (key-gated), fixed  |
| Connectors / Add / Sync Status | registry + **sync-jobs now persisted**                                                                                                           |
| God Mode                       | per-member `driver.complete()`                                                                                                                   |
| Gauntlet                       | streams; crash-guarded                                                                                                                           |
| Red Team (prompt-filter)       | `@nexus/redteam`                                                                                                                                 |
| STM                            | transform pipeline                                                                                                                               |
| Drift                          | compute/rate/detect                                                                                                                              |
| Blind Council                  | identity-hidden council votes                                                                                                                    |
| Deep Research                  | scraper (Tavily if key)                                                                                                                          |
| A/B Arena                      | `raceModels`                                                                                                                                     |
| Simulation                     | LLM persona ticks                                                                                                                                |
| Knowledge Graph                | store-backed (`/kg/graph`, `/kg/search`, `/kg/communities`); **extract/ingest inert by design (zero entities) — §16.9 pending extractor wiring**      |
| Agents                         | librarian/file agents                                                                                                                            |
| Projects                       | `/api/v1/projects` CRUD                                                                                                                          |
| Evaluation                     | LLM judge + results store                                                                                                                        |
| Marketplace                    | plugin registry CRUD; per-user stars/installs (`/marketplace/me`, anon only as dev-bypass)                                                        |
| Sandbox                        | JS (Node vm) + Python (Pyodide/WASM) local                                                                                                       |
| Image Gen                      | DALL·E 3/2, Replicate (FLUX/SDXL), FLUX (BFL direct), Stable Image Core/Ultra, Recraft V3, fal, self-hosted ComfyUI                              |
| Moderation                     | OpenAI moderation or heuristic fallback                                                                                                          |
| Semantic Cache                 | **real Ollama-embedding cosine** + `/store`                                                                                                      |
| Fallback Chains                | list/run/test (test needs a valid `chainId`)                                                                                                     |
| Settings / Profile             | preferences store                                                                                                                                |
| Cost Analytics                 | from real `_costLog`                                                                                                                             |
| API Tokens                     | `nxk_` + sha256, in-memory (bridge `/tokens`; no Postgres-backed tokens surface exists)                                                          |
| Provider Keys                  | AES-256-GCM encrypted, Postgres                                                                                                                  |
| Notifications                  | **real per-user store** (shared KV, 30-day TTL) + sidebar bell + dashboard Activity feed; live emitters: research done/failed, autopilot run end |
| Standard Answers               | persistent + LLM match                                                                                                                           |
| Web Search                     | POST `/web-search {query}` — Exa→Brave→Serper→Tavily→SearXNG (key-gated providers; exa/brave/serper via `@nexus/search-orchestrator`)               |
| Scraping                       | Firecrawl/Exa/basic                                                                                                                              |
| Rooms                          | in-mem CRUD                                                                                                                                      |
| Admin → Users                  | **real Postgres `users` table**                                                                                                                  |
| Admin → Analytics              | **real `gatewayLog.stats()`** (no more random)                                                                                                   |
| Admin → Audit Log              | **real hash-chained `audit_log`** (populates on register/provider-key)                                                                           |
| Admin → Traces                 | gateway log                                                                                                                                      |
| Feature Flags                  | store-backed                                                                                                                                     |
| Feedback                       | **real store + reactions signal** + `POST /feedback`                                                                                             |
| Cost / Costs limits            | real env + spend/remaining                                                                                                                       |

## ⚙️ Needs a key/runtime (code is real, just unconfigured)

- **Image Gen (FLUX/Stability/Recraft/fal/ComfyUI)** → `FLUX_API_KEY` / `STABILITY_API_KEY` / `RECRAFT_API_KEY` / `FAL_KEY` / `COMFYUI_URL` (+ `COMFYUI_WORKFLOW`/`COMFYUI_PROMPT_NODE`); DALL·E → `OPENAI_API_KEY`, Replicate → `REPLICATE_API_KEY`.
- **Fine-Tune** → `OPENAI_API_KEY`.
- **Voice transcribe** → `GROQ_API_KEY` (whisper) / `DEEPGRAM_API_KEY` (nova-2) / `ASSEMBLYAI_API_KEY` (universal) — pass `provider` in the request body.
- **Voice synthesize** → `ELEVENLABS_API_KEY` (eleven_turbo_v2_5) / `DEEPGRAM_API_KEY` (aura-2) / `CARTESIA_API_KEY` + `CARTESIA_VOICE_ID` (sonic-english).
- **Web search** → `EXA_API_KEY` / `BRAVE_API_KEY` / `SERPER_API_KEY` / `TAVILY_API_KEY` / `SEARXNG_URL` — precedence exa → brave → serper → tavily → searxng.
- **Repositories** → `GITHUB_TOKEN`.
- **Sandbox Go/Rust/Ruby/etc** → local Piston (`PISTON_URL`); JS + Python already work with nothing.
- **Video transcript** → `YOUTUBE_API_KEY` (honest 503 without it).
- **Language Models leaderboard** → curated static numbers, labeled `measured:false` (intentional, not live-benched).

## 🔧 Has code but needs plumbing (partial — real handler, missing engine/wiring)

- **Fine-Tune** — OpenAI files/jobs wired but error handling is thin; export needs ≥10 rated examples.

## ❌ Not built yet (nav item with no real backend)

- **Billing / subscription** — intentional: Nexus is free + BYOK, checkout is a no-op.

## Architecture — invariants (durable rules; the passes that established them are in git history)

Each concern has ONE owner; everything else imports it. Breaking any rule below
reintroduces a bug that was found and fixed live — don't.

**Per-user durable stores (KV-backed, survive restarts):** notifications
(`lib/notifications-store.ts`), threads (`lib/threads-store.ts`), research jobs
(`lib/research-jobs.ts`), session/mission graphs (`lib/session-graph.ts`,
`lib/mission-graph.ts`). All: per-key mutation locks via `lib/with-key-lock.ts`,
write-through on mutation, newest-first by list position (timestamps can tie —
never sort by `createdAt` alone), completion persisted BEFORE the SSE event or
notification that links to it. `requireAuthWithTier` resolves the caller — never
reintroduce anon-defaulting or process-level state for these surfaces in
api-bridge (re-adding a moved route there throws `FST_ERR_DUPLICATED_ROUTE`).

**api-bridge is a legacy bridge:** it holds mutable process state (`_costLog` is
bound to the durable `lib/cost-log.ts` store). New store-backed features get
their own `routes/*.ts` + `lib/*.ts` module (the research.ts precedent: narrow
typed deps, registered from inside `apiBridgeRoutes`).

**Usage/cost log** (`lib/cost-log.ts`): in-memory record + write-behind flush to
day-sharded KV keys (150-day TTL). `load()` mutates in place — reassignment
strands pre-bound readers (compiler-enforced: `entries` is `readonly`). Flush
health rides `/health/ready` (`costLog` block); a graceful close flushes the
pending tail. Best-effort by design: an unclean kill loses at most the last few
seconds, never the history.

**Rate limiting** (`lib/rate-limiter.ts`): atomic `KVStore.incr` only — the
EXPIRE/TTL is stamped exactly once at key creation; in-window traffic must never
refresh the expiry or the bucket never drains. Fail-open on KV outage.

**LLM cache + failover** (`lib/llm-cache-driver.ts`, `lib/llm-failover.ts`):
`getDefaultDriver()` returns FailoverDriver over CachingDriver-per-provider.
Cache is deterministic-only (temperature > 0, tools, tool-role messages bypass;
streams store only clean full completions); keys include provider + model +
caller (AsyncLocalStorage); hits return zeroed usage so cost stats stay honest;
fail-open on KV errors; `LLM_CACHE_DISABLED=1` bypasses. Failover order:
`NEXUS_LLM_PROVIDER` first, then the historical default order. Provider health +
discovery ride `/health/ready` (`llmProviders` block).

**Session/mission graphs** (`lib/session-graph.ts`): zero-write-cost capture —
no LLM call ever made to store memory; `edge.from === "last"` sentinel resolves
to the previous node; the first node on an empty graph gets no self-edge.
`lib/mission-memory.ts` is the READ side: `distillMissionMemory` turns the
captured graph into one bounded prompt block; `continueFrom` feeds it back.

**Skills** (`routes/skills.ts`, `lib/skill-merge.ts`, `lib/skill-compress.ts`,
`lib/skill-runner.ts`, `lib/skill-embed.ts`): merge/compress/run are separate
operations; the store persists full skill code (dropping `code` was a real
data-loss bug); comment markers must match the composite's language
(`commentPrefix()` — `#` vs `//`); skill relevance is embeddings-based with a
keyword fallback; `executeSkillsOnce()` pre-executes attached skills
deterministically so work happens even if the model never emits a tool call.

**Frontend:** one client source per concern — `NotificationsContext` owns the
tray (never re-add it to `/api/dashboard`), `lib/deliberate.ts` owns thread
state (pages must not re-implement fetch/fallback/mapping), the bell tray and
Activity feed stay behavior-identical (mark-read + navigate). Charts stay
pre-bundled in `apps/ui/vite.config.ts` (`optimizeDeps.include`) — removing
that reintroduces the duplicate-React crash.

**Research engine bounds:** synthesis + related-questions go through
`withTimeout(RESEARCH_LLM_TIMEOUT_MS)`; the Tavily fetch is bounded by
`AbortSignal.timeout(15 s)`; a `running` job older than 5 min is recovered to
`error` on read (the engine can never legitimately run that long).

## Known caveats

- Billing/subscription is intentionally a no-op: Nexus is free + BYOK.
