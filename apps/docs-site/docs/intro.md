---
id: intro
title: Overview
sidebar_position: 1
slug: /
---

# NEXUS — Autonomous Orchestration Platform

NEXUS is an open-source, production-grade multi-agent orchestration platform. **150 `@nexus/*` packages** in a Turborepo monorepo (TypeScript 94.9%). It consolidates Workspace, Judica, Ghoststack, and fin-scrape into one coherent system.

The result is a single system that can **sense** external events, **think** through them with a multi-model council, **decide** via a governance engine, and **act** through first-party adapters — all with a complete, tamper-evident audit trail.

## Why NEXUS?

Most AI agent frameworks bolt on governance and observability as afterthoughts. NEXUS treats them as first-class concerns from day one:

- Every action is audit-logged with HMAC-SHA256 chained integrity
- Every LLM call goes through budget enforcement
- Every dangerous operation requires human-in-the-loop approval
- Every service has SLOs, Prometheus metrics, and OTel traces

## What ships today

### Applications

| App               | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `apps/api`        | Fastify REST/SSE gateway — 47 routes                              |
| `apps/worker`     | BullMQ high/medium/low queues + signal workers + repeatable jobs  |
| `apps/web`        | React dashboard — 17 pages, real API integration                  |
| `apps/spectre`    | SPECTRE hacker chat UI — 4 modes, 4 themes (see [SPECTRE](./spectre)) |
| `apps/cli`        | Developer CLI (commander.js)                                      |
| `services/ingest` | Python FastAPI ingestion service (asyncpg, Redis pub, OTel)       |

### Key packages

| Package                  | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `@nexus/client`          | Typed isomorphic SDK — chat, council, memory, agents, research     |
| `@nexus/agent-runtime`   | Multi-step LLM tool loop, spawn_agents, swarm layer                |
| `@nexus/council`         | Multi-model deliberation: allSettled fanout, voting, synthesis     |
| `@nexus/llm-drivers`     | 15 provider drivers with native SSE/NDJSON streaming               |
| `@nexus/ultraplinian`    | Race N models in parallel waves; composite scorer; 5 tiers         |
| `@nexus/memory`          | pgvector store, MemoryGraph BFS, TTL, multi-tenant ACL             |
| `@nexus/ragtime`         | RAG: chunk → embed → hybrid retrieve → rerank                      |
| `@nexus/parseltongue`    | Input perturbation engine (6 techniques × 3 intensities)           |
| `@nexus/autotune`        | EMA adaptive sampling parameter tuning                             |
| `@nexus/stm`             | Semantic transformation: hedge reducer, directness optimizer       |
| `@nexus/supervisor`      | Multi-agent DAG scheduler (OmaTask, dependency-first, BFS)         |
| `@nexus/gateway`         | IProvider failover, model alias routing, Singleflight coalescer    |
| `@nexus/adapters`        | Barrel re-exporting all 25 `@nexus/adapter-*` sub-packages         |
| `@nexus/plugin-sdk`      | defineAdapter(), capability types, test harness                    |
| `@nexus/db`              | Drizzle ORM — 11 schemas (verdicts, memory, signals, billing…)     |
| `@nexus/telemetry`       | OTel bootstrap, SLO tracker, HMAC-chained audit log, Prometheus    |
| `@nexus/runtime`         | Circuit breaker, crash recovery, queue backends, OTel tracing      |

> 150 `@nexus/*` packages total. See [README](https://github.com/Yash-Awasthi/Nexus#core-packages) for the full table.

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
