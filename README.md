<!-- SPDX-License-Identifier: Apache-2.0 -->

<div align="center">
  <img src="apps/docs-site/static/img/nexus-logo.svg" alt="NEXUS" width="96" />

  <h1>NEXUS</h1>

  <p>Multi-agent AI orchestration platform.</p>

  <p>
    <a href="https://github.com/Yash-Awasthi/Nexus/actions/workflows/test.yml">
      <img src="https://img.shields.io/github/actions/workflow/status/Yash-Awasthi/Nexus/test.yml?branch=main&label=CI&logo=github&style=flat-square" alt="CI">
    </a>
    <a href="LICENSE">
      <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License">
    </a>
    <a href="https://github.com/Yash-Awasthi/Nexus/releases">
      <img src="https://img.shields.io/github/v/release/Yash-Awasthi/Nexus?include_prereleases&style=flat-square" alt="Release">
    </a>
    <img src="https://img.shields.io/badge/TypeScript-5.4-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Node-20+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node">
    <img src="https://img.shields.io/badge/pnpm-9+-f69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm">
    <img src="https://img.shields.io/badge/packages-107-8b5cf6?style=flat-square" alt="Packages">
    <img src="https://img.shields.io/badge/tests-4476%20passing-22c55e?style=flat-square" alt="Tests">
  </p>
</div>

---

## What is NEXUS?

NEXUS is a TypeScript monorepo that provides the backend and frontend for running multi-agent AI workflows. It handles LLM routing across 15 providers, multi-model council deliberation, long-term memory with pgvector, sandboxed code execution, document ingestion, and a React dashboard wired to all of it.

| Capability | Implementation |
| --- | --- |
| Multi-model voting | Council — N models via `Promise.allSettled`, failure-isolated |
| Context management | `LlmCompactor` + `MicroCompactor` — dual-trigger (count + token threshold) |
| Provider failover | `classifyFailoverError()` — 3-category, 30+ pattern classifier; auto-retry |
| Orchestration | `VersionedPlan` + `ChannelIndex` — 13 lifecycle states, immutable snapshots |
| Code execution | `DockerReplExecutor` — `--network none`, 256MB cap, read-only FS |
| Cost tracking | `_trackCost()` → `_costLog[]` → Prometheus `/api/v1/metrics` |
| Memory | pgvector + `MemoryGraph` BFS — IVFFlat ANN, TTL, multi-tenant ACL |
| Feed polling | BullMQ repeatable jobs — Redis-locked, crash-resilient |

---

## Architecture

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
│  │                         packages/ (107)                              │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │  │ agent-runtime  │  │   council    │  │      llm-drivers        │   │   │
│  │  │ multi-step     │  │ multi-model  │  │  15 providers           │   │   │
│  │  │ tool loop +    │  │ voting with  │  │  native SSE/NDJSON      │   │   │
│  │  │ swarm layer    │  │ allSettled   │  │  streaming              │   │   │
│  │  └────────────────┘  └──────────────┘  └────────────────────────┘   │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │  │   mcp-client   │  │  code-repl   │  │      conductor          │   │   │
│  │  │ JSON-RPC 2.0   │  │  Docker REPL │  │  PlanningEngine         │   │   │
│  │  │ HTTP transport │  │  Py/R/Julia  │  │  GovernanceEngine       │   │   │
│  │  │                │  │  sandboxed   │  │  TaskExecutor           │   │   │
│  │  └────────────────┘  └──────────────┘  └────────────────────────┘   │   │
│  │                                                                      │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐   │   │
│  │  │    memory      │  │   runtime    │  │      plugin-sdk         │   │   │
│  │  │ pgvector +     │  │ circ-breaker │  │  defineAdapter()        │   │   │
│  │  │ MemoryGraph    │  │ crash-recov  │  │  + test harness         │   │   │
│  │  │ IStream/IState │  │ OTel tracing │  │                         │   │   │
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

---

## Repository layout

