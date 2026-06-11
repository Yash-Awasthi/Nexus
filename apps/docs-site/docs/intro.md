---
id: intro
title: Overview
sidebar_position: 1
slug: /
---

# NEXUS — Autonomous Orchestration Platform

NEXUS is an open-source, production-grade autonomous orchestration platform. It consolidates four prior codebases into one coherent system with full contracts, schemas, tests, and operational tooling:

- **Workspace** — agent wrappers and integration scaffolding
- **Judica** (`@nexus/council`) — multi-model deliberation engine
- **Ghoststack** (`@nexus/runtime`) — orchestration kernel with circuit breaker, crash recovery, and OTel tracing
- **fin-scrape** — financial data ingestion adapters

The result is a single system that can **sense** external events, **think** through them with a multi-model council, **decide** via a governance engine, and **act** through first-party adapters — all with a complete, tamper-evident audit trail.

## Why NEXUS?

Most AI agent frameworks bolt on governance and observability as afterthoughts. NEXUS treats them as first-class concerns from day one:

- Every action is audit-logged with HMAC-SHA256 chained integrity
- Every LLM call goes through budget enforcement
- Every dangerous operation requires human-in-the-loop approval
- Every service has SLOs, Prometheus metrics, and OTel traces

## What ships today

| Package                  | Status    | Description                                   |
| ------------------------ | --------- | --------------------------------------------- |
| `@nexus/runtime`         | ✅ v0.1.0 | Queues, circuit breaker, crash recovery, OTel |
| `@nexus/auth`            | ✅ v0.1.0 | API key + HS256 JWT, Fastify hook             |
| `@nexus/memory`          | ✅ v0.1.0 | Vector-search agent memory                    |
| `@nexus/pipeline-signal` | ✅ v0.1.0 | Ingest → classify → Signal worker             |
| `@nexus/council`         | ✅ v0.1.0 | Multi-model deliberation engine               |
| `@nexus/db`              | ✅ v0.1.0 | Drizzle ORM, 7 schemas, migrations            |
| `@nexus/telemetry`       | ✅ v0.1.0 | Health aggregation, SLOs, Prometheus          |
| `@nexus/governance`      | ✅ v0.1.0 | Constraints, policies, guardrails, HITL       |
| `@nexus/plugin-sdk`      | ✅ v0.1.0 | defineAdapter, capability types, test harness |
| `apps/api`               | ✅        | Fastify REST gateway — 18 routes              |
| `apps/worker`            | ✅        | BullMQ signal + task consumers                |
| `apps/web`               | ✅        | React dashboard with real API integration     |
| `apps/cli`               | ✅        | Developer CLI                                 |
| `services/ingest`        | ✅        | Python FastAPI ingestion service              |

## Core concepts

| Concept       | Description                                                         |
| ------------- | ------------------------------------------------------------------- |
| **Signal**    | A typed, prioritised event derived from raw ingested data           |
| **Verdict**   | The council's decision on a signal (`approve` / `reject` / `defer`) |
| **Task**      | A unit of work routed to an adapter for execution                   |
| **Adapter**   | A plugin that executes a specific task type                         |
| **Approval**  | A human gate on a task that governance flagged as requiring review  |
| **Audit log** | Append-only HMAC-SHA256 chained record of every decision            |

## Architecture summary

```
[External sources]
    ↓  scrape / webhook
[services/ingest]  ──→  ingested_events (DB)
    ↓  classify
[@nexus/pipeline-signal]  ──→  signals (DB)
    ↓  deliberate
[@nexus/council]  ──→  verdicts (DB)
    ↓  govern
[@nexus/governance]  ──→  approval_requests (DB) → HITL
    ↓  execute
[@nexus/runtime + adapters]  ──→  runtime_tasks (DB) → audit_log (DB)
```

See [Architecture](./architecture) for the full diagram and data-flow walkthrough.

## Getting started

Follow the [Quick Start](./quick-start) guide to have the full stack running in under 5 minutes.
