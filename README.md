<!-- SPDX-License-Identifier: Apache-2.0 -->

<p align="center">
  <img src="apps/docs-site/static/img/nexus-logo.svg" alt="NEXUS" width="80" />
</p>

<h1 align="center">NEXUS</h1>

<p align="center">
  <strong>Autonomous AI orchestration — sense, think, decide, act.</strong><br/>
  A production-grade, open-source platform for multi-agent pipelines, council deliberation, and plugin-extensible intelligence.
</p>

<p align="center">
  <a href="https://github.com/Yash-Awasthi/Nexus/actions"><img src="https://img.shields.io/github/actions/workflow/status/Yash-Awasthi/Nexus/test.yml?branch=main&label=CI&logo=github" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache 2.0"></a>
  <a href="https://github.com/Yash-Awasthi/Nexus/releases"><img src="https://img.shields.io/github/v/release/Yash-Awasthi/Nexus?include_prereleases" alt="Release"></a>
  <a href="https://nexus.dev/docs/intro"><img src="https://img.shields.io/badge/docs-nexus.dev-8b5cf6" alt="Docs"></a>
  <img src="https://img.shields.io/badge/tests-5914%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/packages-140%2B-blue" alt="Packages">
</p>

---

## What is NEXUS?

NEXUS is a **multi-agent orchestration engine** built for teams that need reliable, auditable, observable AI pipelines. It solves the hard problems:

- **Signal ingestion** — adapters collect raw events from GitHub, Gmail, Slack, Linear, and 20+ custom sources
- **Council deliberation** — multiple AI models vote on a query concurrently via `Promise.allSettled`; synthesis and guardrails prevent rogue outputs
- **Agent execution** — `AgentRuntime` drives multi-step tool-calling loops with abort handling, cache control, and parallel child-agent spawning via `spawn_agents`
- **Sandboxed code execution** — `DockerReplExecutor` runs Python/R/Julia in Docker with network isolation, memory caps, and CPU throttling
- **Real LLM streaming** — 15 provider drivers (Anthropic, OpenAI, Groq, Gemini, etc.) with native SSE/NDJSON `ReadableStream` generators
- **MCP layer** — both sides: `mcp-app` (server with progress notifications) and `mcp-client` (consumer of external MCP tool registries)
- **Long-term memory** — vector search over agent memory with IVFFlat ANN index, TTL, metadata filtering, multi-tenant ACL, and pgvector backend
- **BullMQ task queues** — 3-tier priority (high/medium/low), repeatable jobs for domain feed polling, Postgres LISTEN/NOTIFY hot path
- **Full observability** — OpenTelemetry traces, structured JSON logs, SLO tracking, HMAC-SHA256-chained audit log
- **Plugin system** — first-class adapter SDK so any team can extend ingestion without touching core