```
nexus/
├── apps/
│   ├── api/            Fastify HTTP/SSE/WebSocket gateway (61 route modules)
│   ├── cli/            Developer CLI (commander.js)
│   ├── docs-site/      Docusaurus documentation site
│   ├── ui/             React Router v7 SPA dashboard (100+ routes, all APIs wired)
│   └── worker/         BullMQ workers — signal, task, and repeatable feed jobs
├── packages/           107 scoped @nexus/* packages
│   ├── Core agents
│   │   ├── agent-runtime/      Multi-step LLM tool loop, spawn_agents, swarm layer
│   │   │                         VersionedPlan (immutable bump snapshots)
│   │   │                         ChannelIndex (O(1) bidirectional pub/sub)
│   │   │                         SwarmLifecycleStatus (13-state union)
│   │   │                         AgentDefinition + AgentSessionState + AgentRunOutput
│   │   ├── council/            Multi-model voting: Promise.allSettled fanout
│   │   │                         Modes: unanimous | majority | weighted
│   │   │                         Archetype system (11 personas, YAML-driven)
│   │   ├── llm-drivers/        15 provider drivers (Anthropic, OpenAI, Groq, Gemini,
│   │   │                         DeepSeek, Mistral, OpenRouter, Ollama, LMStudio,
│   │   │                         LlamaCpp, Fireworks, NvidiaNim, Cerebras, …)
│   │   │                         Native SSE/NDJSON ReadableStream, no buffering
│   │   ├── llm-router/         Dynamic provider routing by cost/latency/capability
│   │   ├── gateway/            IProvider interface, model alias routing,
│   │   │                         classifyFailoverError() (3-category, 30+ patterns),
│   │   │                         FallbackChain, CostCallbackRegistry, Singleflight<T>
│   │   └── best-of-n/          Best-of-N sampling + tournament selection
│   ├── MCP
│   │   ├── mcp-client/         MCP consumer: JSON-RPC 2.0 HTTP, injectable fetch
│   │   ├── mcp-bulk/           Batch tool invocation
│   │   ├── mcp-openapi/        Auto-generate MCP tools from OpenAPI specs
│   │   └── scraping-mcp/       Stealth browser scraping via MCP server interface
│   ├── Execution
│   │   ├── code-repl/          DockerReplExecutor — Python/R/Julia, --network none,
│   │   │                         256MB hard cap, --read-only, SessionReaper TTL
│   │   ├── runtime/            Circuit breaker (open/half-open/closed FSM),
│   │   │                         crash recovery (snapshot+WAL), OTel tracing,
│   │   │                         queue backends (memory/file/Redis)
│   │   ├── conductor/          Orchestrator — PlanningEngine (11 blueprints),
│   │   │                         GovernanceEngine (constraints/policies/guardrails),
│   │   │                         TaskExecutor (retry/backoff/circuit breaker)
│   │   │                         CJS package, ESM bridge via createRequire()
│   │   └── task-queue/         Queue abstraction: memory / file / Redis backends
│   ├── Memory & knowledge
│   │   ├── memory/             pgvector, IVFFlat ANN (lists=100),
│   │   │                         MemoryGraph BFS (score × edgeWeight × 0.7^depth decay),
│   │   │                         IStream<T>, IState<T>, BM25+RRF hybrid, TTL, ACL
│   │   ├── memory-tools/       High-level remember() / recall() / forget() API
│   │   ├── stm/                Short-term memory: HedgeReducer, DirectnessOptimizer,
│   │   │                         TruncationGuard, STMPipeline, RollingWindow, STMMetrics
│   │   ├── knowledge-graph/    Entity + relation graph; Leiden clustering,
│   │   │                         multi-hop BFS, KGSearchType (6 modes)
│   │   └── retrieval/          RAG: chunk→embed→retrieve→rerank
│   │                             Hybrid (Jaccard+cosine), sub-query decomposition,
│   │                             Onyx pipeline (SearchType, RecencyBiasSetting)
│   ├── Context management
│   │   ├── context-pruner/     LlmCompactor (isBlocked on consecutive fail)
│   │   │                         MicroCompactor (dual-trigger: 8 turns OR 80k tokens,
│   │   │                         keeps 4 recent turns), COMPACTION_THRESHOLD=0.80
│   │   ├── context-pack/       Context serialization and packing
│   │   └── context-sections/   Structured context section management
│   ├── Streaming & remote invocation
│   │   ├── trigger-engine/     ISdk: registerFunction(), registerTrigger(), InvocationError
│   │   └── stream-recovery/    ChannelWriter (lazy connect, 64KB framing, pending queue)
│   │                             ChannelReader (multi-callback, readAll())
│   ├── AI tools
│   │   ├── drift/              EMA adaptive parameter tuning
│   │   ├── redteam/            Input perturbation engine
│   │   ├── thinker/            Chain-of-thought + think-parse utilities
│   │   ├── llm-cache/          Prompt-keyed LLM response cache
│   │   ├── prompt-cache/       Cache-control primitives (static+dynamic split)
│   │   └── token-budget/       Token budget tracking and enforcement
│   ├── Evaluation & training
│   │   ├── evals/              Scorers, test runner, result types
│   │   ├── rlhf-pipeline/      RLHF data pipeline
│   │   ├── sft-tagger/         Supervised fine-tuning auto-tagging
│   │   └── corpus-builder/     Training corpus construction
│   ├── Data ingestion
│   │   ├── pipeline-signal/    ingest → classify → typed Signal rows
│   │   │                         7 built-in classifier rules, LISTEN/NOTIFY hot path
│   │   ├── domain-feeds/       16 global intelligence domains (aviation, climate,
│   │   │                         conflict, economic, displacement, cyber, health,
│   │   │                         imagery, seismology, wildfire, maritime, market,
│   │   │                         sanctions, radiation, space, patents)
│   │   │                         BullMQ repeatable jobs
│   │   ├── adaptive-scraper/   Proxy-aware scraper with robots.txt checking
│   │   ├── spider/             Web crawler with depth control
│   │   └── stealth-browser/    PatchrightDriver (Playwright stealth) + Redis Streams
│   ├── Document processing
│   │   ├── doc-pipeline/       Full ingestion: extract → classify → OCR → index
│   │   ├── doc-extractor/      Text and structure extraction
│   │   ├── doc-classifier/     Document classification
│   │   ├── doc-ocr/            OcrPromptMode (7 modes), OcrLayoutCategory (11 types)
│   │   ├── doc-acl/            Document access control
│   │   └── doc-workflow/       Document workflow orchestration
│   ├── Adapters (25)
│   │   └── adapter-{betterstack,calendar,cloudflare,confluence,council,
│   │         deep-research,doppler,drive,github,gmail,groq,hubspot,ide,
│   │         ingest,jira,linear,mlx,neon,notion,salesforce,searxng,
│   │         slack,supabase,tavily,vercel}/
│   ├── Infrastructure
│   │   ├── auth/               API key + HS256 JWT, Fastify preHandler hook
│   │   ├── db/                 Drizzle ORM — 7 schemas, typed migrations
│   │   ├── telemetry/          OTel bootstrap, HMAC-SHA256-chained audit log,
│   │   │                         Prometheus formatters, MODEL_PRICE_TABLE (18 models)
│   │   ├── supervisor/         OmaTask DAG, OmaTaskStatus (6 states),
│   │   │                         OmaSchedulingStrategy (4 modes)
│   │   ├── contracts/          OpenAPI 3.1 + AsyncAPI 3.0 specs
│   │   └── shared/             Result<T,E>, Zod utilities, shared types
│   └── Other
│       ├── prediction-market/  Polymarket + Kalshi + Metaculus CLOB backends
│       │                         L1/L2/L3 order book, impliedProbability()
│       ├── voice/              TTS/STT pipeline
│       ├── image-gen/          Text-to-image adapters
│       ├── gauntlet/           Races 47 models in waves of 12, 150ms stagger,
│       │                         scoreResponse() 0-100, 5 SpeedTiers
│       └── plugin-sdk/         defineAdapter(), ISocialProvider contracts, test harness
├── services/
│   └── ingest/         Python (FastAPI + Celery) — adapter runners → DB
├── infra/
│   ├── docker/         docker-compose.dev/ci/observability
│   ├── grafana/        Pre-provisioned dashboards: nexus-overview + nexus-provider-health
│   ├── otel/           OTel Collector config, Prometheus scrape config, datasources
│   ├── helm/nexus/     Helm chart (6 templates, HPA, ingress)
│   ├── k8s/            Kubernetes manifests
│   ├── terraform/      GKE / EKS provisioning modules
│   ├── k6/             Load test scripts (200 VU, 5-minute soak)
│   └── chaos/          Pod kill + network partition chaos tests
├── docs/
│   ├── adr/            18 Architecture Decision Records
│   ├── runbook.md      Operational runbook
│   ├── slos.md         SLO definitions and targets
│   └── security/       Threat model
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
# Edit .env — minimum: DATABASE_URL, REDIS_URL, NEXUS_API_KEY, GROQ_API_KEY

# 4. Migrate database
pnpm --filter @nexus/db migrate

# 5. Build all packages
pnpm build

# 6. Start dev servers (api + ui + worker in parallel via turbo)
pnpm dev
```

