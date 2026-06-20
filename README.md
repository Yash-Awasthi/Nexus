<!-- SPDX-License-Identifier: Apache-2.0 -->

<div align="center">

<img src="apps/docs-site/static/img/nexus-logo.svg" alt="NEXUS" width="96" />

# NEXUS

**Multi-agent AI orchestration — from a single prompt to a self-coordinating swarm.**

<p>
  <a href="https://github.com/Yash-Awasthi/Nexus/actions/workflows/test.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/Yash-Awasthi/Nexus/test.yml?branch=main&label=CI&logo=github&style=flat-square" alt="CI">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License">
  </a>
  <a href="https://github.com/Yash-Awasthi/Nexus/releases">
    <img src="https://img.shields.io/github/v/release/Yash-Awasthi/Nexus?include_prereleases&style=flat-square" alt="Release">
  </a>
  <img src="https://img.shields.io/badge/TypeScript-5.4-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node-20+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/pnpm-9+-f69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm">
  <img src="https://img.shields.io/badge/packages-107-8b5cf6?style=flat-square" alt="Packages">
  <img src="https://img.shields.io/badge/tests-4542%20passing-22c55e?style=flat-square" alt="Tests">
</p>

<p>
  <a href="#running-nexus"><strong>Quick Start</strong></a> ·
  <a href="#architecture"><strong>Architecture</strong></a> ·
  <a href="docs/"><strong>Docs</strong></a> ·
  <a href="https://github.com/Yash-Awasthi/Nexus/issues"><strong>Issues</strong></a>
</p>

<a href="https://railway.app/new/template?template=https://github.com/Yash-Awasthi/Nexus">
  <img src="https://railway.app/button.svg" alt="Deploy on Railway" height="28">
</a>

</div>

---

NEXUS is a **107-package TypeScript monorepo** that handles everything from raw prompt routing to multi-model deliberation, long-term vector memory, sandboxed code execution, and document ingestion — backed by a React dashboard wired to all of it.

Built BYOK: connect your own LLM API keys. No data leaves your deployment.

---

## What's inside

