<!-- SPDX-License-Identifier: Apache-2.0 -->

# Nexus — Architecture & Repository Layout

How the apps, packages, and infrastructure fit together. For per-feature detail see
[FEATURES.md](FEATURES.md); for the design history see the [ADRs](adr/).

## System diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Nexus monorepo                                 │
│                                                                             │
│  ┌──────────────┐   ┌───────────────────┐   ┌──────────────────────────┐    │
│  │  services/   │   │    apps/api       │   │      apps/worker         │    │
│  │   ingest     │──▶│  (Fastify)        │──▶│  BullMQ high/med/low     │    │
│  │  (Python)    │   │  REST + SSE + MCP │   │  signal + task queues    │    │
│  └──────────────┘   └────────┬──────────┘   │  repeatable feed jobs    │    │
│         │                    │              └──────────────────────────┘    │
│  adapters emit               │ REST/SSE                                     │
│  ingested_events             ▼                                              │
│         │           ┌──────────────┐   ┌──────────────────────────────┐     │
│         │           │   apps/ui    │   │    apps/cli, apps/desktop    │     │
│         │           │ (React RR8)  │   │  commander CLI · Electron    │     │
│         │           └──────────────┘   └──────────────────────────────┘     │
│         ▼                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         packages/ (49)                               │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐    │   │
│  │  │   agent-core   │  │   council    │  │          llm           │    │   │
│  │  │ multi-step     │  │ multi-model  │  │  49 provider drivers   │    │   │
│  │  │ tool loop +    │  │ voting with  │  │  native SSE/NDJSON     │    │   │
│  │  │ workflow layer │  │ allSettled   │  │  streaming             │    │   │
│  │  └────────────────┘  └──────────────┘  └────────────────────────┘    │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐    │   │
│  │  │   mcp-client   │  │   sandbox    │  │        search          │    │   │
│  │  │ JSON-RPC 2.0   │  │ Docker image │  │  hybrid BM25 + RRF     │    │   │
│  │  │ HTTP transport │  │ fail-closed  │  │  GraphRAG, rerank      │    │   │
│  │  └────────────────┘  └──────────────┘  └────────────────────────┘    │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐    │   │
│  │  │    memory      │  │  telemetry   │  │      plugin-sdk        │    │   │
│  │  │ pgvector +     │  │ OTel + HMAC  │  │  defineAdapter()       │    │   │
│  │  │ MemoryGraph    │  │ audit log    │  │  + test harness        │    │   │
│  │  └────────────────┘  └──────────────┘  └────────────────────────┘    │   │
│  │                                                                      │   │
│  │  governance · hooks · kv · llm-cache · llm-oauth · llm-tracer ·      │   │
│  │  llm-translate · doc-pipeline · nlp-utils · pipeline-signal ·        │   │
│  │  trigger-engine · stream-recovery · stealth-browser · researcher ·   │   │
│  │  browser-automation · session-sync · pty · exec-policy ·             │   │
│  │  escalation-breaker · tool-registry · mcp-openapi · ...              │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  PostgreSQL (pgvector) · Redis (BullMQ) · Docker (sandbox image)            │
│  Prometheus · Grafana · OpenTelemetry (OTLP) · Jaeger                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Repository layout

```
nexus/
├── apps/
│   ├── api/            Fastify HTTP/SSE/WebSocket gateway (90 route modules)
│   ├── cli/            Developer CLI (commander.js)
│   ├── desktop/        Electron shell
│   ├── extension/      Browser extension around the search widget
│   ├── sandbox-helper/ Loopback runner the browser page calls for local Docker
│   ├── ui/             React Router 8 dashboard (43 routes)
│   └── worker/         BullMQ workers — signal, task, and repeatable drive jobs
├── packages/           49 scoped @nexus/* packages
│   ├── agent-core/             Multi-step tool loop, workflows, planning
│   ├── council/                Multi-model voting (unanimous/majority/weighted)
│   ├── llm/                    49 provider drivers, native SSE streaming
│   ├── gateway/                IProvider, FallbackChain, classifyFailoverError()
│   ├── mcp-client/             JSON-RPC 2.0 MCP consumer
│   ├── mcp-openapi/            OpenAPI → MCP tool auto-generation
│   ├── sandbox/                Untrusted-code runner (Docker image, fail-closed)
│   ├── search/                 Hybrid retrieval, GraphRAG, knowledge graph
│   ├── memory/                 pgvector, MemoryGraph BFS, HNSW ANN
│   ├── doc-pipeline/           extract → classify → OCR → index
│   ├── researcher/             Research agent over search + documents
│   ├── stealth-browser/        PatchrightDriver + Redis Streams
│   ├── browser-automation/     Scripted browser sessions
│   ├── rlhf-pipeline/          RLHF data pipeline
│   ├── telemetry/              OTel, HMAC-chained audit log, Prometheus
│   ├── auth/                   API key + JWT (HS256/RS256), login throttle,
│   │                           session revocation, Fastify preHandler
│   ├── db/                     Drizzle ORM — typed schemas + migrations
│   ├── contracts/              Generated OpenAPI types
│   ├── plugin-sdk/             defineAdapter(), ISocialProvider, test harness
│   └── ...                     billing, bots, kv, pty, sdk, sse, and the rest
├── services/
│   ├── board/          Go service
│   └── ingest/         Python (FastAPI + Celery) — adapter runners → DB
├── infra/
│   ├── docker/         docker-compose.dev/observability
│   ├── grafana/        Pre-provisioned dashboards
│   ├── k6/             Smoke and load test scripts
│   ├── otel/           OTel Collector, Prometheus, datasource configs
│   ├── sandbox/        Untrusted-code image (Node, Python, Go, Rust, Ruby)
│   ├── searxng/        Self-hosted metasearch configuration
│   └── web/            Production web image used by render.yaml
├── docs/               This directory — guides, ADRs, runbook, SLOs, security
├── docker-compose.yml  Local dev stack (postgres, redis, api, optional tools)
└── .env.example        Complete environment variable reference
```

## Toolchain

- **Node** 26 (`.nvmrc` pins `26`; engines require `>=24`)
- **pnpm** 12.x (`packageManager: pnpm@12.21.0`) — always pnpm, never npm/yarn
- **TypeScript** 6.x
- **Turbo** 2.x orchestrates all cross-package tasks (`dependsOn: ["^build"]`)
- **Postgres** (pgvector) + **Redis** (BullMQ) via Docker Compose for runtime

## Key design decisions

12 ADRs live in [`docs/adr/`](adr/). Notable:

- ADR-0002: Postgres as the only state store
- ADR-0004: pgvector over a dedicated vector DB
- ADR-0007: `Promise.allSettled` for council fanout (no cascade failure)
- ADR-0010: HMAC-chained audit log for tamper evidence
- ADR-0015: Piston for multi-language execution outside the Docker sandbox
- ADR-0018: BullMQ repeatable jobs for domain feed polling