It absorbs and supersedes [workspace](https://github.com/Yash-Awasthi/workspace), [Judica](https://github.com/Yash-Awasthi/Judica), [Ghoststack](https://github.com/Yash-Awasthi/Ghoststack), and [fin-scrape](https://github.com/Yash-Awasthi/fin-scrape).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NEXUS monorepo                                 │
│                                                                             │
│  ┌──────────────┐   ┌───────────────────┐   ┌──────────────────────────┐   │
│  │  services/   │   │    apps/api        │   │      apps/worker         │   │
│  │   ingest     │──▶│  (Fastify)         │──▶│  (BullMQ high/med/low)   │   │
│  │  (Python)    │   │  REST + SSE + MCP  │   │  signal + task queues    │   │
│  └──────────────┘   └────────┬──────────┘   │  + repeatable feed jobs  │   │
│         │                    │               └──────────────────────────┘   │
│  adapters emit               │ REST/SSE                                     │
│  ingested_events             ▼                                              │
│         │           ┌──────────────┐   ┌──────────────────────────────┐    │
│         │           │   apps/web   │   │         apps/cli             │    │
│         │           │ (React SPA)  │   │       (commander.js)         │    │
│         │           └──────────────┘   └──────────────────────────────┘    │
│         ▼                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                           packages/                                  │   │
│  │                                                                      │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │   │
│  │  │ agent-runtime│  │   council    │  │  llm-drivers │               │   │
│  │  │ multi-step   │  │ multi-model  │  │  15 provider │               │   │
│  │  │ tool loop +  │  │ voting with  │  │  SSE/NDJSON  │               │   │
│  │  │ spawn_agents │  │ allSettled   │  │  streaming   │               │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │   │
│  │                                                                      │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │   │
│  │  │   mcp-app    │  │  mcp-client  │  │  code-repl   │               │   │
│  │  │ MCP server + │  │ consumer of  │  │ Docker REPL  │               │   │
│  │  │ progress ctx │  │ external MCP │  │ Py/R/Julia   │               │   │
│  │  │              │  │ registries   │  │ sandboxed    │               │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │   │
│  │                                                                      │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │   │
│  │  │   memory     │  │   runtime    │  │  plugin-sdk  │               │   │
│  │  │ pgvector +   │  │ circ-breaker │  │ defineAdapter│               │   │
│  │  │ IVFFlat ANN  │  │ crash-recov  │  │ + harness    │               │   │
│  │  │ multi-tenant │  │ OTel tracing │  │              │               │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │   │
│  │                                                                      │   │
│  │  + 130 more packages: auth · db · telemetry · pipeline-signal ·     │   │
│  │    domain-feeds · context-pruner · stealth-browser · llm-router ·   │   │
│  │    prediction-market · voice · wiki · adapters (24) · and more      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  PostgreSQL (pgvector) · Redis (BullMQ) · Docker (sandboxed REPL)          │
│  Prometheus · Grafana · OpenTelemetry                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Repository layout

```
nexus/
├── apps/
│   ├── api/            Fastify HTTP/WebSocket/SSE gateway — 25+ route modules
│   ├── cli/            Developer CLI (commander.js)
│   ├── docs-site/      Docusaurus documentation site
│   ├── web/            React SPA dashboard (15 pages)
│   └── worker/         BullMQ task workers + signal workers + repeatable feed jobs
├── packages/           140+ scoped packages (@nexus/*)
│   ├── Core agents
│   │   ├── agent-runtime/      Multi-step LLM loop, spawn_agents, cache-control
│   │   ├── council/            Multi-model voting engine (Promise.allSettled fanout)
│   │   ├── llm-drivers/        15 provider drivers with native SSE/NDJSON streaming
│   │   ├── llm-router/         Dynamic provider routing by cost/latency/capability
│   │   └── best-of-n/          Best-of-N sampling + tournament selection
│   ├── MCP
│   │   ├── mcp-app/            MCP server framework (tools/resources/prompts + progress ctx)
│   │   ├── mcp-client/         MCP consumer — connect to external tool registries
│   │   ├── mcp-bulk/           Batch MCP tool invocation
│   │   ├── mcp-grants/         MCP capability grant management
│   │   └── mcp-openapi/        Generate MCP tools from OpenAPI specs
│   ├── Execution
│   │   ├── code-repl/          Docker REPL sandbox (Python/R/Julia, fail-secure)
│   │   ├── runtime/            Circuit breaker, crash recovery, OTel, queue backends
│   │   ├── sandbox/            General execution sandbox primitives
│   │   └── task-queue/         Queue abstraction: memory/file/Redis
│   ├── Memory & knowledge
│   │   ├── memory/             pgvector store, IVFFlat ANN, TTL, multi-tenant ACL
│   │   ├── memory-tools/       High-level remember/recall/forget API
│   │   ├── knowledge-graph/    Entity + relation graph over memory
│   │   └── ragtime/            RAG pipeline: chunk → embed → retrieve → rerank
│   ├── Data ingestion
│   │   ├── pipeline-signal/    ingest → classify → typed Signal rows
│   │   ├── domain-feeds/       11 global intelligence feeds (BullMQ-polled)
│   │   ├── spider/             Web crawler with depth control
│   │   └── stealth-browser/    Playwright stealth driver (PatchrightDriver)
│   ├── Adapters (24)
│   │   └── adapter-{github,gmail,slack,linear,groq,notion,drive,…}/
│   ├── Infrastructure
│   │   ├── auth/               API key + HS256 JWT, Fastify preHandler hook
│   │   ├── db/                 Drizzle ORM: 7 schemas, typed migrations
│   │   ├── telemetry/          OTel bootstrap + HMAC-chained audit log
│   │   ├── contracts/          OpenAPI 3.1 + AsyncAPI 3.0 machine-readable specs
│   │   └── shared/             Shared types, Result<T,E>, Zod utilities
│   └── AI tools (selection)
│       ├── prediction-market/  Polymarket CLOB backend + OAuth 2.0 connector
│       ├── voice/              TTS/STT pipeline
│       ├── image-gen/          Text-to-image generation adapters
│       ├── context-pruner/     Token budget pruning in the API gateway
│       ├── llm-cache/          Prompt-keyed LLM response cache
│       └── thinker/            Chain-of-thought + think-parse utilities
├── services/
│   └── ingest/         Python ingestion service (FastAPI + Celery adapters → DB)
├── infra/
│   ├── helm/nexus/     Production Helm chart (6 templates + values)
│   ├── terraform/      GKE/EKS provisioning modules
│   └── k6/             Load test scripts (200 VU, 5-minute soak)
├── docs/
│   ├── adr/            18 Architecture Decision Records
│   ├── runbook.md      Operational runbook
│   ├── slos.md         SLO definitions and targets
│   └── security/       Threat model
├── scripts/            Codegen, migration helpers, release tooling
├── docker-compose.yml  Local dev stack (postgres, redis, ingest, api)
└── .env.example        Complete environment variable reference
```

---

## Quick start

**Prerequisites:** Node 20+, pnpm 9+, Docker + Docker Compose

```bash
# 1. Clone and install
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus
pnpm install

# 2. Start infrastructure
docker compose up -d postgres redis

# 3. Configure environment
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL, REDIS_URL, NEXUS_API_KEY

# 4. Run database migrations
pnpm --filter @nexus/db migrate

# 5. Build all packages
pnpm build

# 6. Start development servers
pnpm dev          # starts api + web + worker in parallel via turbo
```

The API will be available at `http://localhost:3000` and the web dashboard at `http://localhost:5173`.

To run the full stack including the Python ingest service:

```bash
docker compose up -d        # postgres + redis + ingest + api
pnpm --filter apps/web dev  # web SPA only
```

For sandboxed code execution (`/api/v1/code-repl`), Docker must be running — the API falls back to `MockReplExecutor` automatically if Docker is unavailable.

---

## Core concepts

### Agent runtime

`@nexus/agent-runtime` drives multi-step LLM tool-calling loops. An `AgentRuntime` instance receives an instruction, streams LLM output through `ToolStreamParser`, dispatches tool calls, feeds results back, and repeats until `maxSteps` or a terminal state.

The `makeSpawnAgentsTool()` factory adds a `spawn_agents` tool to any agent, enabling it to fork N child `AgentRuntime` instances concurrently:

```ts
import { AgentRuntime, makeSpawnAgentsTool } from "@nexus/agent-runtime";

const agent = new AgentRuntime({
  llm: myLlmStreamFn,
  tools: [makeSpawnAgentsTool(myLlmStreamFn, { maxConcurrency: 5 })],
});

const result = await agent.run("Research quantum computing advances in 2025");
```

Child agents run in parallel via `Promise.allSettled` — one failing child never cancels others. Results include per-child `error` fields for failed tasks.

### Council deliberation

`@nexus/council` sends a question to N configured LLM providers simultaneously and synthesizes the responses. The `Promise.allSettled` fanout pattern means a slow or failed provider doesn't block the vote:

```ts
import { CouncilService } from "@nexus/council";

const council = new CouncilService({ providers: ["groq:llama3", "groq:gemma2"] });
const verdict = await council.deliberate("Should we approve this deployment?");
// { verdict: "approve", confidence: 0.87, reasoning: "...", votes: [...] }
```

Voting modes: `unanimous | majority | weighted`. Guardrails enforce output constraints before synthesis.

### LLM streaming

`@nexus/llm-drivers` provides 15 concrete provider adapters. Each driver implements provider-specific SSE or NDJSON parsing with native `ReadableStream` generators — no polling, no buffering:

| Provider  | Protocol   | Streaming |
|-----------|------------|-----------|
| Anthropic | SSE        | `event: content_block_delta` |
| OpenAI    | SSE        | `data.choices[0].delta.content` |
| Groq      | SSE        | OpenAI-compatible |
| Gemini    | NDJSON     | `:streamGenerateContent` |
| +11 more  | SSE/NDJSON | Provider-specific |

### MCP layer

NEXUS is both an MCP server and an MCP consumer:

- **`@nexus/mcp-app`** — build MCP tool servers. Handlers receive a `ToolContext` with `reportProgress()` for streaming progress to callers. `McpServer.callTool(name, args, onProgress?)` wires the callback.
- **`@nexus/mcp-client`** — connect to external MCP registries. `McpClient.listTools()` / `callTool()` over JSON-RPC 2.0 HTTP transport with injectable fetch for testing.

### Sandboxed code execution

`@nexus/code-repl` provides a `DockerReplExecutor` that runs Python, R, and Julia in Docker containers with hard security constraints:

```
--network none          # no outbound traffic
--memory 256m           # hard RAM cap (SIGKILL on overflow)
--cpus 0.5              # CPU throttle
--read-only             # immutable container FS
--no-new-privileges     # drop privilege escalation
--security-opt no-new-privileges
```

The executor is fail-secure: Docker unavailability switches to `MockReplExecutor` gracefully. Sessions are tracked with TTL-based reaping via `SessionReaper`.

### Signal pipeline

Raw events enter via **adapters** through `services/ingest`. Each event is written to `ingested_events`, then `@nexus/pipeline-signal` classifies it into a typed `Signal` row with priority (`critical | high | medium | low`) and routes it to the council queue. Hot path: Postgres `LISTEN/NOTIFY` triggers immediate council deliberation on critical/high signals.

### Domain feed polling

`@nexus/domain-feeds` covers 11 global intelligence domains (aviation, climate, conflict, economic, displacement, cyber, health, imagery, seismology, wildfire, maritime). Feed polling runs as BullMQ repeatable jobs registered at worker boot — not `setInterval` timers. This means:

- Single execution across any number of pods (BullMQ repeat lock)
- Polling survives pod restarts (job definitions persist in Redis)
- Configurable intervals per domain (weather: 5 min, crypto: 1 min, news: 10 min)

### Long-term memory

`@nexus/memory` stores agent memories as pgvector rows with cosine similarity search:

- **IVFFlat ANN index** — ~10-20× faster than sequential scan at 100k+ entries
- **Multi-tenant ACL** — `userId` field on every entry; `search()` and `list()` filter by owner
- **TTL** — `expiresAt` unix timestamp; expired entries excluded by default
- **Metadata filtering** — arbitrary JSONB metadata with post-retrieval filtering

```ts
const store = new PgVectorStore({ databaseUrl: process.env.DATABASE_URL });
await store.save({ id, text, embedding, metadata: { source: "slack" }, createdAt, userId });

const results = await store.search(queryEmbedding, 10, { userId: "user-abc" });
```

### Execution kernel

`@nexus/runtime` wraps every operation with:

- **Circuit breaker** — open/half-open/closed FSM with configurable thresholds and reset timers
- **Crash recovery** — snapshot + WAL-style recovery store, auto-resume on restart
- **Queue backends** — memory (dev), file (test), Redis/BullMQ (production)
- **OTel tracing** — W3C traceparent propagation through the full call stack

### Plugin SDK

Any team can add a new data source by implementing `@nexus/plugin-sdk`'s `defineAdapter()`. Adapters declare capabilities, handle authentication, and emit typed events — no changes to core required. See [`docs/plugin-author-guide.md`](docs/plugin-author-guide.md).

---

## Core packages

| Package | Description |
|---------|-------------|
| `@nexus/agent-runtime` | Multi-step LLM tool loop, `spawn_agents` parallel child agents |
| `@nexus/council` | Multi-model deliberation: `Promise.allSettled` fanout, synthesis, guardrails |
| `@nexus/llm-drivers` | 15 provider drivers with native SSE/NDJSON `ReadableStream` streaming |
| `@nexus/llm-router` | Dynamic routing by cost, latency, and capability |
| `@nexus/mcp-app` | MCP server framework: tools, resources, prompts, progress notifications |
| `@nexus/mcp-client` | MCP consumer: connect to external tool registries over JSON-RPC 2.0 |
| `@nexus/code-repl` | Jupyter-style REPL with Docker sandboxing (Python/R/Julia) |
| `@nexus/memory` | pgvector store: IVFFlat ANN, TTL, multi-tenant ACL |
| `@nexus/memory-tools` | High-level `remember()` / `recall()` / `forget()` API over memory |
| `@nexus/runtime` | Circuit breaker, crash recovery, OTel tracing, queue backends |
| `@nexus/pipeline-signal` | ingest → classify → Signal worker (7 built-in classifier rules) |
| `@nexus/domain-feeds` | 11 global intelligence feed adapters (BullMQ-polled) |
| `@nexus/stealth-browser` | Playwright stealth driver (PatchrightDriver) with Redis Streams eventing |
| `@nexus/prediction-market` | Polymarket CLOB backend + OAuth 2.0 connector flow |
| `@nexus/auth` | API key verification, HS256 JWT, Fastify preHandler hook |
| `@nexus/db` | Drizzle ORM: 7 schemas, typed migrations, query helpers |
| `@nexus/telemetry` | OTel bootstrap, HMAC-chained audit log, Prometheus metrics |
| `@nexus/plugin-sdk` | `defineAdapter()`, capability types, testing harness |
| `@nexus/contracts` | OpenAPI 3.1 + AsyncAPI 3.0 machine-readable API specs |
| `@nexus/shared` | Shared types, `Result<T,E>`, Zod utilities |
| `@nexus/context-pruner` | Token-budget-aware context pruning in the API gateway |
| `@nexus/voice` | TTS/STT pipeline |
| `@nexus/ragtime` | RAG: chunk → embed → retrieve → rerank |
| `@nexus/knowledge-graph` | Entity + relation graph over agent memory |

> Full package list: 140+ `@nexus/*` packages across agent, MCP, memory, ingestion, adapters, infra, and AI tooling layers.

---

## Scripts

```bash
pnpm build          # Build all packages and apps (turbo cached)
pnpm dev            # Dev mode — watch all packages
pnpm test           # Run all 5914+ test suites
pnpm typecheck      # TypeScript typecheck across monorepo
pnpm lint           # ESLint across all packages
pnpm generate       # Re-generate types from OpenAPI/AsyncAPI specs
pnpm --filter @nexus/db migrate     # Run DB migrations
pnpm --filter @nexus/db generate    # Re-generate Drizzle schema from DB
```

---

## Deployment

### Docker Compose (staging / single-node)

```bash
# Build and start all services
docker compose -f docker-compose.yml up --build

# Services: postgres:5432, redis:6379, ingest:8000, api:3000
# Docker daemon also required for /api/v1/code-repl sandbox
```

### Kubernetes (Helm)

```bash
# Add secrets (or use Sealed Secrets / External Secrets Operator)
kubectl create secret generic nexus-secrets \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=REDIS_URL='redis://...' \
  --from-literal=NEXUS_API_KEY='...' \
  --from-literal=NEXUS_AUDIT_KEY='...' \
  --from-literal=GROQ_API_KEY='...' \
  --from-literal=NEXUS_INGEST_API_KEY='...'

# Install the chart
helm install nexus ./infra/helm/nexus \
  --set global.image.registry=ghcr.io/yash-awasthi \
  --set api.image.tag=latest \
  --set worker.image.tag=latest \
  --set ingest.image.tag=latest

# Enable ingress (nginx + cert-manager)
helm upgrade nexus ./infra/helm/nexus \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=nexus.example.com
```

### Cloud infrastructure (Terraform)

See [`infra/terraform/`](infra/terraform/) for GKE and EKS provisioning modules.

---

## Environment variables

Key variables (see `.env.example` for the complete reference):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (with pgvector extension) |
| `REDIS_URL` | ✅ | Redis connection string for BullMQ |
| `NEXUS_API_KEY` | ✅ | Master API key for gateway authentication |
| `NEXUS_AUDIT_KEY` | ✅ | HMAC key for audit log chaining |
| `GROQ_API_KEY` | ✅ | Groq API key (primary LLM + embeddings) |
| `OPENAI_API_KEY` | optional | OpenAI provider (council + llm-drivers) |
| `OPENWEATHER_API_KEY` | optional | Weather feed polling |
| `NEWS_API_KEY` | optional | News feed polling |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional | Jaeger/Tempo trace exporter |
| `COUNCIL_MIN_PRIORITY` | optional | Minimum signal priority to trigger council (default: `high`) |

---

## Observability

- **Traces** — OpenTelemetry (OTLP). Set `OTEL_EXPORTER_OTLP_ENDPOINT` to forward to Jaeger/Tempo.
- **Metrics** — Prometheus scrape endpoint at `/metrics`. Grafana dashboards in `infra/grafana/`.
- **Logs** — Structured JSON via Pino. `LOG_LEVEL` and `LOG_FORMAT` control verbosity.
- **Audit log** — HMAC-SHA256 chained entries in `audit_log` table. Tampering produces a broken chain — detectable on every read.
- **SLOs** — Targets defined in [`docs/slos.md`](docs/slos.md). Tracked by `@nexus/telemetry`.

---

## Testing

```bash
pnpm test                            # All suites (5914 tests, 3 intentional skips)
pnpm --filter @nexus/memory test     # Single package
pnpm --filter apps/api test          # Single app
pnpm typecheck                       # Zero type errors across all packages

# Load testing (requires running stack)
k6 run infra/k6/smoke.js            # Smoke test
k6 run infra/k6/soak.js             # 5-minute soak at 200 VU

# Chaos testing
bash infra/chaos/pod-kill.sh        # Kill random pod, observe recovery
```

Coverage floor: **80%** (enforced in CI — see ADR-0017).

Key test design decisions:
- All packages use **injectable dependencies** — no live DB/Redis/Docker required to run the suite
- `PgVectorStore` uses a mocked Neon SQL driver; `DockerReplExecutor` uses `MockReplExecutor` in tests
- `MockLlmStream` / `MockTransport` provide deterministic LLM output in agent/council/driver tests
- Schema bootstrap tested with exact mock call counts to catch accidental query regressions

---

## Architecture decisions

18 locked ADRs live in [`docs/adr/`](docs/adr/). Notable ones:

| ADR | Decision |
|-----|----------|
| [ADR-0002](docs/adr/0002-postgres-sole-state.md) | PostgreSQL is the sole authoritative state store |
| [ADR-0006](docs/adr/0006-apache-2-license.md) | Apache 2.0 license (patent grant) |
| [ADR-0008](docs/adr/0008-plugin-sdk-first-class.md) | Plugin SDK is a first-class citizen |
| [ADR-0009](docs/adr/0009-versioned-api.md) | API versioning from day one (`/v1/`) |
| [ADR-0010](docs/adr/0010-hmac-chained-audit-log.md) | HMAC-chained audit log for tamper evidence |
| [ADR-0017](docs/adr/0017-coverage-floor-80.md) | 80% coverage floor enforced in CI |

Additional architectural decisions recorded in git history:
- `Promise.allSettled` as the standard pattern for all concurrent fanouts (council voting, `spawn_agents`) to guarantee error isolation
- `DockerReplExecutor` uses hard fail-secure constraints (SIGKILL, absolute caps, network isolation) rather than soft limits or graceful degradation
- Domain feed polling via BullMQ repeatable jobs (not `setInterval`) to prevent multi-pod duplication
- `user_id` threading through MCP client, auth middleware, and memory store for multi-tenant ACL
- IVFFlat ANN index on `memory_entries.embedding` with `lists=100` tuned for 1M rows; wrapped in `try/catch` so pgvector < 0.4 is non-fatal

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide: local setup, commit conventions, changeset workflow, DCO sign-off, and ADR process.

Key rules:

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
- Every PR needs a [changeset](https://github.com/changesets/changesets) for publishable packages
- New features need tests; coverage must not drop below 80%
- Architectural changes require a new ADR in `docs/adr/`
- All dependencies must be injectable — no `new SomeExternalService()` in constructors without a config escape hatch

---

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy and [`docs/security/`](docs/security/) for the threat model.

To report a vulnerability: **do not open a public issue**. Use GitHub's private security advisory feature or email the address in SECURITY.md.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright © 2024–2026 Yash Awasthi and contributors.

> NEXUS includes code adapted from [workspace](https://github.com/Yash-Awasthi/workspace), [Judica](https://github.com/Yash-Awasthi/Judica), and [Ghoststack](https://github.com/Yash-Awasthi/Ghoststack), also Apache-2.0.
