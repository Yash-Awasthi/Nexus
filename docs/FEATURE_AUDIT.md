# Nexus Feature Audit

_Generated 2026-07-04. Method: static read of every backend handler in `apps/api/src/routes/**` + `packages/**`, cross-checked against a live HTTP probe of ~200 UI-called endpoints. Server was running against the real Neon DB with `GROQ_API_KEY` set._

## UPDATE 2026-07-04 — live-verified, local Ollama wiring

Corrections after running the app (not static grep):

- **Local LLM + embeddings wired (no paid APIs).** `OllamaDriver` (`qwen2.5:7b`) + `OllamaEmbedder` (`nomic-embed-text`, 768-dim = matches `vector(768)`, no migration). Env: `NEXUS_LLM_PROVIDER=ollama`, `NEXUS_EMBED_PROVIDER=ollama`.
- **Memory: WORKING** — write + embed + persist + recall-by-query all verified (was "BROKEN" — the Groq-embeddings dead end is bypassed).
- **LLM features: WORKING on Ollama** — reasoning, moderation, honesty/sycophancy, hallucination, negation return real output; `0` MODEL_NOT_FOUND.
- **"Path mismatches" were FALSE POSITIVES.** archetypes, drift/optimize, evaluate, codegen/generate, craft/generate, fallback-chains/test all return 200/201 — the original audit probed POST routes with GET (→404) and used empty bodies. `/api/v1/agents` is not called by the UI (Agents page uses `/api/browser-agent/*` + `/api/reactions/*`, both real).
- **Gauntlet: FIXED** — null-check + global unhandledRejection guard; one bad request no longer crashes the server.
- **Sandbox: JS works; non-JS still blocked** (public Piston dead + no local Docker). Status endpoint now honestly reports JS/TS-only. Needs local Piston (Docker) or Pyodide.

Net: far more works than the original audit implied. See `docs/WIRING_TODO.md` for what remains.

## TL;DR

**It is not a paywall.** Tier/billing gating is deliberately disabled (`apps/api/src/middleware/auth.ts` — `OPEN_TIER`, _"no paid tier, nothing is gated"_). The only gate is login.

The project is a **very wide skeleton**: real plumbing (auth, Postgres, Fastify routing, React SPA, persistence, a real multi-provider LLM gateway) with **uneven depth** behind the ~60 nav items. Most failures collapse into **6 root causes**, not 60 separate bugs. Fix the root causes and a large fraction lights up at once.

### The 6 root causes

| # | Root cause | Blast radius | Fix effort |
|---|-----------|--------------|-----------|
| 1 | **UI↔API path/method mismatch** — frontend calls a path the backend serves under a different name/prefix (same bug class as register `username` vs `email`). | archetypes, drift, agents, evaluate, fallback-chains, codegen, craft (and likely more) | **S each** |
| 2 | **Embeddings broken** — code uses **Groq for embeddings, but Groq has no embeddings API** (`packages/memory` `GroqEmbedder` → `api.groq.com/openai/v1/embeddings` 400). | Memory (store/recall), Cross-Memory, Semantic Cache (real mode) | **M (one embedder swap)** |
| 3 | **Dead external: Piston** — public Piston code-runner went whitelist-only 2026-02-15. | Sandbox non-JS (Python/Go/Rust/…), Code-Agent non-JS | **M** |
| 4 | **No global error handler** — one bad request throws an unhandled rejection that **crashes the whole API** (`gauntlet` `scoreResponse` `.toLowerCase()` of undefined; `obs-providers` DB init). | Whole-server stability | **S** |
| 5 | **Missing execution engines** — feature draws/saves but never runs. | Workflows (no `/run`), Verifiable pipelines, Notifications, Audit-log collection | **L each** |
| 6 | **Stub data** — endpoint returns 200 with hardcoded/in-memory/seed data, no real logic. | ~25 endpoints (analytics, leaderboard, task-routing, admin users/audit, feedback, video, voice-chat, etc.) | **S–M each** |

