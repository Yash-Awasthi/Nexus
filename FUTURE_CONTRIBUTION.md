# Future of NEXUS — Roadmap & Contribution Areas

This document captures what NEXUS could grow into, where contributions are most needed, and how to scale the platform for real-world deployment.

---

## Hosting & Infrastructure Upgrades

### Current (free tier)
- API: Render (free instance — sleeps after 15 min idle, cold start ~30s)
- UI: Vercel (free)
- DB: Neon PostgreSQL (free tier — 512 MB storage, connection limits)
- KV: in-memory fallback (no Redis persistence)

### Recommended upgrades

| Layer | Free → Paid | What you unlock |
|---|---|---|
| **API** | Render Starter ($7/mo) | Always-on, no cold starts, persistent disk |
| **API** | Render Standard ($25/mo) | 2 GB RAM, 1 CPU — handles concurrent agent workloads |
| **DB** | Neon Pro ($19/mo) | More compute units, larger storage, branching for dev/staging |
| **DB** | Supabase Pro ($25/mo) | Managed pgvector, edge functions, built-in auth |
| **KV/Queue** | Upstash Redis ($10/mo) | Persistent BullMQ queues — survive restarts, multi-worker support |
| **UI** | Vercel Pro ($20/mo) | Analytics, higher bandwidth, team features |
| **Docker sandbox** | Any VPS with Docker ($6–15/mo) | Replace Piston with full DockerReplExecutor for local sandboxing |

### Cloud deployment options
- **Railway** — one-click deploy via the button in the README; includes managed Postgres and Redis. Good starting point.
- **Fly.io** — good fit for the Fastify API; global edge deploys, persistent volumes, ~$5/mo for a small instance.
- **AWS ECS / GCP Cloud Run** — containerized, auto-scaling. Use the `infra/terraform/` modules for GKE/EKS.
- **Kubernetes** — full `infra/helm/nexus/` chart available. Use with GKE, EKS, or bare-metal for high throughput.

---

## Scaling Architecture

### What needs work at scale

**Connection pooling**
The API currently uses direct Neon connections. At >10 concurrent requests, add PgBouncer or use the Neon pooler URL (`-pooler` suffix) in `DATABASE_URL`.

**Worker scaling**
BullMQ workers run in a single `apps/worker` process. For production:
- Run multiple worker instances with separate concurrency limits per queue (high/med/low)
- Use `WORKER_CONCURRENCY` env var to tune per-worker thread count
- Consider splitting domain-feed workers from task workers to isolate noisy feed jobs

**Memory/pgvector at scale**
- Add IVFFlat `probes` tuning: `SET ivfflat.probes = 20` for better recall at cost of latency
- Migrate to HNSW index once Neon supports it (better ANN recall, no training step)
- Add per-tenant table partitioning when memory rows exceed ~1M

**LLM cost control**
- Enable `llm-cache` package — caches identical prompts so repeated queries don't burn tokens
- Add `token-budget` package limits per user session
- Wire Prometheus cost tracking to alerting (alert when daily spend crosses threshold)

**Ingest service**
The Python `services/ingest/` FastAPI+Celery service is optional today. At scale:
- Run it as a separate container with its own Celery worker pool
- Point domain feed adapters at the ingest service instead of BullMQ directly
- Add dead-letter queues for failed feed jobs

---

## Feature Roadmap

### Near-term (good first contributions)

- [ ] **User accounts** — the auth package exists but there's no sign-up/login flow in the UI. Wire `POST /api/v1/auth/register` and `POST /api/v1/auth/login` to a login page.
- [ ] **Per-user API key management** — store BYOK keys encrypted in the DB instead of localStorage; add a key rotation UI.
- [ ] **Streaming Council responses** — the council currently waits for all models to finish. Add SSE streaming so the UI shows each model's answer as it arrives.
- [ ] **Prompt versioning UI** — the backend has `prompt_versions` table and routes; the UI Prompts page needs a version history drawer.
- [ ] **Build task dependencies** — the `parent_id` column exists in `build_tasks`; add DAG rendering in the Build page.
- [ ] **MCP server registry** — UI page to add/remove MCP servers; currently hardcoded in config.

### Medium-term

