<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Features & Core Concepts

A capability-by-capability reference. For how the pieces fit together see
[ARCHITECTURE.md](ARCHITECTURE.md); for running it see the
[README](../README.md#quick-start).

## What's inside

| Capability               | How it works                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Multi-model council      | Models run in parallel via `Promise.allSettled`; unanimous, majority, or weighted voting. Archetypes are YAML-driven.           |
| LLM drivers              | Adapters for Anthropic, OpenAI, Groq, Gemini, DeepSeek, Mistral, OpenRouter, Ollama, and others, with SSE streaming.            |
| Provider failover        | Error classifier groups failures into retryable categories and falls back across a configured chain.                            |
| Sandboxed code execution | Piston for several languages; a Docker REPL for Python/R/Julia with `--network none`, a memory cap, and a read-only filesystem. |
| Long-term memory         | pgvector with IVFFlat ANN and a BFS-traversable relation graph; hybrid BM25 + RRF retrieval; TTL and per-tenant ACL.            |
| Knowledge graph          | Entity and relation graph with clustering, multi-hop traversal, and several search modes.                                       |
| Document pipeline        | extract → classify → OCR → chunk → embed → index.                                                                               |
| Domain feeds             | Adapters that ingest external sources into typed signals, scheduled as BullMQ repeatable jobs.                                  |
| Orchestration            | `VersionedPlan` + `ChannelIndex`: a lifecycle state machine with immutable plan snapshots and a planning engine.                |
| Cost tracking            | Per-call token accounting exposed as Prometheus metrics, with a configurable price table.                                       |
| Gauntlet                 | Runs models against the same prompt in waves and scores each response.                                                          |
| Red-team engine          | Input perturbation with configurable attack profiles.                                                                           |
| RAG                      | chunk → embed → retrieve → rerank, with sub-query decomposition and hybrid scoring.                                             |
| RLHF + eval              | Scorers, a test runner, an SFT auto-tagger, and a corpus builder.                                                               |
| MCP support              | JSON-RPC 2.0 over HTTP, batch invocation, and OpenAPI-to-MCP generation.                                                        |
| Observability            | OpenTelemetry (OTLP) traces, Prometheus metrics, Grafana dashboards, and HMAC-SHA256-chained audit logs.                        |
| Auth + BYOK              | API key plus HS256 JWT; OAuth connectors; per-user LLM keys encrypted at rest (AES-256-GCM) and resolved server-side.           |

## Core concepts

**Agent runtime** — a multi-step tool loop. Agents plan, call tools, observe results, and
loop until done or a step limit is reached. Swarm mode spawns sub-agents and coordinates
them through `ChannelIndex`.

**Council** — runs models in parallel with `Promise.allSettled`, so one model failing does
not break the vote. Archetypes (Analyst, Devil's Advocate, Synthesist, and so on) are
configured in YAML.

**Runtime (orchestration)** — `PlanningEngine` turns a goal into a `VersionedPlan`,
`GovernanceEngine` applies constraints, and `TaskExecutor` runs each step with retry,
backoff, and a circuit breaker. All in `@nexus/runtime`.

**Memory** — pgvector stores embeddings; `MemoryGraph` builds a relation graph traversed
with a depth-decayed score; retrieval combines BM25 and RRF. Per-tenant ACL applies.

**Context management** — `MicroCompactor` compacts on a turn or token threshold and keeps
the most recent turns; `LlmCompactor` handles compaction under repeated failures.

**Signal pipeline** — ingest → classify → typed `Signal` rows, with a PostgreSQL
`LISTEN/NOTIFY` path for low-latency consumers.

**Observability** — each request carries an OpenTelemetry trace; audit events are
HMAC-SHA256 chained (tamper-evident); metrics are exposed for Prometheus.

**BYOK keys** — users add their own provider keys on the Provider Keys page. They are
AES-256-GCM encrypted in Postgres and decrypted only server-side to make that user's own
LLM calls; they are never returned to the client.

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
    { driver: new GroqDriver(), weight: 1 },
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