### Rough tally (~145 endpoints classified)

- **REAL (genuinely works):** ~55% — auth, LLM gateway (15 providers), council/deliberation, godmode, honesty suite, moderation, hallucination, prompt-filter, evals, simulation, A/B, prompts (DB), skills, SOP, image gen/transform, browser-agent, build-tasks (DB), connectors, rss, scraping, web-search, provider-keys (DB), api-tokens, gateway, ghoststack, orchestration, feature-flags, admin traces/stats/routes, KG core, STM, standard-answers, JS sandbox.
- **BROKEN (real code, fails):** ~15% — Memory, Cross-Memory, Semantic-Cache (embeddings); Sandbox non-JS + Code-Agent (Piston); KB/KG ingest + Extraction run (LLM-key-dependent); Gauntlet (crash).
- **STUB (fake/seed data):** ~22% — see per-cluster tables.
- **MISSING / path-mismatch (404 at UI path):** ~8% — archetypes, drift/optimize, agents, evaluate, fallback-chains/test, codegen/generate+iterate, craft/generate, diff/rollback, notifications, billing/subscription.

> **Probe vs code conflicts = root cause #1.** Several handlers exist in code (e.g. `codegen/generate` at `api-bridge.ts:7258`, `craft/generate` at `2312`, `agents` at `agents.ts`, `evaluate` at `1952`) yet return **404 at the path the UI calls**. That means they're mounted under a different prefix/path or expect a different method — a contract mismatch, not missing logic. These are the cheapest wins.

---

## Cluster 1 — Deliberation / Council (the headline feature)

| Feature | UI endpoint | Status | Evidence | Fix |
|--------|-------------|--------|----------|-----|
| Council deliberate | `/api/v1/council/deliberate(/stream)` | **REAL** | `routes/council.ts:205-283` → `CouncilService.deliberate()` real LLM transport | probe 400 = payload contract; align UI body. **S** |
| Blind Council | `/api/blind-council/deliberate` | **REAL** | `api-bridge.ts:4577` council + identity strip | — |
| God Mode | `/api/godmode/stream` | **REAL** | `api-bridge.ts:645-723` per-member `driver.complete()` (BYOK) | — |
| Honesty (sycophancy/reframe/calibrate/minority) | `/api/honesty/*` | **REAL** | `api-bridge.ts:6146-6271` LLM judge calls | — |
| Echo Chamber detect | `/api/echo-chamber/detect` | **REAL** | `api-bridge.ts:4271` LLM sycophancy judge | — |
| Echo Chamber config / inject-dissent | `/api/echo-chamber/config,inject-dissent` | **STUB** | `api-bridge.ts:4355-4410` hardcoded | wire persistence + LLM. **S/M** |
| Negation detect | `/api/negation/detect` | **REAL** | `api-bridge.ts:5725` LLM | — |
| Negation add / inject | `/api/negation/add,inject` | **STUB** | `api-bridge.ts:5749-5783` in-mem, hardcoded msg | persist + real inject. **S/M** |
| Reasoning run | `/api/reasoning/run` | **REAL** | `api-bridge.ts:2601` CoT prompt | — |
| Reasoning modes | `/api/reasoning/modes` | **STUB(list)** | `api-bridge.ts:2583` static list | ok as list |
| **Drift optimize** | `/api/drift/optimize` | **MISMATCH (404)** | UI calls `/drift/optimize`; backend serves `/drift/compute,rate,detect` (`routes/drift.ts`) | repoint UI or alias route. **S** |
| **Archetypes** | `/api/archetypes` | **MISMATCH (404)** | real data at `/api/skill-selection/archetypes` (`api-bridge.ts:4192`) | repoint UI. **S** |
| Member Evolution | `/api/member-evolution/apply,recompute` | **STUB** | `api-bridge.ts:5032-5060` hardcoded | real scoring. **M** |
| Council settings | `/api/settings/council` | **STUB** | `api-bridge.ts:1096` in-mem | persist. **S** |
| **Gauntlet** | `/api/gauntlet/stream` | **BROKEN (crashes server)** | `api-bridge.ts:584` → `packages/gauntlet/src/index.ts:216` `.toLowerCase()` of undefined when `question` missing | null-check body + global error handler. **S** |

