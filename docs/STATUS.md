# Nexus — Feature Status (local, no paid APIs)

_Last verified 2026-09-07. Stack: Fastify API (`:3000`) + React Router UI (`:5173`) + local Ollama (`:11434`, `qwen2.5:7b` + `nomic-embed-text`) + Neon Postgres + local Redis (`:6379`). Tier gating is OFF — the only gate is login._

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
| Knowledge Bases                | KG-store backed list + ingest                                                                                                                    |
| Repositories                   | GitHub API when `GITHUB_TOKEN` set, else empty list                                                                                              |
| Memory                         | write + embed (Ollama 768-dim) + recall + list                                                                                                   |
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
| Knowledge Graph                | store-backed (`/kg/graph`, `/kg/search`)                                                                                                         |
| Agents                         | librarian/file agents                                                                                                                            |
| Projects                       | `/api/v1/projects` CRUD                                                                                                                          |
| Evaluation                     | LLM judge + results store                                                                                                                        |
| Marketplace                    | plugin registry CRUD                                                                                                                             |
| Sandbox                        | JS (Node vm) + Python (Pyodide/WASM) local                                                                                                       |
| Image Gen                      | needs `OPENAI_API_KEY`/Replicate key                                                                                                             |
| Moderation                     | OpenAI moderation or heuristic fallback                                                                                                          |
| Semantic Cache                 | **real Ollama-embedding cosine** + `/store`                                                                                                      |
| Fallback Chains                | list/run/test (test needs a valid `chainId`)                                                                                                     |
| Settings / Profile             | preferences store                                                                                                                                |
| Cost Analytics                 | from real `_costLog`                                                                                                                             |
| API Tokens                     | `nxk_` + sha256, Postgres                                                                                                                        |
| Provider Keys                  | AES-256-GCM encrypted, Postgres                                                                                                                  |
| Notifications                  | **real per-user store** (shared KV, 30-day TTL) + sidebar bell + dashboard Activity feed; live emitters: research done/failed, autopilot run end |
| Standard Answers               | persistent + LLM match                                                                                                                           |
| Web Search                     | POST `/web-search {query}` — Tavily→SearXNG                                                                                                      |
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

- **Image Gen / Fine-Tune** → `OPENAI_API_KEY` (or Replicate).
- **Voice transcribe/synthesize** → `GROQ_API_KEY` / `ELEVENLABS_API_KEY`.
- **Repositories** → `GITHUB_TOKEN`.
- **Sandbox Go/Rust/Ruby/etc** → local Piston (`PISTON_URL`); JS + Python already work with nothing.
- **Video transcript** → `YOUTUBE_API_KEY` (honest 503 without it).
- **Language Models leaderboard** → curated static numbers, labeled `measured:false` (intentional, not live-benched).

## ✅ Fully implemented (was partial, now complete)

- **Local bridge (cloud agents → this machine)** — `apps/worker/src/bridge.ts`, token-gated HTTP bridge (GET /health, /capabilities, /connector-instruction; POST /rpc) exposing the confinement-safe coding tool set (read/write/edit/list/run_command + list_projects + MCP passthrough). Verified E2E locally: auth 401, project list, file read, file write-back persisted to disk, shell, and path-escape rejection. Self-host behind a public tunnel (`cloudflared tunnel --url http://127.0.0.1:8787`) for the deployed case — protocol + agent connector payload in docs/LOCAL-BRIDGE.md.
- **Agent shell on Windows** — `run_command` in `agent-tools.ts` hardcoded `/bin/sh` (ENOENT on Windows); now picks `cmd.exe /d /s /c` on win32. Verified `[exit 0]` on this machine.
- **Chat OAuth resolution** — `/chat/stream` resolves each member BYOK key → **OAuth-linked account** (`lib/oauth-drivers.ts`: Google Vertex ↔ VertexDriver, Entra ↔ Azure OpenAI; refresh-before-use) → server env key, reported as keySource `user|oauth|env|local|none`. UI sends all enabled members (browser mode = linked-account/consumer stream, no longer client-gated), shows `oauth` key source, and Settings → Council has a **Linked accounts** panel (CONNECT → `/llm-oauth/:provider/start` → Google consent → callback persists; REVOKE). Proved by curl: providers catalog (`google-vertex` supported), status, consent URL issuance, and a live SSE opinion stream (keySource env). Honest scope: consumer OAuth for ChatGPT/Claude does **not** exist officially — their members use BYOK keys; Google's official third-party path (Vertex AI) is what Sign in with Google powers here.
- **Gemini native tool-calling (driver)** — `GeminiDriver.complete()/stream()` now send `functionDeclarations`, parse `functionCall` parts (incl. the new API `id`), wrap tool results as JSON Structs (bare strings → `{result}`), merge streamed functionCall parts per call, and echo Gemini 3+ `thoughtSignature` + call `id` back (required since Gemini 3 — a 400 otherwise). Provider errors now surface the raw body (was: opaque "Invalid request"). Shared agent loop verified end-to-end on OpenRouter (all 4 autopilot roles tool-called and wrote PLAN.md/RESEARCH.md/result.txt); live-Gemini re-verify still pending because today's free-tier quota was exhausted mid-fix (429s surfaced cleanly).
- **Autopilot (autonomous projects)** — Projects → Autopilot tab. Unattended loop: architect → researcher → coder → reviewer with rework iterations, each role mapped to any provider/model from the user's BYOK keys or server env keys. Durable `autopilot_runs` store (JSONB/Postgres or file), per-run isolated workspace under `data/workspaces/<project>/<run>`, SSE live event stream with replay, retry-with-backoff on transient failures, cancel-by-delete. Runs fully headless from `POST /api/v1/projects/:id/autopilot/runs`.
- **OpenAI / Gemini / DeepSeek drivers** — `@nexus/llm-drivers` now ships `OpenAIDriver` (was missing entirely — the reason "ChatGPT never works"), and `GeminiDriver` gained full native tool-calling: functionDeclarations, functionCall parsing, functionResponse round-trips, and Gemini 3+ `thoughtSignature` echo-back (required since Gemini 3 — 400 without it). Default models updated to live 2026 names (`gpt-5.6-sol`, `gemini-3.6-flash`, `deepseek-v4-flash`; `gpt-4o`/`deepseek-chat` are retired). Worker agent executor (`apps/worker/src/handlers/agent-handler.ts`) now resolves drivers for openai/gemini/deepseek, so BYOK role-agents can actually run.
- **Workflows run engine** — CRUD + DAG executor via `@nexus/workflow-chain`. POST `/workflows/:id/run` builds a chain from stored steps and executes it with retry, timeout, abort signal support.
- **Verifiable pipelines** — `/verifiable/verify` runs 7 real checks: hedging analysis, citation detection, logical consistency, factual grounding (with context), source URL validation, and LLM-based verification (when available).
- **Repo search** — `/repos/:id/search` uses GitHub Code Search API when `GITHUB_TOKEN` is set; falls back to GitHub Trees API for filename matching.