API at `http://localhost:3000` · UI at `http://localhost:5173`

```bash
# Observability stack (Prometheus + Grafana + Jaeger + OTel Collector)
docker compose -f docker-compose.yml \
  -f infra/docker/docker-compose.observability.yml \
  --profile observability up

# Grafana at :3001  (admin / nexus-dev) — dashboards auto-provisioned
# Prometheus at :9090
# Jaeger UI at :16686
```

> Sandboxed code execution (`/api/v1/code-repl`) requires Docker running. API falls back to `MockReplExecutor` automatically if Docker is unavailable.

---

## SDK

External apps can consume the Nexus API via `@nexus/client` — typed, isomorphic, no runtime deps beyond `fetch`.

```ts
import { NexusClient } from "@nexus/client";

const nexus = new NexusClient({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.NEXUS_API_KEY,
});

// Single-model chat
const res = await nexus.gateway.sendMessage({
  model: "nexus/smart",
  messages: [{ role: "user", content: "Explain monads" }],
});
console.log(res.content[0].text);

// Streaming (async generator — Node + browser)
for await (const event of nexus.gateway.sendMessageStream({
  model: "nexus/fast",
  messages: [...],
})) {
  if (event.type === "content_block_delta") process.stdout.write(event.delta.text);
}

// Council deliberation
const verdict = await nexus.council.deliberate({
  proposal: "Should we deploy to prod?",
  context: "All tests passing, staging green",
});
console.log(verdict.result, verdict.confidence); // "approve" 0.91

// Long-term memory
await nexus.memory.remember({ content: "User prefers concise answers", category: "preference" });
const hits = await nexus.memory.recall({ query: "user preferences", limit: 5 });

// Deep research
const report = await nexus.research.startResearch({ query: "quantum error correction 2025" });
```