## Cluster 2 — Knowledge / Memory

| Feature | UI endpoint | Status | Evidence | Fix |
|--------|-------------|--------|----------|-----|
| Memory recall / store | `/api/memory/entries` GET/POST | **BROKEN** | `routes/memory.ts:45` `GroqEmbedder`; Groq has no embeddings API → 500 `EMBED_FAILED` | swap embedder (OpenAI `text-embedding-3-small` / local Xenova). **M** |
| Memory list / delete / compact | `/api/memory/*` | **REAL** | `routes/memory.ts:181-325` pure DB, no embed | — |
| Cross-Memory retrieve/search/merge | `/api/cross-memory/*` | **BROKEN** | `api-bridge.ts:4423-4513` `manager.recall/remember` need embed | same swap. **M** |
| Cross-Memory context | `/api/cross-memory/context` | **STUB** | `api-bridge.ts:4515` naive string concat | LLM fuse. **M** |
| Knowledge Bases list | `/api/kb` | **REAL** | `api-bridge.ts:1066` → KG store | — |
| KB create/docs | `/api/kb` POST, `/kb/:id/documents` | **STUB** | `api-bridge.ts:2625-2650` in-mem, mock jobId | real indexing. **L** |
| KB / KG ingest | `/api/kb/:id`, `/kg/extract` | **BROKEN (LLM)** | `knowledge-graph.ts:281` needs NLP LLM; null client if no key | keyword fallback or ensure key. **M** |
| Repos list | `/api/repos(,/github)` | **REAL(cond)** | `api-bridge.ts:1194` GitHub API if `GITHUB_TOKEN` | set token. — |
| Repo search | `/api/repos/:id/search` | **STUB** | `api-bridge.ts:1259` hardcoded matches | GH search / index. **L** |
| Knowledge Graph nodes/search/related/stats | `/api/kg/*` | **REAL** | `routes/knowledge-graph.ts:188-387` store-backed, seeded | — |
| Semantic Cache (config/stats/lookup/invalidate) | `/api/semantic-cache/*` | **STUB** | `api-bridge.ts:7108-7159` naive `.includes()`, never populated | embed-based cache. **M** |
| STM (modules/transform/history/active) | `/api/stm/*` | **REAL** | `routes/stm.ts` + `api-bridge.ts:6517-6568` | — |
| Standard Answers (+match) | `/api/standard-answers*` | **REAL** | `api-bridge.ts:7025-7096` persistent + LLM match w/ fallback | — |
| Extraction schemas/templates/jobs | `/api/extraction/*` | **REAL** | `api-bridge.ts:2512-2558` CRUD | — |
| Extraction run/preview/infer | `/api/extraction/run,preview,infer-schema` | **BROKEN (LLM)** | `api-bridge.ts:2429-2510` `_extractWithLLM` needs key (heuristic fallback for infer) | ensure LLM key. **M** |

## Cluster 3 — Build / Execution / Automation