| Capability | How it works |
|---|---|
| **Multi-model council** | N models run in parallel via `Promise.allSettled`. Unanimous, majority, or weighted voting. 11 AI archetypes (YAML-driven). |
| **15 LLM providers** | Anthropic, OpenAI, Groq, Gemini, DeepSeek, Mistral, OpenRouter, Ollama, LMStudio, LlamaCpp, Fireworks, NvidiaNim, Cerebras, and more. Native SSE streaming, no buffering. |
| **Provider failover** | `classifyFailoverError()` — 3-category, 30+ pattern classifier. Automatic retry with FallbackChain. |
| **Sandboxed code execution** | Piston API for Python, TypeScript, Bash, Go, Rust, Ruby, R. Docker REPL for Python/R/Julia with `--network none`, 256 MB cap, read-only FS. |
| **Long-term memory** | pgvector + `MemoryGraph` BFS. IVFFlat ANN, BM25+RRF hybrid retrieval, TTL, multi-tenant ACL. |
| **Knowledge graph** | Entity + relation graph with Leiden clustering, multi-hop BFS, 6 search modes. |
| **Document pipeline** | extract → classify → OCR → chunk → embed → index. 7 OCR modes, 11 layout categories. |
| **16 domain feed sources** | Aviation, climate, conflict, economic, displacement, cyber, health, seismology, wildfire, maritime, market, sanctions, radiation, space, imagery, patents. BullMQ repeatable jobs. |
| **Orchestration** | `VersionedPlan` + `ChannelIndex` — 13 lifecycle states, immutable plan snapshots, `PlanningEngine` with 11 blueprints. |
| **Cost tracking** | Per-call token accounting → Prometheus `/api/v1/metrics`. 18-model price table. |
| **Gauntlet** | Races 47 models in waves of 12, 150 ms stagger, `scoreResponse()` 0–100, 5 speed tiers. |
| **Red-team engine** | Input perturbation with configurable attack profiles. |
| **RAG** | Chunk → embed → retrieve → rerank. Sub-query decomposition, Jaccard+cosine hybrid. |
| **RLHF + eval pipeline** | Scorers, test runner, SFT auto-tagger, corpus builder. |
| **MCP support** | JSON-RPC 2.0 HTTP transport, batch invocation, OpenAPI-to-MCP auto-generation. |
| **Observability** | OpenTelemetry (OTLP), Jaeger, Prometheus, Grafana dashboards pre-provisioned. HMAC-SHA256-chained audit logs. |
| **Auth** | API key + HS256 JWT. OAuth connectors for Google, GitHub, Slack. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NEXUS monorepo                                 │
│                                                                             │
│  ┌──────────────┐   ┌───────────────────┐   ┌──────────────────────────┐   │
│  │  services/   │   │    apps/api        │   │      apps/worker         │   │
│  │   ingest     │──▶│  (Fastify)         │──▶│  BullMQ high/med/low     │   │
│  │  (Python)    │   │  REST + SSE + MCP  │   │  signal + task queues    │   │
│  └──────────────┘   └────────┬──────────┘   │  repeatable feed jobs    │   │
│         │                    │               └──────────────────────────┘   │
│  adapters emit               │ REST/SSE                                     │
│  ingested_events             ▼                                              │
│         │           ┌──────────────┐   ┌──────────────────────────────┐    │
│         │           │   apps/ui    │   │         apps/cli             │    │
│         │           │ (React RR7)  │   │       (commander.js)         │    │
│         │           └──────────────┘   └──────────────────────────────┘    │
│         ▼                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         packages/ (107)                              │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │  │ agent-runtime  │  │   council    │  │      llm-drivers        │   │   │
│  │  │ multi-step     │  │ multi-model  │  │  15 providers           │   │   │
│  │  │ tool loop +    │  │ voting with  │  │  native SSE/NDJSON      │   │   │
│  │  │ swarm layer    │  │ allSettled   │  │  streaming              │   │   │
│  │  └────────────────┘  └──────────────┘  └────────────────────────┘   │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │  │   mcp-client   │  │  code-repl   │  │      conductor          │   │   │
│  │  │ JSON-RPC 2.0   │  │  Docker REPL │  │  PlanningEngine         │   │   │
│  │  │ HTTP transport │  │  Py/R/Julia  │  │  GovernanceEngine       │   │   │
│  │  │                │  │  sandboxed   │  │  TaskExecutor           │   │   │
│  │  └────────────────┘  └──────────────┘  └────────────────────────┘   │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │  │    memory      │  │   runtime    │  │      plugin-sdk         │   │   │
│  │  │ pgvector +     │  │ circ-breaker │  │  defineAdapter()        │   │   │
│  │  │ MemoryGraph    │  │ crash-recov  │  │  + test harness         │   │   │
│  │  │ IStream/IState │  │ OTel tracing │  │                         │   │   │
│  │  └────────────────┘  └──────────────┘  └────────────────────────┘   │   │
│  │                                                                      │   │
│  │  redteam · drift · stm · retrieval · evals · knowledge-graph ·      │   │
│  │  context-pruner · trigger-engine · stream-recovery · pipeline-      │   │
│  │  signal · domain-feeds · stealth-browser · gauntlet · supervisor ·  │   │
│  │  doc-pipeline · prediction-market · mcp-bulk · mcp-openapi          │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  PostgreSQL (pgvector) · Redis (BullMQ) · Docker (REPL sandbox)            │
│  Prometheus · Grafana · OpenTelemetry (OTLP) · Jaeger                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Repository layout