```bash
pnpm add @nexus/client                                          # within monorepo
pnpm add github:Yash-Awasthi/Nexus#main --filter @nexus/client  # external projects
```

---

## Core concepts

### Agent runtime

`@nexus/agent-runtime` drives multi-step LLM tool-calling loops. Each `AgentRuntime` receives an instruction, streams LLM output through `ToolStreamParser`, dispatches tool calls, feeds results back, and repeats until `maxSteps` or a terminal state.

`makeSpawnAgentsTool()` adds a `spawn_agents` tool to any agent — it can fork N child `AgentRuntime` instances concurrently:

```ts
import { AgentRuntime, makeSpawnAgentsTool } from "@nexus/agent-runtime";

const agent = new AgentRuntime({
  llm: myLlmStreamFn,
  tools: [makeSpawnAgentsTool(myLlmStreamFn, { maxConcurrency: 5 })],
});

const result = await agent.run("Research quantum computing advances in 2025");
```

Child agents run via `Promise.allSettled` — one failing child never cancels others.

### Swarm orchestration

- **`VersionedPlan`** — wraps `SwarmPlanDefinition` with `SwarmExecutionState`. Immutable `bump()` creates a new versioned snapshot on every state transition.
- **`ChannelIndex`** — bidirectional pub/sub registry. O(1) lookups by both `swarmChannel` and `session`.
- **`SwarmLifecycleStatus`** — 13-state union: `spawned | ready | running | running_stale | completed | done | failed | stopped | crashed | queued | blocked | pending | todo`.

