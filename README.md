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
  <img src="https://img.shields.io/badge/packages-148-blue" alt="Packages">
</p>

---

## What is NEXUS?

NEXUS is a **multi-agent orchestration engine** built for teams that need reliable, auditable, observable AI pipelines. It solves the hard problems:

- **Signal ingestion** — adapters collect raw events from GitHub, Gmail, Slack, Linear, and 20+ custom sources
- **Council deliberation** — multiple AI models vote on a query concurrently via `Promise.allSettled`; synthesis and guardrails prevent rogue outputs
- **Agent execution** — `AgentRuntime` drives multi-step tool-calling loops with abort handling, cache control, and parallel child-agent spawning via `spawn_agents`
- **Swarm orchestration** — `VersionedPlan` + `ChannelIndex` coordinate durable multi-agent swarms with 13 lifecycle states and bidirectional pub/sub
- **Provider failover** — `IProvider` interface with `classifyFailoverError()` (3-category, 30+ pattern classifier); automatic retry/mark-unavailable on context/rate/auth errors
- **Context compaction** — `LlmCompactor` + `MicroCompactor` trim token budgets with count/token dual triggers and consecutive-failure circuit breaking
- **Sandboxed code execution** — `DockerReplExecutor` runs Python/R/Julia in Docker with network isolation, memory caps, and CPU throttling
- **Real LLM streaming** — 15 provider drivers (Anthropic, OpenAI, Groq, Gemini, etc.) with native SSE/NDJSON `ReadableStream` generators
- **MCP layer** — both sides: `mcp-app` (server with progress notifications) and `mcp-client` (consumer of external MCP tool registries)
- **Long-term memory** — vector search over agent memory with IVFFlat ANN index, TTL, metadata filtering, multi-tenant ACL, pgvector backend, and `MemoryGraph` BFS cascade retrieval
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
│  │  │ swarm layer  │  │ allSettled   │  │  streaming   │               │   │
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
│  │  │ MemoryGraph  │  │ crash-recov  │  │ + harness    │               │   │
│  │  │ IStream/IState│  │ OTel tracing │  │              │               │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │   │
│  │                                                                      │   │
│  │  + 138 more packages: auth · db · telemetry · pipeline-signal ·     │   │
│  │    domain-feeds · context-pruner · stealth-browser · llm-router ·   │   │
│  │    trigger-engine · stream-recovery · gateway · stm · parseltongue  │   │
│  │    autotune · evals · doc-pipeline · supervisor · and more          │   │
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
├── packages/           148 scoped packages (@nexus/*)
│   ├── Core agents
│   │   ├── agent-runtime/      Multi-step LLM loop, spawn_agents, swarm layer (VersionedPlan, ChannelIndex)
│   │   ├── council/            Multi-model voting engine (Promise.allSettled fanout)
│   │   ├── llm-drivers/        15 provider drivers with native SSE/NDJSON streaming
│   │   ├── llm-router/         Dynamic provider routing by cost/latency/capability
│   │   ├── gateway/            IProvider interface, model alias routing, failover classifier
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
│   │   ├── memory/             pgvector store, MemoryGraph BFS, IStream/IState, TTL, multi-tenant ACL
│   │   ├── memory-tools/       High-level remember/recall/forget API
│   │   ├── stm/                Short-term memory modules (hedge reducer, direction optimizer)
│   │   ├── knowledge-graph/    Entity + relation graph over memory
│   │   └── ragtime/            RAG pipeline: chunk → embed → retrieve → rerank
│   ├── Context management
│   │   ├── context-pruner/     LlmCompactor + MicroCompactor, token-budget pruning
│   │   ├── context-pack/       Context serialization and packing utilities
│   │   └── context-sections/   Structured context section management
│   ├── Remote invocation & streaming
│   │   ├── trigger-engine/     ISdk remote function/trigger registration and invocation
│   │   └── stream-recovery/    WebSocket ChannelWriter/ChannelReader with 64KB binary framing
│   ├── AI tools
│   │   ├── autotune/           EMA adaptive parameter tuning service
│   │   ├── parseltongue/       Red-team input perturbation engine
│   │   ├── thinker/            Chain-of-thought + think-parse utilities
│   │   ├── llm-cache/          Prompt-keyed LLM response cache
│   │   ├── prompt-cache/       Cache-control primitives for prompt optimization
│   │   └── token-budget/       Token budget tracking and enforcement
│   ├── Evaluation & training
│   │   ├── evals/              LLM evaluation framework (scorers, runner, types)
│   │   ├── rlhf-pipeline/      RLHF data pipeline
│   │   ├── sft-tagger/         Supervised fine-tuning auto-tagging
│   │   └── corpus-builder/     Training corpus construction
│   ├── Data ingestion
│   │   ├── pipeline-signal/    ingest → classify → typed Signal rows
│   │   ├── domain-feeds/       16 global intelligence feeds + TET pipeline abstraction
│   │   ├── adaptive-scraper/   Proxy-aware scraper with robots.txt checking
│   │   ├── spider/             Web crawler with depth control
│   │   └── stealth-browser/    Playwright stealth driver (PatchrightDriver)
│   ├── Document processing
│   │   ├── doc-pipeline/       End-to-end document ingestion pipeline
│   │   ├── doc-extractor/      Text and structure extraction
│   │   ├── doc-classifier/     Document classification
│   │   ├── doc-ocr/            OCR integration
│   │   ├── doc-acl/            Document access control
│   │   └── doc-workflow/       Document workflow orchestration
│   ├── Adapters (24)
│   │   └── adapter-{github,gmail,slack,linear,groq,notion,drive,…}/
│   ├── Infrastructure
│   │   ├── auth/               API key + HS256 JWT, Fastify preHandler hook
│   │   ├── db/                 Drizzle ORM: 7 schemas, typed migrations
│   │   ├── telemetry/          OTel bootstrap + HMAC-chained audit log
│   │   ├── supervisor/         Multi-agent supervisor and lifecycle manager
│   │   ├── contracts/          OpenAPI 3.1 + AsyncAPI 3.0 machine-readable specs
│   │   └── shared/             Shared types, Result<T,E>, Zod utilities
│   └── Other tools (selection)
│       ├── prediction-market/  Polymarket + Kalshi + Metaculus CLOB backends
│       ├── voice/              TTS/STT pipeline
│       ├── human-browser/      Human input simulation (stealth browser interaction)
│       ├── image-gen/          Text-to-image generation adapters
│       └── ultraplinian/       Extreme planning mode engine
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

## SDK

External apps (Judica, G0DM0D3, or any Node/browser project) can consume the Nexus API via `@nexus/client` — a typed, isomorphic SDK with no runtime dependencies beyond `fetch`.

```ts
import { NexusClient } from "@nexus/client";

const nexus = new NexusClient({ baseUrl: "http://localhost:3000", apiKey: process.env.NEXUS_API_KEY });

// Single model chat
const res = await nexus.gateway.sendMessage({ model: "nexus/smart", messages: [{ role: "user", content: "Explain monads" }] });
console.log(res.content[0].text);

// Streaming (async generator — works in Node and browser)
for await (const event of nexus.gateway.sendMessageStream({ model: "nexus/fast", messages: [...] })) {
  if (event.type === "content_block_delta") process.stdout.write(event.delta.text);
}

// Council deliberation
const verdict = await nexus.council.deliberate({ proposal: "Should we deploy to prod?", context: "All tests passing" });
console.log(verdict.result, verdict.confidence);

// Memory
await nexus.memory.remember({ content: "User prefers concise answers", category: "preference" });
const hits = await nexus.memory.recall({ query: "user preferences", limit: 5 });
```

Install from the monorepo or pin via GitHub:
```bash
pnpm add @nexus/client          # within the monorepo
# or from GitHub in external projects:
pnpm add github:Yash-Awasthi/Nexus#main --filter @nexus/client
```

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

### Swarm orchestration

`@nexus/agent-runtime` includes a full durable swarm layer for coordinating long-running multi-agent plans:

- **`VersionedPlan`** — wraps a `SwarmPlanDefinition` (ordered `PlanItem[]`) with an `SwarmExecutionState` (per-item status). Immutable `bump()` creates a new versioned snapshot on every state transition.
- **`ChannelIndex`** — bidirectional pub/sub registry. Agents subscribe to swarm channels; the coordinator broadcasts to all subscribers. Indexed by both `swarmChannel` and `session` for O(1) lookups in both directions.
- **`SwarmLifecycleStatus`** — 13-state union: `spawned | ready | running | running_stale | completed | done | failed | stopped | crashed | queued | blocked | pending | todo`.
- **`ResumeTarget`** — discriminated union over supported agent runtimes (`jcode | claude_code | codex | pi | open_code`) with `resumeTargetId()` for canonical identity.

```ts
import { VersionedPlan, ChannelIndex, SwarmLifecycleStatus } from "@nexus/agent-runtime";

const plan = new VersionedPlan(planDefinition, initialExecutionState);
const next = plan.bump({ taskId: "step-1", status: SwarmLifecycleStatus.completed });

const index = new ChannelIndex();
index.subscribe("swarm-42", "session-abc", handler);
index.getSubscribers("swarm-42"); // → [handler]
```

### Council deliberation

`@nexus/council` sends a question to N configured LLM providers simultaneously and synthesizes the responses. The `Promise.allSettled` fanout pattern means a slow or failed provider doesn't block the vote:

```ts
import { CouncilService } from "@nexus/council";

const council = new CouncilService({ providers: ["groq:llama3", "groq:gemma2"] });
const verdict = await council.deliberate("Should we approve this deployment?");
// { verdict: "approve", confidence: 0.87, reasoning: "...", votes: [...] }
```

Voting modes: `unanimous | majority | weighted`. Guardrails enforce output constraints before synthesis.

### Provider failover

`@nexus/gateway` exposes `IProvider` — the standard streaming LLM provider interface — and a three-category failover classifier:

```ts
import { classifyFailoverError, FailoverDecision } from "@nexus/gateway";

classifyFailoverError("context length exceeded")    // → RetryNextProvider
classifyFailoverError("429 Too Many Requests")      // → RetryAndMarkUnavailable
classifyFailoverError("internal server error")      // → None (non-retriable)
```

`IProvider` methods: `complete()`, `completeSplit()` (static + dynamic system for prompt cache), `name()`, `model()`, `setModel()`, `supportsImageInput()`, `availableModels()`. The `completeSplit` pattern splits a system prompt into a cacheable static prefix and a dynamic suffix — avoiding cache invalidation on every turn.

### Context compaction

`@nexus/context-pruner` tracks token budgets and compacts conversation history before context windows overflow:

- **`LlmCompactor`** — calls an `ILlmCaller` to produce a prose summary of conversation history. Tracks consecutive failures; `isBlocked` prevents hammering a failing provider.
- **`MicroCompactor`** — dual-trigger: fires on `COUNT_TRIGGER_THRESHOLD=8` turns *or* `TOKEN_TRIGGER_THRESHOLD=80_000` tokens. Keeps `COUNT_KEEP_RECENT=4` turns untouched.
- **Thresholds** — `COMPACTION_THRESHOLD=0.80` (normal), `CRITICAL_THRESHOLD=0.95` (emergency), `IMAGE_TOKEN_COST=1600` (flat per-image budget).

```ts
import { microCompact, LlmCompactor } from "@nexus/context-pruner";

const compacted = microCompact(messages, tokenCount);
// or full LLM-based compaction:
const compactor = new LlmCompactor({ caller: myLlmCaller });
const result = await compactor.compact(messages);
```

### LLM streaming

`@nexus/llm-drivers` provides 15 concrete provider adapters. Each driver implements provider-specific SSE or NDJSON parsing with native `ReadableStream` generators — no polling, no buffering:

| Provider  | Protocol   | Streaming                       |
| --------- | ---------- | ------------------------------- |
| Anthropic | SSE        | `event: content_block_delta`    |
| OpenAI    | SSE        | `data.choices[0].delta.content` |
| Groq      | SSE        | OpenAI-compatible               |
| Gemini    | NDJSON     | `:streamGenerateContent`        |
| +11 more  | SSE/NDJSON | Provider-specific               |

### MCP layer

NEXUS is both an MCP server and an MCP consumer:

- **`@nexus/mcp-app`** — build MCP tool servers. Handlers receive a `ToolContext` with `reportProgress()` for streaming progress to callers. `McpServer.callTool(name, args, onProgress?)` wires the callback.
- **`@nexus/mcp-client`** — connect to external MCP registries. `McpClient.listTools()` / `callTool()` over JSON-RPC 2.0 HTTP transport with injectable fetch for testing.

### Trigger SDK & channel I/O

`@nexus/trigger-engine` provides an `ISdk` interface for registering and invoking remote functions and triggers:

```ts
import type { ISdk, RemoteFunctionHandler, TriggerHandler } from "@nexus/trigger-engine";

// Register a remote function
sdk.registerFunction("analyze", async (input: AnalyzeInput) => ({ result: "..." }));

// Register a trigger
sdk.registerTrigger(myTriggerTypeRef, config, async (ctx) => { /* handler */ });