```
nexus/
├── apps/
│   ├── api/            Fastify HTTP/SSE/WebSocket gateway (61 route modules)
│   ├── cli/            Developer CLI (commander.js)
│   ├── docs-site/      Docusaurus documentation site
│   ├── ui/             React Router v7 SPA dashboard (100+ routes)
│   └── worker/         BullMQ workers — signal, task, and repeatable feed jobs
├── packages/           107 scoped @nexus/* packages
│   ├── agent-runtime/          Multi-step tool loop, swarm, VersionedPlan
│   ├── council/                Multi-model voting (unanimous/majority/weighted)
│   ├── llm-drivers/            15 provider drivers, native SSE streaming
│   ├── llm-router/             Dynamic routing by cost/latency/capability
│   ├── gateway/                IProvider, FallbackChain, classifyFailoverError()
│   ├── best-of-n/              Best-of-N sampling + tournament selection
│   ├── mcp-client/             JSON-RPC 2.0 MCP consumer
│   ├── mcp-bulk/               Batch tool invocation
│   ├── mcp-openapi/            OpenAPI → MCP tool auto-generation
│   ├── code-repl/              DockerReplExecutor — sandboxed Python/R/Julia
│   ├── runtime/                Circuit breaker, crash recovery, OTel tracing
│   ├── conductor/              PlanningEngine (11 blueprints), TaskExecutor
│   ├── memory/                 pgvector, MemoryGraph BFS, IVFFlat ANN
│   ├── memory-tools/           remember() / recall() / forget() API
│   ├── stm/                    Short-term memory: HedgeReducer, STMPipeline
│   ├── knowledge-graph/        Entity graph, Leiden clustering, multi-hop BFS
│   ├── retrieval/              RAG: chunk→embed→retrieve→rerank, hybrid search
│   ├── context-pruner/         LlmCompactor + MicroCompactor (dual-trigger)
│   ├── pipeline-signal/        ingest → classify → typed Signal rows
│   ├── domain-feeds/           16 global intelligence domains, BullMQ jobs
│   ├── adaptive-scraper/       Proxy-aware scraper with robots.txt
│   ├── stealth-browser/        PatchrightDriver + Redis Streams
│   ├── doc-pipeline/           extract → classify → OCR → index
│   ├── redteam/                Input perturbation engine
│   ├── drift/                  EMA adaptive parameter tuning
│   ├── gauntlet/               47-model race, 5 speed tiers, 0-100 scoring
│   ├── evals/                  Scorers, test runner, result types
│   ├── rlhf-pipeline/          RLHF data pipeline
│   ├── telemetry/              OTel, HMAC-chained audit log, Prometheus
│   ├── auth/                   API key + HS256 JWT, Fastify preHandler
│   ├── db/                     Drizzle ORM — 7 schemas, typed migrations
│   ├── prediction-market/      Polymarket + Kalshi + Metaculus CLOB
│   ├── plugin-sdk/             defineAdapter(), ISocialProvider, test harness
│   └── adapter-{25}/           betterstack, calendar, cloudflare, confluence,
│                               drive, github, gmail, groq, hubspot, jira,
│                               linear, neon, notion, salesforce, slack, ...
├── services/
│   └── ingest/         Python (FastAPI + Celery) — adapter runners → DB
├── infra/
│   ├── docker/         docker-compose.dev/ci/observability
│   ├── grafana/        Pre-provisioned dashboards
│   ├── otel/           OTel Collector, Prometheus, datasource configs
│   ├── helm/nexus/     Helm chart (6 templates, HPA, ingress)
│   ├── k8s/            Kubernetes manifests
│   ├── terraform/      GKE / EKS provisioning modules
│   ├── k6/             Load test scripts (200 VU, 5-minute soak)
│   └── chaos/          Pod kill + network partition chaos tests
├── docs/
│   ├── adr/            18 Architecture Decision Records
│   ├── runbook.md      Operational runbook
│   ├── slos.md         SLO definitions and targets
│   └── security/       Threat model
├── docker-compose.yml  Local dev stack (postgres, redis, ingest, api)
└── .env.example        Complete environment variable reference
```

---

## Running NEXUS

### Option A — Docker (simplest, no Node required)