| Feature | UI endpoint | Status | Evidence | Fix |
|--------|-------------|--------|----------|-----|
| Sandbox JS | `/api/sandbox/execute` | **REAL** | `api-bridge.ts:1829` Node `vm`, proven `6*7→42` | — |
| Sandbox non-JS | `/api/sandbox/execute` (py/go/…) | **BROKEN** | routes to Piston; whitelist-only since 2026-02-15 | self-host Piston (docker) or Pyodide. **M** |
| Code Agent | `/api/code-agent/run` | **BROKEN** | `api-bridge.ts:3042` LLM-gen then exec; non-JS dead; 502 on LLM err | JS-only + doc, or docker. **M** |
| **Codegen generate/iterate** | `/api/codegen/generate,iterate` | **MISMATCH (404)** | code at `api-bridge.ts:7258-7353` but UI path 404s | verify mount/method, repoint. **S** |
| **Craft generate** | `/api/craft/generate` | **MISMATCH (404)** | code at `api-bridge.ts:2312-2364` but UI path 404s | verify mount, repoint. **S** |
| Diff apply | `/api/diff/apply` | **REAL** | `api-bridge.ts:7355` line-diff hunks | — |
| **Diff rollback** | `/api/diff/rollback` | **MISSING** | no route | add w/ edit history. **M** |
| **Workflows** | `/api/workflows*` | **STUB (no engine)** | `api-bridge.ts:1125-1156` CRUD only; no `/run` | build step executor (DAG + tool/LLM dispatch). **L** |
| Prompts | `/api/prompts*` | **REAL** | `api-bridge.ts:9047-9160` Postgres CRUD + versions | — |
| Skills / Skill-selection | `/api/skills`, `/api/skill-selection/*` | **REAL** | `api-bridge.ts:2562, 4160-4244` | select uses slice not ranking (**M** to improve) |
| SOP | `/api/sop/*` | **REAL** | `api-bridge.ts:4728-4876` | — |
| Image Gen | `/api/images/generate` | **REAL(key)** | `api-bridge.ts:2654` OpenAI/Replicate | needs key |
| Image Transform | `/api/image-transformations/*` | **REAL** | `api-bridge.ts:5290` Sharp | — |
| Fine-Tune | `/api/fine-tune/*` | **PARTIAL** | `api-bridge.ts:1566-1722` OpenAI files/jobs; 502 on API err; `export` 404 <10 examples | error handling. **M** |
| Browser Agent | `/api/browser-agent/*` | **REAL** | `api-bridge.ts:3525` Puppeteer sessions | needs browser pool |
| Build Tasks | `/api/build/tasks*` | **REAL** | `api-bridge.ts:8904-9031` Postgres queue, SKIP LOCKED | — |

## Cluster 4 — Research / Evaluation / Quality

| Feature | UI endpoint | Status | Evidence | Fix |
|--------|-------------|--------|----------|-----|
| Deep Research | `/api/research(,/:id/stream)` | **REAL** | `api-bridge.ts:2742-2827` + `routes/researcher.ts`; Tavily if key else scraper | — |
| Research related-questions | `/api/research/related-questions` | **STUB** | `api-bridge.ts:2748` empty array | LLM gen. **M** |
| A/B Arena | `/api/ab*` | **REAL** | `api-bridge.ts:734-847` `raceModels` (OpenRouter key) | persist to DB. **S** |
| Simulation | `/api/simulate/*` | **REAL** | `api-bridge.ts:5908-6066, 6800-6868` LLM persona ticks | — |
| **Agents** | `/api/v1/agents` | **MISMATCH (404)** | real at `routes/agents.ts:192` under different sub-paths (`/agents/librarian/query`, `/agents/file/*`) | repoint UI. **S** |
| Evals scorers/score/run | `/api/v1/evals/*` | **REAL** | `routes/evals.ts:49-277` | — |
| **Evaluate (LLM judge)** | `/api/evaluate` | **CONFLICT** | code at `api-bridge.ts:1952` but probe 404 at `/api/evaluate` | verify mount/prefix. **S** |
| Evaluation dashboard/metrics | `/api/evaluation/*` | **STUB-data** | `api-bridge.ts:1901-1934` hardcoded averages | wire to results store. **M** |
| Evaluation results | `/api/evaluation/results` | **REAL** | `api-bridge.ts:1936` CRUD | — |
| Moderation check/batch/config | `/api/moderation/*` | **REAL** | `api-bridge.ts:6121-6141` OpenAI moderation/heuristic | — |
| Prompt-filter check/sanitize/batch | `/api/prompt-filter/*` | **REAL** | `api-bridge.ts:3662-3696` `@nexus/redteam` | — |
| Prompt-filter patterns | `/api/prompt-filter/patterns` | **STUB-data** | `api-bridge.ts:3699` static | dynamic store. **S** |
| Hallucination score/groundedness/batch | `/api/hallucination/*` | **REAL** | `api-bridge.ts:6384-6428` LLM | — |
| Hallucination thresholds | `/api/hallucination/thresholds` | **STUB-data** | `api-bridge.ts:6353` static | config. **S** |
| Verifiable verify | `/api/verifiable/verify` | **STUB→partial** | `api-bridge.ts:3946` pipelines not real | implement checks. **L** |
| Task Routing (classify/stats/config) | `/api/task-routing/*` | **STUB** | `api-bridge.ts:3866-3894` hardcoded "general" | real classifier. **M** |
| Speculative (run/classify) | `/api/speculative/run,classify` | **REAL** | `api-bridge.ts:6444-6510` 2-phase | stats stub |
| Specialisation domains/apply | `/api/specialisation/*` | **REAL** | `api-bridge.ts:4929-4965` | detect is stub. **M** |
| Reactions | `/api/reactions*` | **REAL** | `api-bridge.ts:4635-4680` | — |
| **Fallback-chains test** | `/api/fallback-chains/test` | **MISSING (404)** | list route exists, `/test` does not | add executor. **M** |

