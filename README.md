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
  <a href="https://github.com/Yash-Awasthi/Nexus/actions"><img src="https://img.shields.io/github/actions/workflow/status/Yash-Awasthi/Nexus/ci.yml?branch=main&label=CI&logo=github" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache 2.0"></a>
  <a href="https://github.com/Yash-Awasthi/Nexus/releases"><img src="https://img.shields.io/github/v/release/Yash-Awasthi/Nexus?include_prereleases" alt="Release"></a>
  <a href="https://nexus.dev/docs/intro"><img src="https://img.shields.io/badge/docs-nexus.dev-8b5cf6" alt="Docs"></a>
</p>

---

## What is NEXUS?

NEXUS is a **multi-agent orchestration engine** built for teams that need reliable, auditable, observable AI pipelines. It solves the hard problems:

- **Signal ingestion** — adapters collect raw events from GitHub, Gmail, Slack, Linear, and any custom source
- **Council deliberation** — multiple AI models vote on a query; synthesis and guardrails prevent rogue outputs
- **Task execution** — workers pull from BullMQ queues with circuit-breaker protection and crash recovery
- **Long-term memory** — vector search over agent memory with TTL, metadata filtering, and swap-in pgvector support
- **Full observability** — OpenTelemetry traces, structured JSON logs, SLO tracking, HMAC-chained audit log
- **Plugin system** — first-class adapter SDK so any team can extend ingestion without touching core