```bash
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus

cp .env.example .env
# Required: set NEXUS_API_KEY and at least one LLM key (e.g. GROQ_API_KEY)
# DATABASE_URL and REDIS_URL are pre-filled for the local stack

docker compose up
```

| Service | URL |
|---|---|
| API | http://localhost:3000 |
| UI | http://localhost:4173 |
| Bull Board | http://localhost:3002 |
| Ingest (Python) | http://localhost:8000 |

```bash
# Verify
curl http://localhost:3000/api/v1/health
```

---

### Option B — Local dev (hot reload)

**Prerequisites:** Node 20+, pnpm 9+, Docker (for Postgres + Redis)

```bash
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus

pnpm install
docker compose up -d postgres redis

cp .env.example .env
# Set NEXUS_API_KEY and at least one LLM key

pnpm db:migrate
pnpm dev
```

Dev servers:

| Service | URL |
|---|---|
| API (Fastify, hot reload) | http://localhost:3001 |
| UI (Vite, hot reload) | http://localhost:5173 |
| Worker (BullMQ) | background process |

---

### Option C — Observability stack

Adds Prometheus, Grafana, OTel Collector, and Jaeger to the local stack:

```bash
docker compose -f docker-compose.yml -f infra/docker/docker-compose.observability.yml up
```

| Service | URL |
|---|---|
| Grafana | http://localhost:3010 |
| Prometheus | http://localhost:9090 |
| Jaeger | http://localhost:16686 |

---

## Environment variables

Minimum required to start:

| Variable | Description |
|---|---|
| `NEXUS_API_KEY` | Master API key for all `/api/v1/*` requests |
| `DATABASE_URL` | PostgreSQL connection string (with pgvector) |
| `JWT_SECRET` | HS256 signing secret |
| `GROQ_API_KEY` | Default LLM provider (or any other driver key) |

Full reference in [`.env.example`](.env.example).

> **BYOK model:** Users supply their own LLM API keys via the Language Models settings page. The platform uses `GROQ_API_KEY` as the server-side default (e.g. for code agent tasks); no per-user AI spend is needed.

OAuth connectors (optional):

| Variable | Provider |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Drive + Sign-In |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub connector |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` | Slack connector |
| `OAUTH_REDIRECT_BASE` | Base URL of your API deployment |

---

## SDK usage

```typescript
import { AgentRuntime } from "@nexus/agent-runtime";
import { Council } from "@nexus/council";
import { GroqDriver } from "@nexus/llm-drivers";

// Single agent
const agent = new AgentRuntime({ driver: new GroqDriver() });
const result = await agent.run({ task: "Summarise the attached PDF." });

// Multi-model council vote
const council = new Council({
  members: [
    { driver: new GroqDriver(),     weight: 1 },
    { driver: new AnthropicDriver(), weight: 2 },
  ],
  mode: "weighted",
});
const { consensus, votes } = await council.deliberate("Should we refactor auth?");