// Invoke remotely
const ref = sdk.trigger(myTriggerTypeRef, config);
```

`@nexus/stream-recovery` provides `ChannelWriter` and `ChannelReader` for reliable bidirectional WebSocket channels:

- **`ChannelWriter`** — lazy connect, pending-message queue, 64KB binary framing
- **`ChannelReader`** — multi-callback `onMessage`/`onBinary`, `readAll()` accumulator
- **`extractChannelRefs()`** — recursive extractor that finds all `StreamChannelRef` objects in any JSON payload

### Long-term memory & MemoryGraph

`@nexus/memory` stores agent memories as pgvector rows with cosine similarity search:

- **IVFFlat ANN index** — ~10-20× faster than sequential scan at 100k+ entries
- **Multi-tenant ACL** — `userId` field on every entry; `search()` and `list()` filter by owner
- **TTL** — `expiresAt` unix timestamp; expired entries excluded by default
- **`IStream<TData>`** — named stream store with groups and items; atomic `UpdateOp` operations (set/increment/decrement/append/remove/merge)
- **`IState<TData>`** — scope+key KV store with typed `StateEventType` change events
- **`MemoryGraph`** — graph layer over memories with typed `EdgeKind` (has_tag, in_cluster, relates_to, supersedes, contradicts, derived_from). `cascadeRetrieve()` does BFS with `score × edgeWeight × 0.7^depth` decay and tag fan-out:

```ts
import { MemoryGraph, PgVectorStore } from "@nexus/memory";

