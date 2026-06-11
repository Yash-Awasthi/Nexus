# GhostStack

**Local-first multi-agent orchestration nucleus** — a production-grade TypeScript runtime for spec-driven, governed, fault-tolerant task execution across heterogeneous execution adapters.

```bash
gs submit "search for the latest AI papers and summarise findings"
# → PlanningEngine classifies objective → selects search blueprint
# → GovernanceEngine evaluates constraints, policies, guardrails
# → Orchestrator enqueues task with type=search
# → TaskExecutor routes to WebSearchAdapter.execute()
# → Results persisted; event log replayed automatically on crash recovery
```

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-6-blue)
![Tests](https://img.shields.io/badge/tests-499%20passing-brightgreen)
![ESLint](https://img.shields.io/badge/ESLint-0%20errors-brightgreen)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GhostStack Runtime                           │
│                                                                     │
│  ┌──────────────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │  Planning Engine │   │  Governance  │   │  Approval          │  │
│  │  11 blueprints   │──▶│  Engine      │──▶│  Workflow          │  │
│  │  + LLM classify  │   │  constraints │   │  (human-in-loop)   │  │
│  └──────────────────┘   │  policies    │   └────────────────────┘  │
│                         │  guardrails  │                            │
│                         └──────┬───────┘                            │
│                                │                                    │
│  ┌─────────────────────────────▼──────────────────────────────────┐ │
│  │                   GhostStackOrchestrator                       │ │
│  │        submitAndRun(objective) → plan → govern → execute       │ │
│  └──────────┬──────────────────────────────────────┬─────────────┘ │
│             │                                      │               │
│     ┌───────▼──────┐                  ┌────────────▼─────────────┐ │
│     │  FileQueue   │                  │      Task Executor       │ │
│     │  Backend     │◀─────────────────│   runLoop() + retry      │ │
│     │  JSONL + DLQ │                  │   backoff + circuit      │ │
│     └──────────────┘                  └────────────┬─────────────┘ │
│                                                    │               │
│  ┌─────────────────────────────────────────────────▼─────────────┐ │
│  │                     Execution Adapters                        │ │
│  │  Floci (AWS)  Browser  Scraping  WebSearch  Code  Inference   │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─────────────┐  ┌──────────────────┐  ┌───────────────────────┐  │
│  │ Memory      │  │  Runtime Graph   │  │  Runtime Compactor    │  │
│  │ Store       │  │  topology +      │  │  adaptive heuristics  │  │
│  │ 4 indexes   │  │  cycle detect +  │  │  + LeakDetector       │  │
│  │ TTL + prune │  │  validate+repair │  │  + QuotaManager       │  │
│  └─────────────┘  └──────────────────┘  └───────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │          HTTP API  ·  gs CLI (33 commands)  ·  MCP server     │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Key Features

### Execution Engine
- **Priority-weighted FIFO queue** — `FileQueueBackend` backed by atomic JSONL writes with in-process priority ordering; metrics on every push/pop
- **Exponential-backoff retry loop** — `runLoop(maxIterations, idleDelayMs)` with configurable thresholds; backoff delay respected between iterations
- **Dead-letter queue** — exhausted jobs quarantined; operator recycling via `gs dlq`; `clearDeadLetterQueue()` on interface
- **Crash recovery** — append-only JSONL event log replayed on startup; corrupt lines quarantined automatically

### Planning Engine
- **11 blueprint types** — `ingestion`, `scraper`, `backup`, `etl`, `research`, `search`, `code`, `inference`, `dangerous`, `delete`, `default`
- **Word-boundary keyword matching** — whole-word regex prevents `research` shadowing `search`; priority-ordered selection
- **LLM-backed classification** — pass any `ILanguageModel` to `PlanningEngine(llm)` to route objectives via `generateObject()`; falls back to keyword matching if model is unavailable
- **Argument overrides** — `key=value` pairs parsed from the objective string and merged into blueprint arguments at plan time

### Governance Stack
- **GovernanceEngine** — composable evaluation pipeline run before every task:
  - Constraints: `ResourceScopeConstraint`, `CostBudgetConstraint`, `TimeoutConstraint`
  - Policies: `DangerousOperationPolicy`, `WildcardPermissionsPolicy`
  - Guardrails: `LoopDetectionGuardrail`, `RunawayRetriesGuardrail`, `TaskGraphLimitGuardrail`, `HighCostPlanGuardrail`, `DuplicateActionGuardrail`
- **Approval Workflow** — human-in-the-loop gating with `gs approve`/`cancel` and event-sourced audit trail

### Execution Adapters
- **FlociAdapter** — LocalStack-compatible AWS emulator (S3, SQS, DynamoDB, Lambda, SNS); mock fallback for offline dev
- **BrowserExecutionAdapter** — Playwright automation with crawl quota enforcement
- **ScrapingExecutionAdapter** — Axios-based scraping with offline simulation fallback
- **WebSearchAdapter** — web search and answer tasks via configurable search engine
- **CodeAgentPool** — five-agent pool (`FilePickerAgent`, `CodeEditorAgent`, `CodeReviewerAgent`, `ResearcherAgent`, `ThinkerAgent`); dispatches on `code` / `code_edit` / `code_review` / `research` / `reason`
- **LocalInferenceAdapter** — routes `inference` / `local_llm` / `generate` tasks to a local model bridge

### Resilience
- **Circuit Breaker** — sliding-window failure counting (`failureWindowMs`, default 60 s); half-open recovery; `HealthAwareCircuitBreaker` with configurable health probe interval
- **Runtime Compactor** — adaptive compaction triggered by journal growth, heap %, EventBus backpressure, and quota violations
- **Write-verify persistence** — every state write is read back and compared; second-write retry on mismatch

### Observability
- **Structured Logger** — `GHOSTSTACK_LOG_LEVEL`, `GHOSTSTACK_LOG_FORMAT=json`, `GHOSTSTACK_LOG_FILE` sink; `ILogger` threaded through every subsystem
- **Metrics** — gauge, counter, timing tracking; `queue.push_total`, `queue.pop_total`, `queue.dlq_total`, `queue.active_length` all emitted
- **Prometheus export** — `/metrics/prometheus` endpoint
- **TraceIndexer** — auto-indexes EventBus events into MemoryStore for semantic retrieval

### Memory & Knowledge
- **MemoryStore** — four index Sets with O(1) lookup; TTL eviction cleans all indexes atomically; configurable auto-prune timer
- **AgentBus** — bounded ring buffer; TTL sweep on push/read; capability registry
- **RuntimeGraph** — directed execution graph; topological sort; cycle detection; validate + repair; persisted journals

### Workflow Engine
- 5 built-in templates: `BrowserResearchWorkflow`, `LocalCloudProvisioning`, `DocumentProcessing`, `SpecToExecution`, `GovernedETL`
- JSON/YAML spec loading with full structural validation
- S3-event auto-trigger pipeline; idempotency tokens; state verification checkpoints

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 6, strict mode |
| Runtime | Node.js 20+, `ts-node` for development |
| Queue persistence | Priority-weighted JSONL (`FileQueueBackend`) |
| Event persistence | Append-only JSONL event log (`FileEventStore`) |
| State persistence | JSON KV store with write-verify (`FileRuntimePersistence`) |
| Config | `.env` + `ghoststack.config.json` + YAML service registry |
| HTTP API | Native `http.createServer` — zero framework overhead |
| Testing | Jest — 499 tests, 65 suites, deterministic assertions |
| Linting | ESLint + `@typescript-eslint` — 0 errors, 0 warnings |
| Cloud emulation | Floci (LocalStack-compatible AWS API surface) |
| Browser automation | Playwright (optional dependency) |
| LLM inference | Groq API / OpenRouter / Ollama via `ILanguageModel` |

---

## Project Stats

```
Test suites : 65 passing / 66 total (1 environment-skipped)
Tests       : 499 passing / 504 total (5 environment-skipped)
TypeScript  : 0 errors
ESLint      : 0 errors, 0 warnings
Version     : 1.2.0
```

---

## Quick Start

```bash
# Install dependencies
npm install

# Scaffold config, directories, and an example workflow spec
npm run gs -- init

# Type-check the entire codebase
npm run typecheck

# Run the full test suite
npm test

# Start the HTTP API server
npm run start

# Generate a governed execution plan from natural language
npm run gs -- plan "deploy ingestion pipeline bucketName=raw-data"

# Submit an objective end-to-end (plan → govern → queue → execute)
npm run gs -- submit "search for latest TypeScript performance benchmarks"

# Load and run a workflow spec file directly
npm run gs -- run ./specs/demo-etl/workflow-spec.json

# Inspect queue state, DLQ, and execution history
npm run gs -- queue
npm run gs -- dlq list
npm run gs -- workflows:executions
```

---

## CLI Reference

```
gs init                    Scaffold config, directories, and example spec
gs start                   Start HTTP API server (foreground)
gs start:federation        Boot Floci + API + MCP server as supervised group
gs submit <objective>      Plan → govern → execute from natural language
gs run <spec-path>         Execute a workflow spec file immediately
gs plan <objective>        Preview generated task graph without executing
gs queue                   Show pending and dead-letter queue state
gs dlq list                List dead-letter jobs with retry counts
gs dlq retry <job-id>      Re-enqueue a specific dead-letter job
gs dlq clear               Drop all dead-letter jobs
gs workflows               List registered workflow definitions
gs workflows:executions    Show execution history and telemetry
gs approve <id>            Approve a pending governance-gated execution
gs cancel <id>             Cancel a running execution
gs memory                  Query MemoryStore entries and stats
gs graph                   RuntimeGraph topology snapshot
gs graph:validate          Check for cycles, dangling edges, missing deps
gs graph:repair            Remove dangling edges and fix inconsistencies
gs graph:prune             Remove stale/failed nodes
gs diagnose                Config + healthcheck + federation status
gs logs [limit]            Show recent event log entries
gs version                 Print version and runtime info
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GHOSTSTACK_API_PORT` | `3000` | HTTP API listening port |
| `GHOSTSTACK_FLOCI_URL` | `http://localhost:4566` | Floci/LocalStack endpoint |
| `GHOSTSTACK_OFFLINE_MODE` | `false` | Set to `1` to disable live adapter calls |
| `GHOSTSTACK_FLOCI_STRICT` | `false` | Fail hard on Floci errors |
| `GHOSTSTACK_MCP_PORT` | `8100` | MCP Bridge port |
| `GHOSTSTACK_DATA_DIR` | `./data-runtime` | Queue, event log, and state directory |
| `GHOSTSTACK_BACKUP_ON_START` | _(unset)_ | Set to `1` to snapshot persistence files on boot |
| `GHOSTSTACK_API_TOKEN` | _(unset)_ | Bearer token for API authentication |
| `GHOSTSTACK_LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARN` / `ERROR` |
| `GHOSTSTACK_LOG_FORMAT` | _(plain)_ | Set to `json` for structured JSON output |
| `GHOSTSTACK_LOG_FILE` | _(unset)_ | Append logs to a file path |
| `GROQ_API_KEY` | _(unset)_ | Groq API key for LLM-backed planning |
| `TAVILY_API_KEY` | _(unset)_ | Tavily API key for WebSearchAdapter |

---

## Workflow Spec Format

```json
{
  "spec_version": "v1.1",
  "metadata": {
    "name": "My ETL Pipeline",
    "description": "Scrape → filter → store"
  },
  "template_id": "governed-etl-template",
  "tasks": [
    {
      "id": "extract",
      "title": "Scrape source URL",
      "description": "Fetch raw HTML content",
      "type": "scraping",
      "action": "scrape_url",
      "priority": "high",
      "arguments": { "url": "https://example.com" },
      "dependencies": []
    },
    {
      "id": "transform",
      "title": "Filter content",
      "description": "Apply regex filter to extracted lines",
      "type": "floci",
      "action": "filter_content",
      "priority": "medium",
      "arguments": { "pattern": "AI|TypeScript", "sourceTaskId": "extract" },
      "dependencies": ["extract"]
    }
  ]
}
```

Validation enforced at parse time: required fields, unique IDs, valid priority (`low` / `medium` / `high` / `critical`), and no dangling dependency references.

---

## Robustness Audit

All correctness bugs identified across systematic audit passes have been resolved:

| ID | Description | Fix |
|---|---|---|
| F1 | `GHOSTSTACK_OFFLINE_MODE === undefined` forced offline on every unconfigured machine | Removed `=== undefined` branch; default is now online |
| F2 | Planner tasks had no `type` field; all routed to `floci` regardless of blueprint | `submitCognitiveObjective` threads `type`/`action`/`arguments` from `ITaskSynthesisResult` |
| F3 | `FreeModelProvider.streamText` did a full blocking call then yielded one chunk | Delegates to `GroqModelProvider.streamText` for real SSE streaming on groq routes |
| F4 | `GroqModelProvider.generateObject` prepended its own system message even when caller provided one | Checks for existing system message before prepending |
| B6 | `MemoryStore.prune()` left stale IDs in all 4 index Sets | `_removeFromIndexes()` helper cleans atomically |
| B9 | CircuitBreaker tripped on lifetime failure count | Sliding-window `failureTimestamps[]` with configurable window |
| A8 | `RuntimeManager.getActiveServices()` silently polluted registry with phantom "unknown" entries | Config-declared services are no longer auto-registered; registry only holds explicit entries |

---

## License

MIT