## Cluster 5 — Connectors / Config / Admin / Ops

| Feature | UI endpoint | Status | Evidence | Fix |
|--------|-------------|--------|----------|-----|
| Connectors | `/api/connectors` | **REAL(cond)** | `routes/connectors.ts:49` env-driven registry, Null fallback | set tokens |
| Connector sync-jobs | `/connectors/:id/sync-jobs` | **STUB** | `api-bridge.ts:2292` empty array | job queue. **M** |
| RSS | `/api/rss/*` | **REAL** | `api-bridge.ts:7181-7254` persistent + poll | — |
| Web Scraping | `/api/web-scraping/*` | **REAL** | `api-bridge.ts:5629` Firecrawl/Exa/basic | — |
| Web Search | `/api/web-search*` | **REAL** | `api-bridge.ts:1371` Tavily→SearXNG | — |
| Rooms | `/api/rooms*` | **STUB** | `api-bridge.ts:1107` in-mem; `join/:code` missing | implement join + WS. **M** |
| Projects | `/api/projects` | **REAL** | `api-bridge.ts:8763` CRUD (in-mem) | — |
| Marketplace | `/api/marketplace*` | **REAL** | `api-bridge.ts:8669-8747` CRUD (in-mem) | — |
| Billing plans/checkout | `/api/billing/*` | **STUB** | `routes/billing.ts:29`; checkout no-op ("Nexus is free") | intentional (no paywall) |
| Billing subscription | `/api/v1/billing/subscription` | **MISSING** | no route | doc free-only or add. **S** |
| Billing usage by-model-day | `/api/v1/billing/usage/by-model-day` | **REAL (500 on DB blip)** | `routes/billing.ts:342` Drizzle | DB fallback exists |
| Cost dashboard/breakdown/efficiency/pricing | `/api/costs/*` | **REAL** | `api-bridge.ts:1465-1556` from `_costLog` | in-mem |
| Cost limits | `/api/costs/limits` | **STUB** | `api-bridge.ts:1542` env vars not enforced | enforce. **M** |
| Analytics overview | `/api/analytics/overview` | **STUB** | `api-bridge.ts:1560` zeros | aggregate gatewayLog. **S** |
| Analytics daily/models/providers | `/api/analytics/*` | **REAL** | `api-bridge.ts:8396-8439` | — |
| Gateway messages/models | `/api/v1/gateway/*` | **REAL** | `routes/gateway.ts` 15 providers, SSE, budgeting | flagship — works |
| Provider Keys | `/api/user/provider-keys` | **REAL** | `api-bridge.ts:2195` Postgres | — |
| API Tokens | `/api/tokens` | **REAL** | `api-bridge.ts:1313` `nxk_` + sha256 | — |
| Voice transcribe/synthesize/providers | `/api/v1/voice/*` | **REAL(key)** | `routes/voice.ts:103-212` Groq / ElevenLabs | needs keys |
| Voice chat | `/api/v1/voice/chat` | **STUB** | `voice.ts:70` echo, not wired to LLM | wire to gateway. **M** |
| Video transcript | `/api/video/transcript*` | **STUB** | `routes/video-transcript.ts:102` empty segments | youtube-transcript + STT. **L** |
| Settings preferences | `/api/settings/preferences` | **REAL** | `api-bridge.ts:1087` in-mem | — |
| Token Conservation | `/api/token-conservation/*` | **STUB** | `api-bridge.ts:5555` hardcoded | budget tracking. **M** |
| Verbosity | `/api/verbosity/levels` | **REAL(display)** | `api-bridge.ts:5594` | — |
| Leaderboard | `/api/leaderboard` | **STUB (fake data)** | `api-bridge.ts:9234` fictional GPQA/SweBench numbers | real source or remove. **L** |
| Admin users | `/api/admin/users` | **STUB** | `api-bridge.ts:2004` in-mem, not `users` table | wire to DB. **M** |
| Admin audit logs | `/api/admin/audit-logs` | **STUB** | `api-bridge.ts:2019` never populated | emit audit events. **L** |
| Admin traces/stats/routes/settings | `/api/admin/*` | **REAL** | `routes/admin.ts:55-302` gatewayLog KV | — |
| Feature Flags | `/api/feature-flags/*` | **REAL** | `routes/feature-flags.ts` | — |
| Feedback | `/api/feedback/*` | **STUB** | `api-bridge.ts:2266` zeros/empty | add collector. **M** |
| Notifications | `/api/notifications*` | **MISSING** | no route anywhere | notif service + store. **L** |
| Orchestration runs | `/api/v1/orchestration/*` | **REAL (500 on DB blip)** | `routes/orchestration.ts:38-157` Drizzle | DB fallback |
| GhostStack (gs) | `/api/v1/gs/*` | **REAL** | `routes/conductor-route.ts:59-139` orchestrator | — |
| System config | `/api/system/config` | **REAL** | `api-bridge.ts:8451` in-mem | — |