It absorbs and supersedes [workspace](https://github.com/Yash-Awasthi/workspace), [Judica](https://github.com/Yash-Awasthi/Judica), [Ghoststack](https://github.com/Yash-Awasthi/Ghoststack), and [fin-scrape](https://github.com/Yash-Awasthi/fin-scrape).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         NEXUS monorepo                          │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│  │  services/   │   │   apps/api   │   │     apps/worker      │ │
│  │   ingest     │──▶│  (Fastify)   │──▶│  (BullMQ consumers)  │ │
│  │  (Python)    │   │  REST + SSE  │   │  signal + task queues│ │
│  └──────────────┘   └──────┬───────┘   └──────────────────────┘ │
│         │                  │                                     │
│  adapters collect          │ REST                                │
│  raw events into           ▼                                     │
│  ingested_events    ┌──────────────┐   ┌──────────────────────┐ │
│         │           │  apps/web    │   │    apps/cli          │ │
│         │           │  (React SPA) │   │  (commander.js)      │ │
│         ▼           └──────────────┘   └──────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                     packages/                           │    │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐  │    │
│  │  │ @nexus/  │ │ @nexus/  │ │  @nexus/  │ │ @nexus/  │  │    │
│  │  │ runtime  │ │ council  │ │ pipeline- │ │  memory  │  │    │
│  │  │          │ │          │ │  signal   │ │          │  │    │
│  │  └──────────┘ └──────────┘ └───────────┘ └──────────┘  │    │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐  │    │
│  │  │ @nexus/  │ │ @nexus/  │ │  @nexus/  │ │ @nexus/  │  │    │
│  │  │   auth   │ │    db    │ │ telemetry │ │ plugin-  │  │    │
│  │  │          │ │ (Drizzle)│ │  (OTel)   │ │   sdk    │  │    │
│  │  └──────────┘ └──────────┘ └───────────┘ └──────────┘  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                 │
│  PostgreSQL (pgvector) · Redis (BullMQ) · Prometheus · Grafana  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Repository layout

```
nexus/
├── apps/
│   ├── api/            Fastify HTTP/WebSocket gateway — REST + SSE
│   ├── cli/            Developer CLI (commander.js)
│   ├── docs-site/      Docusaurus documentation site
│   ├── web/            React SPA dashboard
│   └── worker/         BullMQ task and signal queue workers
├── packages/
│   ├── auth/           Zero-dep auth: API key + HS256 JWT, Fastify hook
│   ├── contracts/      OpenAPI 3.1 + AsyncAPI 3.0 machine-readable specs
│   ├── council/        Multi-model deliberation engine (ex-Judica)
│   ├── db/             Drizzle ORM schemas + migrations (7 tables)
│   ├── memory/         Vector-search agent memory (FixedEmbedder → pgvector)
│   ├── pipeline-signal/ ingest → classify → Signal worker
│   ├── plugin-sdk/     defineAdapter, capability types, testing harness
│   ├── runtime/        Execution kernel: queues, circuit breaker, OTel tracing
│   ├── shared/         Shared types and utilities
│   └── telemetry/      OpenTelemetry bootstrap + HMAC audit log
├── services/
│   └── ingest/         Python ingestion service (adapters → DB → Redis)
├── infra/
│   ├── helm/nexus/     Production Helm chart (6 templates + values)
│   ├── terraform/      Cloud infra (GKE/EKS provisioning)
│   └── k6/             Load test scripts (200 VU, 5 min soak)
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

To run the full stack including the ingest service:

```bash
docker compose up -d        # postgres + redis + ingest + api
pnpm --filter apps/web dev  # web SPA only
```

---

## Core concepts

### Signal pipeline

Raw events enter via **adapters** (GitHub webhooks, Gmail polling, Slack events, etc.) through `services/ingest`. Each event is written to `ingested_events`, then `@nexus/pipeline-signal` classifies it into a typed `Signal` row with priority (`critical | high | medium | low`) and routes it to the council queue.

### Council deliberation

`@nexus/council` runs multi-model voting: a question is sent to N configured providers (Groq, OpenAI, etc.), each returns a structured response, and the synthesis engine combines them using configurable voting modes (`unanimous | majority | weighted`). Guardrails enforce output constraints.

### Execution kernel

`@nexus/runtime` wraps every operation with:
- **Circuit breaker** — open/half-open/closed FSM with configurable thresholds
- **Crash recovery** — snapshot + WAL-style recovery store, auto-resume on restart
- **Queue backends** — memory (dev), file (test), Redis (production)
- **OTel tracing** — W3C traceparent propagation through the full call stack

### Plugin SDK

Any team can add a new data source by implementing `@nexus/plugin-sdk`'s `defineAdapter()`. Adapters declare capabilities, handle authentication, and emit typed events — no changes to core required. See [`docs/plugin-author-guide.md`](docs/plugin-author-guide.md).

---

## Packages

| Package | Version | Description |
|---|---|---|
| `@nexus/runtime` | 0.1.0 | Execution kernel: queues, circuit breaker, crash recovery, OTel |
| `@nexus/auth` | 0.1.0 | API key verification, HS256 JWT, Fastify preHandler hook |
| `@nexus/memory` | 0.1.0 | Agent memory: vector search, TTL, metadata filtering |
| `@nexus/pipeline-signal` | 0.1.0 | Ingest → classify → Signal worker with 7 built-in classifier rules |
| `@nexus/council` | 0.1.0 | Multi-model deliberation: voting, synthesis, guardrails |
| `@nexus/db` | 0.1.0 | Drizzle ORM: 7 schemas, migrations, typed query helpers |
| `@nexus/telemetry` | 0.1.0 | OTel bootstrap, HMAC-chained audit log, Prometheus metrics |
| `@nexus/plugin-sdk` | 0.1.0 | defineAdapter, capability types, testing harness |
| `@nexus/contracts` | 0.1.0 | OpenAPI 3.1 + AsyncAPI 3.0 machine-readable API specs |
| `@nexus/shared` | 0.1.0 | Shared types, result type, Zod utilities |

---

## Scripts

```bash
pnpm build          # Build all packages and apps (turbo cached)
pnpm dev            # Dev mode — watch all packages
pnpm test           # Run all test suites
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
```

### Kubernetes (Helm)

```bash
# Add secrets (or use Sealed Secrets / External Secrets Operator)
kubectl create secret generic nexus-secrets \
  --from-literal=DATABASE_URL='postgresql://...' \
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

## Observability

- **Traces** — OpenTelemetry (OTLP). Set `OTEL_EXPORTER_OTLP_ENDPOINT` to forward to Jaeger/Tempo.
- **Metrics** — Prometheus scrape endpoint at `/metrics`. Grafana dashboards in `infra/grafana/`.
- **Logs** — Structured JSON via Pino. `LOG_LEVEL` and `LOG_FORMAT` control verbosity.
- **Audit log** — HMAC-SHA256 chained entries in `audit_log` table. Tampering produces a broken chain.
- **SLOs** — Targets defined in [`docs/slos.md`](docs/slos.md). Tracked by `@nexus/telemetry`.

---

## Testing

```bash
pnpm test                        # All suites
pnpm --filter @nexus/auth test   # Single package
pnpm --filter apps/api test      # Single app

# Load testing (requires running stack)
k6 run infra/k6/smoke.js         # Smoke test
k6 run infra/k6/soak.js          # 5-minute soak at 200 VU

# Chaos testing
bash infra/chaos/pod-kill.sh     # Kill random pod, observe recovery
```

Coverage floor: **80%** (enforced in CI — see ADR-0017).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide: local setup, commit conventions, changeset workflow, DCO sign-off, and ADR process.

Key rules:
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
- Every PR needs a [changeset](https://github.com/changesets/changesets) for publishable packages
- New features need tests; coverage must not drop below 80%
- Architectural changes require a new ADR in `docs/adr/`

---

## Architecture decisions

18 locked ADRs live in [`docs/adr/`](docs/adr/). Notable ones:

| ADR | Decision |
|---|---|
| [ADR-0002](docs/adr/0002-postgres-sole-state.md) | PostgreSQL is the sole authoritative state store |
| [ADR-0006](docs/adr/0006-apache-2-license.md) | Apache 2.0 license (patent grant) |
| [ADR-0008](docs/adr/0008-plugin-sdk-first-class.md) | Plugin SDK is a first-class citizen |
| [ADR-0009](docs/adr/0009-versioned-api.md) | API versioning from day one (`/v1/`) |
| [ADR-0010](docs/adr/0010-hmac-chained-audit-log.md) | HMAC-chained audit log for tamper evidence |
| [ADR-0017](docs/adr/0017-coverage-floor-80.md) | 80% coverage floor enforced in CI |

---

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy and [`docs/security/`](docs/security/) for the threat model.

To report a vulnerability: **do not open a public issue**. Use GitHub's private security advisory feature or email the address in SECURITY.md.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright © 2024–2026 Yash Awasthi and contributors.

> NEXUS includes code adapted from [workspace](https://github.com/Yash-Awasthi/workspace), [Judica](https://github.com/Yash-Awasthi/Judica), and [Ghoststack](https://github.com/Yash-Awasthi/Ghoststack), also Apache-2.0.