- **Notifications backend** — the sidebar bell's `/api/notifications*` surface was UI-only (routes existed but were **in-memory per-process**; nothing persisted). Now backed by a real KV store (`lib/notifications-store.ts`, per-user, TTL 30 d, cross-pod via Redis/Upstash, memory fallback in dev). Full CRUD: count / list / read / dismiss / dismiss-all / create / bulk / delete, all resolved per-user via `requireAuthWithTier`. Emitters wired: deep-research job done/failed → `type:research`, autopilot run end → `type:autopilot`. Verified E2E by curl + browser: create → bell badge → dashboard Activity feed → mark-read clears unread; per-user isolation (JWT-scoped); survives process restart (Redis). 6 unit tests in `apps/api/tests/lib/notifications-store.test.ts`.
- **Dashboard overhaul (home.tsx)** — was showing **zeros**: it read `totalConversations/totalCostUsd/…` but `/api/analytics/overview` returns `requests/tokens/costUsd/…` — the stat cards could never populate. Now the page loads one aggregate `GET /api/dashboard` (live stats + 7-day usage series + research + notification tray) and renders: real stat cards, a lazy recharts 7-day usage chart (requests + cost), a system-health strip (API/DB/Redis-KV/Ollama from `/health/ready` + providers), a live Activity feed (click = mark-read), plus the existing connectors/providers/workspace panels.
- **Recharts dev-crash fix** — lazy charts crashed the app with the documented duplicate-React "useContext null" after a dep-cache clear. `recharts` is now pre-bundled at startup (`optimizeDeps.include` in `apps/ui/vite.config.ts`, same as `framer-motion`) so it resolves against the same optimized React as the app.
- **KB/KG deep ingest** — POST `/symbolic/ingest` now auto-chunks documents >4000 chars using `@nexus/doc-pipeline` chunkText, then processes chunks in parallel via `extractGraphFromChunks`. Supports up to 500KB input.
- **Video transcript** — YouTube transcripts extracted by parsing the YouTube page for caption tracks and fetching the caption XML. No API key needed. Whisper (OpenAI) and Deepgram STT for file/URL uploads.
- **Auth hardening (§14)** — access tokens now honor `NEXUS_JWT_ALG` (HS256 shared secret or RS256 key pair, alg-pinned verification via `NEXUS_JWT_PUBLIC_KEY`); the login route locks the `email|ip` key with exponential backoff after 5 failures (429); every verified JWT is checked against a revocation registry (per-`jti` and per-subject cutoff); `DELETE /api/v1/users/:id/data` performs the self-service GDPR erasure cascade (403 unless caller == target, content-free audit line). OAuth/OIDC/SAML SSO routes issue through the same shared `lib/issue-access-token.ts` so all issuers agree on the algorithm and role mapping. Verified live: register/login, 5-failure lockout → 429, self-erasure 204 / cross-user 403 / erased-user login 401, both e2e suites green (74 + 41). 11 new unit tests in `apps/api/tests/lib/` (auth-hardening, gdpr-erasure, issue-access-token).

## 🔧 Has code but needs plumbing (partial — real handler, missing engine/wiring)

- **Fine-Tune** — OpenAI files/jobs wired but error handling is thin; export needs ≥10 rated examples.

## ❌ Not built yet (nav item with no real backend)

- **Diff rollback** — `/diff/apply` works; `/diff/rollback` missing (no edit history).
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

- Memory cold-recall can miss once right after restart (Ollama warm-up); warm calls are reliable.
- `diff/rollback` history is same-session-only by design — `rollbackId` lives in React state. Revisit only if a cross-session rollback UI is ever built.
- Billing/subscription is intentionally a no-op: Nexus is free + BYOK.