---

## Recommended build order (when we move from audit → work)

**Phase 0 — Stability (do first, S):** global Fastify `setErrorHandler` + `process.on('unhandledRejection')` guard; null-check the gauntlet/body crashers. Stops one bad request downing the server.

**Phase 1 — Cheap contract fixes (S, high visual payoff):** repoint the ~8 path-mismatch endpoints (archetypes, drift, agents, evaluate, fallback-chains, codegen, craft) so already-built backends light up. This is the biggest "dead→alive" win per hour.

**Phase 2 — Embeddings swap (M):** replace `GroqEmbedder` with a real embedding provider → revives Memory, Cross-Memory, Semantic-Cache in one change.

**Phase 3 — Sandbox runtime (M):** self-host Piston (docker) or Pyodide → Python/multi-lang sandbox + code-agent.

**Phase 4 — Engines (L, pick by value):** Workflow executor; Notifications; Verifiable pipelines; audit-log collection.

**Phase 5 — De-stub or delete (S–M):** either wire the ~25 stub endpoints to real data, or remove the pages so the product stops advertising things it can't do. Decide per feature.

## Notes on infra found during audit
- API dev boot needs: `pino-pretty` installed (was missing); `react-router-dom`→`react-router` vite alias (stray v5); `NEXUS_JWT_SECRET` in `.env`; env loaded into shell (`scripts/dev-local.sh`).
- DB + Redis are cloud (Neon + Redis Cloud). Neon host resolves IPv6-only and intermittently `ENOTFOUND`s on boot — combined with the missing error handler, that crashes startup. Worth a retry/backoff on DB init.
