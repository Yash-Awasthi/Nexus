---
id: intro
title: Overview
sidebar_position: 1
slug: /
---

# NEXUS — Autonomous Orchestration Platform

NEXUS is an open-source autonomous orchestration platform that integrates four production codebases into one coherent system:

- **Workspace** — agent wrappers and integration scaffolding
- **Judica** — council deliberation and API platform
- **Ghoststack** — orchestration kernel with governance
- **fin-scrape** — 13 financial data scrapers

The result is a single system that can **sense** external events, **think** through them with a multi-model council, **decide** via a governance engine, and **act** through 15 first-party adapters — all with a complete audit trail.

## Why NEXUS?

Most AI agent frameworks bolt on governance and observability as afterthoughts. NEXUS treats them as first-class concerns from day one:

- Every action is audit-logged with HMAC-chained integrity
- Every LLM call goes through budget enforcement
- Every dangerous operation requires human-in-the-loop approval
- Every service has SLOs, Prometheus metrics, and OTel traces

## Core concepts

| Concept | Description |
|---------|-------------|
| **Signal** | A typed, enriched event derived from raw ingested data |
| **Verdict** | The council's decision on a signal (approve / reject / defer) |
| **Task** | A unit of work routed to an adapter |
| **Adapter** | A plugin that executes a specific task type |
| **Approval** | A human gate on a task that governance flagged as dangerous |
| **Audit log** | An append-only HMAC-chained record of every decision |

## Architecture summary

```
[External sources]
    ↓  scrape / webhook
[nexus-ingest]  ──→  ingested_events (DB)
    ↓  classify
[pipeline-signal]  ──→  signals (DB)
    ↓  deliberate
[@nexus/council]  ──→  verdicts (DB)
    ↓  govern
[@nexus/governance]  ──→  approval_requests (DB) → HITL
    ↓  execute
[@nexus/runtime + adapters]  ──→  runtime_tasks (DB) → audit_log (DB)
```

See [Architecture](./architecture) for the full diagram.

## Getting started

Follow the [Quick Start](./quick-start) guide to have the full stack running in < 5 minutes.