```ts
import { VersionedPlan, ChannelIndex } from "@nexus/agent-runtime";

const plan = new VersionedPlan(planDef, initialState);
const next = plan.bump({ taskId: "step-1", status: "completed" });

const index = new ChannelIndex();
index.subscribe("swarm-42", "session-abc", handler);
```

### Council deliberation

```ts
import { CouncilService } from "@nexus/council";

const council = new CouncilService({ providers: ["groq:llama3", "groq:gemma2"] });
const verdict = await council.deliberate("Should we approve this deployment?");
// { verdict: "approve", confidence: 0.87, reasoning: "...", votes: [...] }
```

Voting modes: `unanimous | majority | weighted`. `Promise.allSettled` guarantees a slow or failed provider never blocks the vote.

### Provider failover

```ts
import { classifyFailoverError } from "@nexus/gateway";

classifyFailoverError("context length exceeded"); // → RetryNextProvider
classifyFailoverError("429 Too Many Requests"); // → RetryAndMarkUnavailable
classifyFailoverError("internal server error"); // → None (non-retriable)
```

`IProvider` key methods: `complete()`, `completeSplit()` (static + dynamic system prompt halves — prevents cache invalidation every turn), `stream()`, `supportsImageInput()`, `availableModels()`.

### Context compaction

```ts
import { microCompact, LlmCompactor } from "@nexus/context-pruner";

const compacted = microCompact(messages, tokenCount);

const compactor = new LlmCompactor({ caller: myLlmCaller });
const result = await compactor.compact(messages);
```

- **`MicroCompactor`** — dual-trigger: fires on 8 turns _or_ 80k tokens. Keeps 4 most-recent turns untouched.
- **`LlmCompactor`** — LLM-based prose summary. `isBlocked` prevents hammering a failing provider.
- Thresholds: `COMPACTION_THRESHOLD=0.80`, `CRITICAL_THRESHOLD=0.95`, `IMAGE_TOKEN_COST=1600`.

### Memory & MemoryGraph

```ts
import { MemoryGraph, PgVectorStore } from "@nexus/memory";

const graph = new MemoryGraph();
graph.addMemory({ id: "m1", text: "...", embedding: [...], score: 0.9 });
graph.tagMemory("m1", "reasoning");
graph.linkMemories("m1", "m2", "relates_to");

const results = graph.cascadeRetrieve("m1", { maxDepth: 3, topK: 10 });
// BFS with score × edgeWeight × 0.7^depth decay + tag fan-out
```

IVFFlat ANN index with `lists=100`. Wrapped in `try/catch` so pgvector < 0.4 is non-fatal.

### Sandboxed code execution

```
DockerReplExecutor security constraints:
  --network none          no outbound traffic
  --memory 256m           hard RAM cap (SIGKILL on overflow)
  --cpus 0.5              CPU throttle
  --read-only             immutable container FS
  --no-new-privileges     drop privilege escalation
```

`SessionReaper` TTL-reaps idle containers. Docker unavailability auto-switches to `MockReplExecutor`.

### Conductor orchestration

`packages/conductor` — CJS runtime bridged into the ESM monorepo via `createRequire(import.meta.url)`:

- **`PlanningEngine`** — 11 task blueprints + LLM classify to select the right blueprint
- **`GovernanceEngine`** — constraint evaluation, policy rules, and guardrail checks before execution
- **`TaskExecutor`** — per-task retry/backoff/circuit breaker; publishes `nexus_gs_*` Prometheus metrics
- API: `/api/v1/gs/submit`, `/gs/jobs`, `/gs/status`, `/gs/dead-letter`, `/gs/health`