// Memory
import { remember, recall } from "@nexus/memory-tools";
await remember("Project deadline is June 30", { userId: "u1", tags: ["project"] });
const hits = await recall("deadline", { userId: "u1", limit: 5 });
```

---

## Core concepts

**Agent runtime** — multi-step tool loop. Agents plan, call tools, observe results, and loop until done or a step limit is reached. Swarm mode spawns sub-agents and coordinates them via `ChannelIndex`.

**Council** — runs N models in parallel with `Promise.allSettled`. One model failure doesn't break the vote. Supports 11 AI archetypes (Analyst, Devil's Advocate, Synthesist, …) configured in YAML.

**Conductor** — `PlanningEngine` breaks a goal into a `VersionedPlan` with 11 blueprint types. `GovernanceEngine` applies constraints. `TaskExecutor` runs each step with retry, backoff, and circuit breaker.

**Memory** — pgvector stores embeddings. `MemoryGraph` builds a BFS-traversable relation graph with score × edgeWeight × 0.7^depth decay. Hybrid BM25+RRF retrieval. Per-tenant ACL.

**Context management** — `MicroCompactor` fires at 8 turns OR 80 k tokens, keeps 4 recent turns. `LlmCompactor` handles consecutive failure blocking with a 0.80 compaction threshold.

**Gauntlet** — races 47 models in waves of 12 with 150 ms stagger. `scoreResponse()` returns 0–100. Results stream back as each wave completes.

**Signal pipeline** — ingest → classify → typed `Signal` rows. 7 built-in classifier rules. PostgreSQL `LISTEN/NOTIFY` hot path for low-latency consumers.

**Observability** — every request gets an OTel trace. Audit events are HMAC-SHA256 chained (tamper-evident). Prometheus metrics scraped at `/api/v1/metrics`. Two Grafana dashboards pre-provisioned.

---

## Scripts

```bash
pnpm build          # Build all packages and apps
pnpm dev            # Start all services in watch mode
pnpm test           # Run full test suite (Vitest)
pnpm typecheck      # tsc --noEmit across all packages
pnpm lint           # ESLint + Prettier check
pnpm db:migrate     # Run Drizzle migrations
pnpm db:studio      # Open Drizzle Studio
```

---

## Deployment

### Render + Vercel (recommended free tier)

```
API  → Render   (apps/api, Docker)
UI   → Vercel   (apps/ui, static SPA)
DB   → Neon     (PostgreSQL + pgvector)
KV   → Upstash  (Redis — optional, in-memory fallback included)
```

Set all environment variables from `.env.example` in your Render service. The Vercel UI proxies `/api/*` to the Render API via `vercel.json` rewrites.

### Docker Compose (production)

```bash
docker compose -f docker-compose.yml up -d
```

### Kubernetes

```bash
helm upgrade --install nexus infra/helm/nexus \
  --set image.tag=latest \
  --set env.DATABASE_URL="$DATABASE_URL" \
  --set env.NEXUS_API_KEY="$NEXUS_API_KEY"
```

Manifests for individual services in `infra/k8s/`. Terraform modules for GKE/EKS in `infra/terraform/`.

---

## Testing

```bash
pnpm test                         # Full suite
pnpm test --filter @nexus/council # Single package
pnpm --filter @nexus/evals test   # Eval suite
```

Load testing:
```bash
k6 run infra/k6/smoke.js          # Quick smoke test
k6 run infra/k6/soak.js           # 200 VU, 5-minute soak
```

Chaos testing:
```bash
# Pod kill + network partition scenarios
bash infra/chaos/pod-kill.sh
bash infra/chaos/network-partition.sh
```

---

## Architecture Decision Records

18 ADRs in [`docs/adr/`](docs/adr/). Notable decisions:

- ADR-001: pnpm workspaces over Nx/Turborepo
- ADR-004: pgvector over dedicated vector DB
- ADR-007: `Promise.allSettled` for council fanout (no cascade failure)
- ADR-011: HMAC-chained audit log for tamper evidence
- ADR-015: Piston API for sandboxed multi-language code execution
- ADR-018: BullMQ repeatable jobs for domain feed polling

---

## Contributing

1. Fork and clone
2. `pnpm install`
3. Create a branch: `git checkout -b feat/your-feature`
4. Make changes, add tests
5. `pnpm typecheck && pnpm test && pnpm lint`
6. Open a PR against `main`

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full guide. All contributions welcome — bug fixes, new LLM driver adapters, domain feed sources, or documentation.

---

## Security

- Threats modelled in [`docs/security/threat-model.md`](docs/security/threat-model.md)
- Audit log is HMAC-SHA256 chained — any insertion or deletion is detectable
- Code execution sandboxed: `--network none`, `--read-only`, 256 MB memory cap
- All secrets via environment variables — never committed
- Report vulnerabilities privately via GitHub Security Advisories

---

## License

[Apache 2.0](LICENSE) — free to use, modify, and distribute. Attribution appreciated.

---

<div align="center">
  <sub>Built by <a href="https://github.com/Yash-Awasthi">Yash Awasthi</a> · Apache 2.0</sub>
</div>