const graph = new MemoryGraph();
graph.addMemory({ id: "m1", text: "...", embedding: [...], score: 0.9 });
graph.tagMemory("m1", "reasoning");
graph.linkMemories("m1", "m2", "relates_to");

const results = graph.cascadeRetrieve("m1", { maxDepth: 3, topK: 10 });
```

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

`@nexus/domain-feeds` covers 16 global intelligence domains (aviation, climate, conflict, economic, displacement, cyber, health, imagery, seismology, wildfire, maritime, market, sanctions, radiation, space, patents). Feed polling runs as BullMQ repeatable jobs registered at worker boot — not `setInterval` timers. This means:

- Single execution across any number of pods (BullMQ repeat lock)
- Polling survives pod restarts (job definitions persist in Redis)
- Configurable intervals per domain (weather: 5 min, crypto: 1 min, news: 10 min)

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

| Package                    | Description                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `@nexus/agent-runtime`     | Multi-step LLM tool loop, `spawn_agents`, swarm layer (VersionedPlan, ChannelIndex); AgentDefinition (declarative blueprint: model, toolNames, reasoningOptions, providerOptions, handleSteps generator), AgentSessionState (stepsRemaining, creditsUsed, subagents, contextTokenCount), AgentRunOutput discriminated union, SkillDefinition + SkillsMap, HttpError + isRetryableStatusCode + agentRetryBackoffMs (exponential backoff, base 1s, cap 8s, max 3 retries), AgentPersona descriptor |
| `@nexus/council`           | Multi-model deliberation: `Promise.allSettled` fanout, synthesis, guardrails        |
| `@nexus/llm-drivers`       | 15 provider drivers with native SSE/NDJSON `ReadableStream` streaming               |
| `@nexus/llm-router`        | Dynamic routing by cost, latency, and capability                                    |
| `@nexus/gateway`           | IProvider interface, model alias routing, failover classifier, overnight manifest; FallbackChain (ordered model fallback, first-success), CostCallbackRegistry (fire-and-forget post-call hooks), Singleflight<T> (per-key LRU coalescer) |
| `@nexus/mcp-app`           | MCP server framework: tools, resources, prompts, progress notifications             |
| `@nexus/mcp-client`        | MCP consumer: connect to external tool registries over JSON-RPC 2.0                 |
| `@nexus/code-repl`         | Jupyter-style REPL with Docker sandboxing (Python/R/Julia)                          |
| `@nexus/memory`            | pgvector store, MemoryGraph BFS, IStream/IState, TTL, multi-tenant ACL; BM25Lexicon (Porter stem, prefix expansion, synonym injection, serialize/deserialize), RRF hybrid search (bm25W+vectorW, maxPerGroup session diversity), QueryExpander |
| `@nexus/memory-tools`      | High-level `remember()` / `recall()` / `forget()` API over memory                  |
| `@nexus/stm`               | Style transformation pipeline: HedgeReducer, DirectnessOptimizer, TruncationGuard, STMRegistry, STMPipeline; RollingWindow circular buffer, RollingMetricTracker (per-session drift detection), STMMetrics (hedgeDensity, verbosityRatio) |
| `@nexus/context-pruner`    | LlmCompactor + MicroCompactor, dual-trigger token budget pruning                    |
| `@nexus/trigger-engine`    | ISdk: remote function/trigger registration, invocation, InvocationError             |
| `@nexus/stream-recovery`   | ChannelWriter/ChannelReader WebSocket pair with 64KB binary framing                 |
| `@nexus/runtime`           | Circuit breaker, crash recovery, OTel tracing, queue backends                       |
| `@nexus/pipeline-signal`   | ingest → classify → Signal worker (7 built-in classifier rules)                     |
| `@nexus/domain-feeds`      | 16 global intelligence feed adapters (BullMQ-polled) + TET pipeline abstraction (DomainFetcher<Q,R>), FeedProviderRegistry, standard financial interfaces (OHLCVRecord, EquityQuoteRecord, FinancialNewsRecord); Academic research domain: AcademicPaper, ResearchCollection (Research-{Topic}-{YYYY-MM} naming), ResearchSubCollection (core_papers/methods/applications/baselines/to_read), PaperSearchQuery, PaperImportResult, PaperWritingMemory, LiteratureReviewOutput, buildCollectionName(), titlesAreDuplicate() (token-overlap, ratio > 0.8) |
| `@nexus/adaptive-scraper`  | Proxy-aware scraper with robots.txt checking and isProxyError classification        |
| `@nexus/stealth-browser`   | Playwright stealth driver (PatchrightDriver) with Redis Streams eventing            |
| `@nexus/human-browser`     | Human input simulation for stealth browser interaction                              |
| `@nexus/supervisor`        | Multi-agent supervisor and lifecycle manager; OmaTask DAG (id, title, description, status, dependsOn, assignee), OmaTaskStatus (pending/in_progress/completed/failed/blocked/skipped), OmaSchedulingStrategy (round-robin/least-busy/capability-match/dependency-first), countBlockedDependents() (forward BFS criticality scoring), assignTasks(), OmaContextStrategy (sliding-window/summarize/compact), OmaStreamEvent (8-type union), OmaLoopDetectionConfig (maxRepetitions=3), TokenBudgetExceededError, InvalidAgentMessageError |
| `@nexus/autotune`          | EMA adaptive parameter tuning service                                               |
| `@nexus/parseltongue`      | Red-team input perturbation engine                                                  |
| `@nexus/evals`             | LLM evaluation framework: scorers, test runner, result types                        |
| `@nexus/doc-pipeline`      | End-to-end document ingestion pipeline (extract → classify → OCR → index)           |
| `@nexus/doc-ocr`           | OCR integration; dots.ocr VLM patterns: OcrPromptMode (7 modes: layout_all/layout_only/ocr/grounding/web/scene/svg), OcrLayoutCategory (11 types: Caption/Footnote/Formula→LaTeX/Table→HTML/Picture/Text→Markdown etc.), OcrBoundingBox [x1,y1,x2,y2], OcrLayoutElement, OcrPageResult, OcrInferenceConfig (vLLM OpenAI-compat endpoint), buildOcrServerUrl(), DOTS_OCR_IMAGE_TOKENS, snapToImageFactor(), isWithinOcrPixelBounds(), filterByCategory(), extractPageText() |
| `@nexus/prediction-market` | Polymarket + Kalshi + Metaculus CLOB backends + OAuth 2.0 connector; CLOB order book (BookType L1/L2/L3, BookAction ADD/UPDATE/DELETE/CLEAR, applyOrderBookDelta, bestBid/Ask/bookMidpoint/bookSpread/avgPriceForQuantity, createOrderBook); Polymarket domain models (PolyTrade, PolySimpleMarket, PolyMarket, PolymarketEventRecord, PolyComplexMarket, PolySimpleEvent, PolyClobReward, PolyTag, PolyArticle); POLYGON_CHAIN_ID=137, POLYMARKET_CLOB_URL, POLYMARKET_GAMMA_API_URL; resolveOutcomes(), impliedProbability(), parseClobPrice() |
| `@nexus/auth`              | API key verification, HS256 JWT, Fastify preHandler hook                            |
| `@nexus/db`                | Drizzle ORM: 7 schemas, typed migrations, query helpers                             |
| `@nexus/telemetry`         | OTel bootstrap, HMAC-chained audit log, Prometheus metrics; LlmObservationType (11 types), MODEL_PRICE_TABLE (18 models), computeTokenCost(), LlmGenerationRecord, aggregateSessionCost() |
| `@nexus/plugin-sdk`        | `defineAdapter()`, capability types, testing harness; Social media provider contracts: ISocialProvider (identifier, name, scopes, editor, post(), authenticate(), generateAuthUrl(), refreshToken(), maxLength(), checkValidity()), SocialAuthTokenDetails (id, name, accessToken, refreshToken, expiresIn, additionalSettings), SocialPostDetails<T>, SocialPostResponse (id, postId, releaseURL, status), SocialMediaContent (image/video, path, alt, thumbnail), SocialPollDetails, SocialAnalyticsData, SocialClientInformation, SocialRefreshTokenError, SocialBadBodyError |
| `@nexus/contracts`         | OpenAPI 3.1 + AsyncAPI 3.0 machine-readable API specs                               |
| `@nexus/shared`            | Shared types, `Result<T,E>`, Zod utilities                                          |
| `@nexus/voice`             | TTS/STT pipeline                                                                    |
| `@nexus/ragtime`           | RAG: chunk → embed → retrieve → rerank; hybrid similarity (Jaccard+cosine), sentence-level citation insertion, multi-source retrieval (KB+KG+web), sub-query decomposition; Onyx search pipeline: SearchType (keyword/semantic/internet), QueryType + hybrid_alpha gating (≤0.2→keyword, else semantic), RecencyBiasSetting (favor_recent/base_decay/no_decay/auto), QueryExpansions (keywordsExpansions+semanticExpansions), SearchBaseFilters + SearchIndexFilters (ACL access_control_list, tenantId, hierarchyNodeIds), AccumulatorState (cross-section text buffer with linkOffsets), ChunkPayload, accumulateSection() (flush-on-overflow chunker), flushAccumulator(), combineRetrievalResults() (dedup by doc+chunk id, max-score wins) |
| `@nexus/knowledge-graph`   | Entity + relation graph over agent memory; entity rank, community model, hierarchical Leiden clustering, multi-hop BFS traversal, KGSearchType (6 modes), parallel chunk extraction |
| `@nexus/ultraplinian`      | Multi-model race engine: UltraplinianRunner races N models via OpenRouter in parallel waves (12/wave, 150ms stagger); scoreResponse() scores substance/directness/completeness 0–100; winner selected by score then latency. 5 additive SpeedTiers (fast→ultra), 47 curated models |
| `@nexus/client`            | Typed isomorphic fetch SDK for external consumers (Node 18+ and browser). 5 namespaces: `gateway` (sendMessage, sendMessageStream SSE async generator, race, listModels), `council` (deliberate, getVerdicts, getVerdict, getTranscript), `memory` (remember, recall, forget, list), `agents` (queryLibrarian, readFile, writeFile), `research` (startResearch, startAcademic, getCitations). NexusError with code + statusCode. AbortController timeout on every fetch. |
| `@nexus/adapters`          | Unified barrel — re-exports all 25 `@nexus/adapter-*` sub-packages from a single entry point (betterstack, calendar, cloudflare, confluence, council, deep-research, doppler, drive, github, gmail, groq, hubspot, ide, ingest, jira, linear, mlx, neon, notion, salesforce, searxng, slack, supabase, tavily, vercel) |

> Full package list: 150 `@nexus/*` packages across agent, MCP, memory, ingestion, adapters, infra, and AI tooling layers.

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

| Variable                      | Required | Description                                                  |
| ----------------------------- | -------- | ------------------------------------------------------------ |
| `DATABASE_URL`                | ✅       | PostgreSQL connection string (with pgvector extension)       |
| `REDIS_URL`                   | ✅       | Redis connection string for BullMQ                           |
| `NEXUS_API_KEY`               | ✅       | Master API key for gateway authentication                    |
| `NEXUS_AUDIT_KEY`             | ✅       | HMAC key for audit log chaining                              |
| `GROQ_API_KEY`                | ✅       | Groq API key (primary LLM + embeddings)                      |
| `OPENAI_API_KEY`              | optional | OpenAI provider (council + llm-drivers)                      |
| `OPENWEATHER_API_KEY`         | optional | Weather feed polling                                         |
| `NEWS_API_KEY`                | optional | News feed polling                                            |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional | Jaeger/Tempo trace exporter                                  |
| `COUNCIL_MIN_PRIORITY`        | optional | Minimum signal priority to trigger council (default: `high`) |

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

| ADR                                                 | Decision                                         |
| --------------------------------------------------- | ------------------------------------------------ |
| [ADR-0002](docs/adr/0002-postgres-sole-state.md)    | PostgreSQL is the sole authoritative state store |
| [ADR-0006](docs/adr/0006-apache-2-license.md)       | Apache 2.0 license (patent grant)                |
| [ADR-0008](docs/adr/0008-plugin-sdk-first-class.md) | Plugin SDK is a first-class citizen              |
| [ADR-0009](docs/adr/0009-versioned-api.md)          | API versioning from day one (`/v1/`)             |
| [ADR-0010](docs/adr/0010-hmac-chained-audit-log.md) | HMAC-chained audit log for tamper evidence       |
| [ADR-0017](docs/adr/0017-coverage-floor-80.md)      | 80% coverage floor enforced in CI                |

Additional architectural decisions recorded in git history:

- `Promise.allSettled` as the standard pattern for all concurrent fanouts (council voting, `spawn_agents`, swarm coordination) to guarantee error isolation
- `VersionedPlan.bump()` creates immutable snapshots on every state transition — no in-place mutation of swarm plan state
- `classifyFailoverError()` uses digit-isolated status code matching to avoid false-positives on numbers in error text (e.g. "500 error" vs "section 500")
- `completeSplit()` splits system prompts into static + dynamic halves to avoid prompt cache invalidation on every turn
- `microCompact()` dual-trigger (count OR token threshold) prevents both turn-count and token-count overflow in long sessions
- `DockerReplExecutor` uses hard fail-secure constraints (SIGKILL, absolute caps, network isolation) rather than soft limits or graceful degradation
- Domain feed polling via BullMQ repeatable jobs (not `setInterval`) to prevent multi-pod duplication
- `user_id` threading through MCP client, auth middleware, and memory store for multi-tenant ACL
- IVFFlat ANN index on `memory_entries.embedding` with `lists=100` tuned for 1M rows; wrapped in `try/catch` so pgvector < 0.4 is non-fatal
- `IMAGE_TOKEN_COST=1600` flat per-image token budget avoids triple-compact bug (providers tokenize by resolution ~1-2k, not base64 byte length)

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