### LLM streaming

15 concrete provider drivers, each with native `ReadableStream` generators — no polling, no buffering:

| Provider  | Protocol   | Streaming                       |
| --------- | ---------- | ------------------------------- |
| Anthropic | SSE        | `event: content_block_delta`    |
| OpenAI    | SSE        | `data.choices[0].delta.content` |
| Groq      | SSE        | OpenAI-compatible               |
| Gemini    | NDJSON     | `:streamGenerateContent`        |
| DeepSeek  | SSE        | OpenAI-compatible               |
| +10 more  | SSE/NDJSON | Provider-specific               |

### Signal pipeline

Raw events enter via adapters → `services/ingest` → `ingested_events` → `@nexus/pipeline-signal` classifies into typed `Signal` rows (priority: `critical | high | medium | low`). Hot path: Postgres `LISTEN/NOTIFY` triggers immediate council deliberation on critical/high signals.

### Observability

Every request emits:

- **Prometheus** — `/api/v1/metrics` exposes `nexus_gateway_requests_total`, `nexus_gateway_latency_ms`, `nexus_gateway_tokens_total`, `nexus_gateway_cost_usd_total`, `nexus_slo_*`, `nexus_gs_jobs_total`, `nexus_gs_queue_depth`, `process_heap_bytes`
- **Grafana** — dashboards auto-provisioned from `infra/grafana/dashboards/` (nexus-overview, nexus-provider-health)
- **Alerts** — 4 rules: error rate >5%, p99 >5s, DLQ backlog >20, SLO availability <99.9%
- **OTel traces** — OTLP export, W3C traceparent propagation, Jaeger UI at `:16686`
- **Audit log** — HMAC-SHA256 chained entries in `audit_log`. Tampering breaks the chain — detectable on every read.

---

## Core packages

