<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Architecture & Repository Layout

How the apps, packages, and infrastructure fit together. For per-feature detail see
[FEATURES.md](FEATURES.md); for the design history see the
[ADRs](adr/).

## System diagram

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
│  │                         packages/ (110)                              │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │  │ agent-runtime  │  │   council    │  │      llm-drivers        │   │   │
│  │  │ multi-step     │  │ multi-model  │  │  15 providers           │   │   │
│  │  │ tool loop +    │  │ voting with  │  │  native SSE/NDJSON      │   │   │
│  │  │ swarm layer    │  │ allSettled   │  │  streaming              │   │   │
│  │  └────────────────┘  └──────────────┘  └────────────────────────┘   │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │  │   mcp-client   │  │  code-repl   │  │        runtime          │   │   │
│  │  │ JSON-RPC 2.0   │  │  Docker REPL │  │  PlanningEngine         │   │   │
│  │  │ HTTP transport │  │  Py/R/Julia  │  │  GovernanceEngine       │   │   │
│  │  │                │  │  sandboxed   │  │  TaskExecutor           │   │   │
│  │  └────────────────┘  └──────────────┘  └────────────────────────┘   │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │  │    memory      │  │  telemetry   │  │      plugin-sdk         │   │   │
│  │  │ pgvector +     │  │ OTel + HMAC  │  │  defineAdapter()        │   │   │
│  │  │ MemoryGraph    │  │ audit log    │  │  + test harness         │   │   │
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

## Repository layout

```
nexus/
├── apps/
│   ├── api/            Fastify HTTP/SSE/WebSocket gateway (61 route modules)
│   ├── cli/            Developer CLI (commander.js)
│   ├── docs-site/      Docusaurus documentation site
│   ├── ingest-py/      Python ingest helpers
│   ├── ui/             React Router v7 SPA dashboard (100+ routes)
│   └── worker/         BullMQ workers — signal, task, and repeatable feed jobs
├── packages/           110 scoped @nexus/* packages
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
│   ├── runtime/                Orchestrator + PlanningEngine (11 blueprints), GovernanceEngine, TaskExecutor, circuit breaker, crash recovery, OTel tracing
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
│   ├── db/                     Drizzle ORM — typed schemas + migrations
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
├── docs/               This directory — guides, ADRs, runbook, SLOs, security
├── docker-compose.yml  Local dev stack (postgres, redis, ingest, api)
└── .env.example        Complete environment variable reference
```

## Toolchain

- **Node** 20.x (`.nvmrc` pins `20.19.0`; engines require `>=20.18.0`)
- **pnpm** 9.x (`packageManager: pnpm@9.14.4`) — always pnpm, never npm/yarn
- **Turbo** orchestrates all cross-package tasks (`dependsOn: ["^build"]`)
- **Postgres** (pgvector) + **Redis** (BullMQ) via Docker Compose for runtime

## Key design decisions

18 ADRs live in [`docs/adr/`](adr/). Notable:

- ADR-001: pnpm workspaces over Nx/Turborepo
- ADR-004: pgvector over a dedicated vector DB
- ADR-007: `Promise.allSettled` for council fanout (no cascade failure)
- ADR-011: HMAC-chained audit log for tamper evidence
- ADR-015: Piston API for sandboxed multi-language code execution
- ADR-018: BullMQ repeatable jobs for domain feed polling
