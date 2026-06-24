<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Features & Core Concepts

A capability-by-capability reference. For how the pieces fit together see
[ARCHITECTURE.md](ARCHITECTURE.md); for running it see the
[README](../README.md#quick-start).

## What's inside

| Capability                   | How it works                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-model council**      | N models run in parallel via `Promise.allSettled`. Unanimous, majority, or weighted voting. 11 AI archetypes (YAML-driven).                                                        |
| **15 LLM providers**         | Anthropic, OpenAI, Groq, Gemini, DeepSeek, Mistral, OpenRouter, Ollama, LMStudio, LlamaCpp, Fireworks, NvidiaNim, Cerebras, and more. Native SSE streaming, no buffering.          |
| **Provider failover**        | `classifyFailoverError()` — 3-category, 30+ pattern classifier. Automatic retry with FallbackChain.                                                                                |
| **Sandboxed code execution** | Piston API for Python, TypeScript, Bash, Go, Rust, Ruby, R. Docker REPL for Python/R/Julia with `--network none`, 256 MB cap, read-only FS.                                        |
| **Long-term memory**         | pgvector + `MemoryGraph` BFS. IVFFlat ANN, BM25+RRF hybrid retrieval, TTL, multi-tenant ACL.                                                                                       |
| **Knowledge graph**          | Entity + relation graph with Leiden clustering, multi-hop BFS, 6 search modes.                                                                                                     |
| **Document pipeline**        | extract → classify → OCR → chunk → embed → index. 7 OCR modes, 11 layout categories.                                                                                               |
| **16 domain feed sources**   | Aviation, climate, conflict, economic, displacement, cyber, health, seismology, wildfire, maritime, market, sanctions, radiation, space, imagery, patents. BullMQ repeatable jobs. |
| **Orchestration**            | `VersionedPlan` + `ChannelIndex` — 13 lifecycle states, immutable plan snapshots, `PlanningEngine` with 11 blueprints.                                                             |
| **Cost tracking**            | Per-call token accounting → Prometheus `/api/v1/metrics`. 18-model price table.                                                                                                    |
| **Gauntlet**                 | Races 47 models in waves of 12, 150 ms stagger, `scoreResponse()` 0–100, 5 speed tiers.                                                                                            |
| **Red-team engine**          | Input perturbation with configurable attack profiles.                                                                                                                              |
| **RAG**                      | Chunk → embed → retrieve → rerank. Sub-query decomposition, Jaccard+cosine hybrid.                                                                                                 |
| **RLHF + eval pipeline**     | Scorers, test runner, SFT auto-tagger, corpus builder.                                                                                                                             |
| **MCP support**              | JSON-RPC 2.0 HTTP transport, batch invocation, OpenAPI-to-MCP auto-generation.                                                                                                     |
| **Observability**            | OpenTelemetry (OTLP), Jaeger, Prometheus, Grafana dashboards pre-provisioned. HMAC-SHA256-chained audit logs.                                                                      |
| **Auth + BYOK**              | API key + HS256 JWT. OAuth connectors for Google, GitHub, Slack. Per-user LLM keys encrypted at rest (AES-256-GCM), resolved server-side.                                          |

## Core concepts

**Agent runtime** — multi-step tool loop. Agents plan, call tools, observe results, and
loop until done or a step limit is reached. Swarm mode spawns sub-agents and coordinates
them via `ChannelIndex`.

**Council** — runs N models in parallel with `Promise.allSettled`. One model failure
doesn't break the vote. Supports 11 AI archetypes (Analyst, Devil's Advocate,
Synthesist, …) configured in YAML.

**Runtime (orchestration)** — `PlanningEngine` breaks a goal into a `VersionedPlan` with
11 blueprint types. `GovernanceEngine` applies constraints. `TaskExecutor` runs each step
with retry, backoff, and circuit breaker. (All in `@nexus/runtime`.)

**Memory** — pgvector stores embeddings. `MemoryGraph` builds a BFS-traversable relation
graph with score × edgeWeight × 0.7^depth decay. Hybrid BM25+RRF retrieval. Per-tenant ACL.

**Context management** — `MicroCompactor` fires at 8 turns OR 80 k tokens, keeps 4 recent
turns. `LlmCompactor` handles consecutive failure blocking with a 0.80 compaction threshold.

**Gauntlet** — races 47 models in waves of 12 with 150 ms stagger. `scoreResponse()`
returns 0–100. Results stream back as each wave completes.

**Signal pipeline** — ingest → classify → typed `Signal` rows. 7 built-in classifier
rules. PostgreSQL `LISTEN/NOTIFY` hot path for low-latency consumers.

**Observability** — every request gets an OTel trace. Audit events are HMAC-SHA256
chained (tamper-evident). Prometheus metrics scraped at `/api/v1/metrics`. Two Grafana
dashboards pre-provisioned.

**BYOK keys** — users add their own provider keys on the Provider Keys page. They are
AES-256-GCM encrypted in Postgres and only ever decrypted server-side to make the user's
own LLM calls; they are never returned to the client.

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