| Package | Description |
| --- | --- |
| `@nexus/agent-runtime` | Multi-step LLM tool loop, `spawn_agents`, swarm layer (VersionedPlan, ChannelIndex, 13 lifecycle states), exponential backoff (base 1s, cap 8s, 3 max retries) |
| `@nexus/council` | Multi-model deliberation: Promise.allSettled fanout, synthesis, guardrails, archetype personas (11 types, YAML-driven) |
| `@nexus/llm-drivers` | 15 provider drivers, native SSE/NDJSON ReadableStream |
| `@nexus/llm-router` | Dynamic routing by cost, latency, and capability |
| `@nexus/gateway` | IProvider, model alias routing, classifyFailoverError() (3-category, 30+ patterns), FallbackChain, CostCallbackRegistry, Singleflight<T> |
| `@nexus/mcp-client` | MCP consumer: JSON-RPC 2.0 HTTP, injectable fetch |
| `@nexus/mcp-bulk` | Batch MCP tool invocation |
| `@nexus/mcp-openapi` | Auto-generate MCP tools from OpenAPI specs |
| `@nexus/code-repl` | DockerReplExecutor — Python/R/Julia, --network none, 256MB cap, SessionReaper |
| `@nexus/memory` | pgvector, IVFFlat ANN (lists=100), MemoryGraph BFS (0.7^depth decay), IStream/IState, TTL, ACL, BM25+RRF hybrid |
| `@nexus/memory-tools` | High-level remember() / recall() / forget() |
| `@nexus/stm` | HedgeReducer, DirectnessOptimizer, TruncationGuard, STMPipeline, RollingWindow |
| `@nexus/context-pruner` | LlmCompactor + MicroCompactor, dual-trigger (count OR token), isBlocked guard |
| `@nexus/trigger-engine` | ISdk: registerFunction(), registerTrigger(), InvocationError |
| `@nexus/stream-recovery` | ChannelWriter/ChannelReader WebSocket pair, 64KB binary framing |
| `@nexus/runtime` | Circuit breaker FSM, crash recovery (snapshot+WAL), OTel tracing, queue backends |
| `@nexus/conductor` | Orchestrator (11 blueprints, GovernanceEngine, TaskExecutor), CJS package, ESM bridge |
| `@nexus/pipeline-signal` | ingest → classify → Signal worker (7 rules, LISTEN/NOTIFY hot path) |
| `@nexus/domain-feeds` | 16 global intel domains, BullMQ repeatable jobs, AcademicPaper, titlesAreDuplicate() |
| `@nexus/retrieval` | RAG: chunk→embed→retrieve→rerank, Jaccard+cosine hybrid, sub-query decomposition |
| `@nexus/knowledge-graph` | Entity+relation graph, Leiden clustering, multi-hop BFS, KGSearchType (6 modes) |
| `@nexus/gauntlet` | Races 47 models in waves of 12, 150ms stagger, scoreResponse() 0-100, 5 SpeedTiers |
| `@nexus/supervisor` | OmaTask DAG (6 statuses), OmaSchedulingStrategy (4 modes), countBlockedDependents() BFS |
| `@nexus/drift` | EMA adaptive parameter tuning |
| `@nexus/redteam` | Input perturbation engine |
| `@nexus/evals` | LLM evaluation: scorers, test runner, result types |
| `@nexus/doc-pipeline` | extract → classify → OCR → index |
| `@nexus/doc-ocr` | OcrPromptMode (7 modes), OcrLayoutCategory (11 types), LaTeX/HTML table extraction |
| `@nexus/prediction-market` | Polymarket+Kalshi+Metaculus CLOB backends, order book (L1/L2/L3), impliedProbability() |
| `@nexus/telemetry` | OTel bootstrap, HMAC-chained audit log, Prometheus formatters, MODEL_PRICE_TABLE (18 models) |
| `@nexus/auth` | API key + HS256 JWT, Fastify preHandler hook |
| `@nexus/db` | Drizzle ORM — 7 schemas, typed migrations, query helpers |
| `@nexus/adapters` | Barrel — re-exports all 25 @nexus/adapter-* sub-packages |
| `@nexus/plugin-sdk` | defineAdapter(), ISocialProvider contracts, capability types, test harness |
| `@nexus/client` | Typed isomorphic SDK — gateway/council/memory/agents/research namespaces |
| `@nexus/contracts` | OpenAPI 3.1 + AsyncAPI 3.0 machine-readable specs |
| `@nexus/shared` | Result<T,E>, Zod utilities, shared types |

---

## Scripts

```bash
pnpm build          # Build all packages (turbo cached)
pnpm dev            # Watch mode — all packages in parallel
pnpm test           # 4,476 tests across all packages
pnpm typecheck      # TypeScript — zero errors enforced
pnpm lint           # ESLint across monorepo
pnpm generate       # Re-generate types from OpenAPI/AsyncAPI specs
pnpm --filter @nexus/db migrate     # Run DB migrations
pnpm --filter @nexus/db generate    # Re-generate Drizzle schema
```

---

## Deployment

### Docker Compose (staging / single-node)

```bash
docker compose -f docker-compose.yml up --build
# postgres:5432  redis:6379  ingest:8000  api:3000
```

### Kubernetes (Helm)

```bash
kubectl create secret generic nexus-secrets \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=REDIS_URL='redis://...' \
  --from-literal=NEXUS_API_KEY='...' \
  --from-literal=NEXUS_AUDIT_KEY='...' \
  --from-literal=GROQ_API_KEY='...'

helm install nexus ./infra/helm/nexus \
  --set global.image.registry=ghcr.io/yash-awasthi \
  --set api.image.tag=latest

helm upgrade nexus ./infra/helm/nexus \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=nexus.example.com
```

See [`infra/terraform/`](infra/terraform/) for GKE and EKS provisioning modules.