- [ ] **Voice interface** — `packages/voice/` has the TTS/STT pipeline. Wire it to the UI with a push-to-talk button and streaming transcription.
- [ ] **Image generation** — `packages/image-gen/` adapters exist. Add an image tab to the Sandbox page.
- [ ] **Knowledge graph UI** — `packages/knowledge-graph/` has Leiden clustering and multi-hop BFS. Add a graph visualisation page (D3.js or React Flow).
- [ ] **Prediction markets dashboard** — `packages/prediction-market/` has Polymarket/Kalshi/Metaculus CLOB backends. Build a markets page.
- [ ] **Gauntlet UI** — the race-47-models feature exists in `packages/gauntlet/` but has no UI. Add a competitive model benchmark page.
- [ ] **RLHF feedback loop** — the `rlhf-pipeline` package exists; add thumbs up/down on council responses that feed back into the pipeline.
- [ ] **Eval runner UI** — `packages/evals/` has scorers and test runner; build a UI to run eval suites and view results.

### Long-term / ambitious

- [ ] **Multi-tenant SaaS** — add org-level isolation, per-org usage quotas, billing via Stripe
- [ ] **Plugin marketplace** — let users publish custom adapters using `packages/plugin-sdk/`; host them in a registry
- [ ] **Fine-tuning pipeline** — end-to-end SFT from NEXUS conversation history using `packages/sft-tagger/` and `packages/corpus-builder/`
- [ ] **Agentic browser** — `packages/stealth-browser/` has PatchrightDriver; build a full browser-use agent accessible from the UI
- [ ] **Mobile app** — React Native wrapper with push notifications for agent task completion
- [ ] **Custom LLM driver** — framework for adding new providers; currently requires adding a file in `packages/llm-drivers/`; document and simplify the interface

---

## New LLM Providers to Add

The `packages/llm-drivers/` pattern is straightforward — each driver implements `IProvider`. Good contributions:

- `xai` (Grok) — large context, strong reasoning
- `together` (Together AI) — cheap open-model inference
- `perplexity` — built-in search augmentation
- `cohere` — strong reranking + embeddings
- `aws-bedrock` — enterprise Anthropic/Meta access
- `azure-openai` — required for enterprise customers

---

## Domain Feed Sources to Add

`packages/domain-feeds/` currently has 16 domains. Additional sources:

- **Legislative tracking** — congressional bills, EU directives
- **Scientific preprints** — arXiv, bioRxiv
- **Earnings & SEC filings** — EDGAR, 8-K filings
- **Social signals** — Reddit, HN (rate-limited, respectful)
- **Dark web monitoring** — Tor-accessible sources (requires careful legal review)
- **Supply chain** — shipping AIS data, port congestion

---

## Developer Experience

- [ ] Add `pnpm dev:api` and `pnpm dev:ui` scripts that start only the relevant service (instead of all)
- [ ] Add `pnpm scaffold:driver <name>` CLI command to scaffold a new LLM driver
- [ ] Add `pnpm scaffold:adapter <name>` to scaffold a new adapter package
- [ ] Add `pnpm scaffold:feed <name>` to scaffold a new domain feed
- [ ] Pre-built Docker images on GitHub Container Registry so users don't need to build locally
- [ ] GitHub Codespaces devcontainer config for zero-setup development
- [ ] Improve test coverage — currently 4542 tests, aim for 80%+ coverage across core packages

---

## Portfolio Website

A public portfolio website for NEXUS could include:

- Live Gauntlet race visualization
- Real-time council deliberation demo (public API key, rate-limited)
- Interactive architecture diagram
- Package browser with API docs
- Eval leaderboard comparing providers

Tech suggestion: React + Vercel, pulling from the NEXUS API for live data.

---

## Contributing

See `CONTRIBUTING.md` for code standards, branch strategy, and PR template.

The highest-leverage areas right now:
1. New LLM driver adapters (each one is ~150 lines, well-tested pattern)
2. UI pages for existing backend features (Gauntlet, Knowledge Graph, Evals)
3. Documentation — ADRs, package READMEs, and runbooks
4. Test coverage for `packages/council/`, `packages/memory/`, and `packages/conductor/`
