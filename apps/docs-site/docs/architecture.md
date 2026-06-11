---
id: architecture
title: Architecture
sidebar_position: 3
---

# Architecture

## Sense → Think → Decide → Act

NEXUS is organised around four layers that mirror the cognitive loop of an autonomous agent:

```
┌─────────────────────────────────────────────────────────────────┐
│  SENSE                                                           │
│  nexus-ingest (Python FastAPI) scrapes 13 financial sources,    │
│  receives webhooks from 15 adapters → ingested_events (DB)      │
└─────────────────────┬───────────────────────────────────────────┘
                      ↓  @nexus/pipeline-signal (classifier)
┌─────────────────────▼───────────────────────────────────────────┐
│  THINK                                                           │
│  @nexus/council: 14 archetype LLM personas deliberate on each   │
│  signal. Voting, consensus, cost tracking → verdicts (DB)       │
└─────────────────────┬───────────────────────────────────────────┘
                      ↓  @nexus/governance (constraints + policies)
┌─────────────────────▼───────────────────────────────────────────┐
│  DECIDE                                                          │
│  GovernanceEngine: ResourceScopeConstraint, CostBudgetConstraint,│
│  DangerousOperationPolicy → approval_requests → HITL gate        │
└─────────────────────┬───────────────────────────────────────────┘
                      ↓  BullMQ (nexus-high/medium/low queues)
┌─────────────────────▼───────────────────────────────────────────┐
│  ACT                                                             │
│  @nexus/runtime + 15 adapters execute typed tasks.              │
│  Every action writes to audit_log (HMAC chain).                 │
└─────────────────────────────────────────────────────────────────┘
```

## Monorepo layout

```
Nexus/
├── apps/
│   ├── api/          @nexus/api        Fastify REST gateway
│   ├── worker/       @nexus/worker     BullMQ consumers
│   ├── web/          @nexus/web        React Router 6 dashboard
│   ├── cli/          @nexus/cli        npx nexus CLI
│   └── docs-site/    @nexus/docs       This site (Docusaurus)
├── packages/
│   ├── contracts/    @nexus/contracts  Shared TypeScript types
│   ├── db/           @nexus/db         Drizzle ORM + migrations
│   ├── plugin-sdk/   @nexus/plugin-sdk Adapter interfaces + registry
│   ├── council/      @nexus/council    DeliberationEngine + archetypes
│   ├── governance/   @nexus/governance GovernanceEngine + audit log
│   ├── runtime/      @nexus/runtime    EventBus, task executor, wiring
│   ├── auth/         @nexus/auth       JWT, RBAC, workspace scoping
│   ├── memory/       @nexus/memory     Long-term agent memory (vector)
│   ├── telemetry/    @nexus/telemetry  OTel, SLOs, perf benchmarks
│   ├── pipeline-signal/ @nexus/pipeline-signal Event→Signal classifier
│   ├── shared/       @nexus/shared     Models, errors, utilities
│   └── adapters/     15 first-party adapters
└── services/
    └── ingest/       nexus-ingest      Python scraping service
```

## Data flow (one financial signal)

1. `nexus-ingest` scrapes Bloomberg/Reuters/EDGAR (via fin-scrape)
2. Article → `IngestedEvent` written to Postgres
3. BullMQ job published to `nexus-medium` queue
4. `nexus-worker` dequeues → `pipeline-signal` classifies → `Signal` row created
5. Council adapter picks up `Signal`, creates `CouncilRequest`
6. `DeliberationEngine` fans out to 14 archetypes (Groq LLM calls, concurrent)
7. `Verdict` (approve/reject/defer) written to Postgres
8. `GovernanceEngine` evaluates verdict actions — may create `ApprovalRequest`
9. If approved (auto or HITL): task enqueued to `nexus-high`
10. Worker executes adapter task → audit log entry written

## Technology stack

| Layer | Technology | Why |
|-------|-----------|-----|
| API gateway | Fastify 4 | Performance, TypeScript-first, plugin ecosystem |
| Queue | BullMQ + Redis 7 | Priority queues, DLQ, job persistence |
| Database | Postgres 16 + Drizzle ORM | Strong types, migrations, JSONB |
| LLM | Groq (llama-3.3-70b) | Fast inference, generous free tier |
| Observability | OTel + Prometheus + Grafana | Standard stack, vendor-neutral |
| Ingest | FastAPI + uvicorn | Python ecosystem for scrapers |
| Auth | JWT + HMAC | Stateless, auditable |

## Key architectural decisions

All 18 ADRs are documented in the [ADR Index](./adrs). Highlights:

- **ADR-0001**: No Floci (Docker MCP bridge removed — complexity without benefit)
- **ADR-0003**: Council deduplication — same proposal within 60s returns cached verdict
- **ADR-0008**: Plugin SDK is first-class — every integration is an IExecutionAdapter
- **ADR-0010**: HMAC-chained audit log — tamper-evident, verifiable
- **ADR-0012**: Reproducible builds — pinned Node 20 LTS, Python 3.11, pnpm 9