---

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL (pgvector enabled) |
| `REDIS_URL` | yes | Redis for BullMQ |
| `NEXUS_API_KEY` | yes | Master gateway auth key |
| `NEXUS_AUDIT_KEY` | yes | HMAC key for audit log chaining |
| `GROQ_API_KEY` | yes | Primary LLM + embeddings |
| `OPENAI_API_KEY` | optional | OpenAI (fine-tune, TTS-1, council) |
| `ANTHROPIC_API_KEY` | optional | Claude models |
| `GEMINI_API_KEY` | optional | Gemini models |
| `OPENWEATHER_API_KEY` | optional | Weather feed polling |
| `NEWS_API_KEY` | optional | News feed polling |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional | Jaeger/Tempo trace export |
| `METRICS_NO_AUTH` | optional | `true` = allow Prometheus scrape without Bearer token |
| `COUNCIL_MIN_PRIORITY` | optional | Minimum signal priority for council (default: `high`) |

Full reference: `.env.example`

---

## Testing

```bash
pnpm test                         # All suites (4,476 tests)
pnpm --filter @nexus/memory test  # Single package
pnpm --filter apps/api test       # Single app
pnpm typecheck                    # Zero type errors

k6 run infra/k6/smoke.js          # Smoke test
k6 run infra/k6/soak.js           # 5-min soak at 200 VU
bash infra/chaos/pod-kill.sh      # Kill random pod, observe recovery
```

Coverage floor: **80%** (CI enforced — ADR-0017).

Design invariants:

- All packages use injectable dependencies — no live DB/Redis/Docker required for tests
- `PgVectorStore` mocked with Neon SQL driver; `DockerReplExecutor` → `MockReplExecutor` in tests
- `MockLlmStream` / `MockTransport` give deterministic output for agent/council/driver tests
- Schema bootstrap tested with exact mock call counts to catch accidental query regressions

---

## Architecture decisions

18 locked ADRs in [`docs/adr/`](docs/adr/). Notable:

| ADR | Decision |
| --- | --- |
| [ADR-0002](docs/adr/0002-postgres-sole-state.md) | PostgreSQL is the sole authoritative state store |
| [ADR-0006](docs/adr/0006-apache-2-license.md) | Apache 2.0 (patent grant) |
| [ADR-0008](docs/adr/0008-plugin-sdk-first-class.md) | Plugin SDK is a first-class citizen |
| [ADR-0009](docs/adr/0009-versioned-api.md) | API versioning from day one (`/api/v1/`) |
| [ADR-0010](docs/adr/0010-hmac-chained-audit-log.md) | HMAC-chained audit log for tamper evidence |
| [ADR-0017](docs/adr/0017-coverage-floor-80.md) | 80% coverage floor enforced in CI |

Key implementation decisions:

- `Promise.allSettled` for all concurrent fanouts — error isolation by design
- `VersionedPlan.bump()` creates immutable snapshots — no in-place swarm plan mutation
- `classifyFailoverError()` uses digit-isolated status code matching to avoid false-positives
- `completeSplit()` splits system prompts static+dynamic to prevent cache invalidation every turn
- `microCompact()` dual-trigger prevents both turn-count and token-count overflow
- `DockerReplExecutor` hard fail-secure (SIGKILL, absolute caps, network isolation)
- Domain feed polling via BullMQ repeatable jobs — prevents multi-pod duplication
- `user_id` threaded through MCP client, auth middleware, and memory store for multi-tenant ACL
- IVFFlat ANN index with `lists=100` tuned for 1M rows; wrapped in try/catch so pgvector < 0.4 is non-fatal
- `IMAGE_TOKEN_COST=1600` flat per-image — avoids triple-compact bug
- Conductor bridged as CJS inside ESM monorepo via `createRequire(import.meta.url)` — avoids dual-package hazard

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): local setup, commit conventions, changeset workflow, DCO sign-off, ADR process.

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
- Every PR needs a [changeset](https://github.com/changesets/changesets) for publishable packages
- New features need tests — coverage must not drop below 80%
- Architectural changes require a new ADR in `docs/adr/`
- All dependencies must be injectable — no `new SomeExternalService()` without a config escape hatch

---

## Security

See [SECURITY.md](SECURITY.md) and [`docs/security/`](docs/security/) for the full threat model.

To report a vulnerability: **do not open a public issue**. Use GitHub's private security advisory feature.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright © 2024–2026 Yash Awasthi and contributors.
