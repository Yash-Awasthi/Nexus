# GhostStack Release Notes

---

## v1.2.0 — 2026-06-10

### New Features

- **WebSearchAdapter** — `IExecutionAdapter` for `search` / `answer` / `web_search` task types; wired into `TaskExecutor` adapter chain.
- **CodeAgentPool** — five-agent pool (`FilePickerAgent`, `CodeEditorAgent`, `CodeReviewerAgent`, `ResearcherAgent`, `ThinkerAgent`) dispatching on `code` / `code_edit` / `code_review` / `research` / `reason` types.
- **LocalInferenceAdapter** — routes `inference` / `local_llm` / `generate` tasks to the local model bridge.
- **LLM-backed PlanningEngine** — `PlanningEngine(llm?)` accepts an optional `ILanguageModel`; uses `generateObject()` to classify objectives into blueprint keys; falls back to keyword matching on failure.
- **11 planning blueprints** — three new blueprints added: `search`, `code`, `inference`; `adapterType` field threaded through `TaskTemplate` → `ITaskSynthesisResult` → orchestrator.
- **`queue.push_total` / `queue.pop_total` counters** — `FileQueueBackend` now emits per-operation counters alongside existing gauge metrics.
- **Injectable `ITaskDependencyResolver`** — `GhostStackOrchestrator.create({ resolver })` accepts a custom resolver; defaults to `TaskDependencyResolver`.
- **`CONTRIBUTING.md`** — contribution guide covering setup, commit conventions, adapter/CLI extension, and governance rules.

### Bug Fixes

- `GHOSTSTACK_OFFLINE_MODE === undefined` silently forced offline mode everywhere — removed; default is now online.
- Planner-generated tasks had no `type` field so all routed to `floci` regardless of blueprint — `submitCognitiveObjective` now threads `type`/`action`/`arguments` from `ITaskSynthesisResult`.
- `task-payload.ts` fallback added `search` / `code` / `inference` branches and a type-only fast path.
- `GroqModelProvider.generateObject` prepended its own system message when caller already provided one — fixed with caller-has-system-message guard.
- `FreeModelProvider.streamText` did a full blocking call then yielded one chunk — now delegates to `GroqModelProvider.streamText` for real SSE streaming on groq routes.
- `CodeAgentPool.canExecute` did not accept generic `"code"` type — added, resolves to `CodeEditorAgent`.
- `RuntimeManager.getActiveServices()` silently polluted the services registry with phantom `"unknown"` entries for config-declared services — removed auto-registration side-effect.

### Changed

- All third-party library names stripped from bridges, adapters, comments, and error strings.
- Bridge files renamed: `stealth_browser_bridge.py`, `web_scraping_bridge.py`, `local_inference_bridge.py`, `mcp_server_bridge.py`.
- `FastMcpHost` → `McpServerHost`; `"fastmcp"` → `"mcp-server"` throughout.
- `apps/` cleaned: 9 third-party directories removed; `floci` retained.
- `IExecutionAdapter.execute()` return type narrowed from `Promise<any>` to `Promise<Record<string, unknown>>`.
- `selectBlueprint()` upgraded to whole-word regex matching — prevents `research` from capturing `search` as a substring.
- `OPERATIONS.md` fully rewritten for v1.2.0 with complete CLI table, env var reference, and metrics catalogue.
- `schemas/mcp_registry.json` populated with all 27 GhostStack MCP tool names.
- Bootstrap banner updated to v1.2.0.

### Stats

- 499 tests · 65 suites · 0 ESLint errors · 0 TypeScript errors

---

## v1.1.2 — 2026-06-10

### Bug Fixes

- **B1** Fixed broken `$schema` key (`""` → `"$schema"`) in `task.schema.json`, `orchestration.schema.json`, and `agent-message.schema.json`; all JSON Schema validators now parse correctly.
- **B1** `task.schema.json` expanded with `type`, `action`, `arguments`, and a properly constrained `priority` enum (`low | medium | high`).
- **B1** Priority enum in `spec.schema.json` aligned to `low | medium | high` — removed orphaned `normal` and `critical` values that did not match the queue backend.
- **B2** Added `runLoop(maxIterations?, idleDelayMs?): Promise<number>` to the `ITaskExecutor` interface; `TaskExecutor` now satisfies the interface without type-casting.
- **B3** Removed duplicate `parseEnvFile()` / `applyEnvMap()` from `runtime/ghoststack-config.ts`; `.env` loading now delegates to `loadEnvFile()` from `runtime/env-loader.ts` (single implementation, richer edge-case handling).
- **B4** `runtime/runtime-context.ts` now instantiates `FileQueueBackend` (persistent JSONL queue) instead of `MemoryQueueBackend`. Queue state survives process restarts. `GhostStackRuntimeContext.queue` is typed as `IQueueBackend` for interface correctness.

### Improvements

- Queue backend type in the runtime context narrowed to the `IQueueBackend` interface — downstream code no longer depends on the concrete class.

---

## v1.1.1 — 2026-06-09

### New Features

- **EnvLoader** (`runtime/env-loader.ts`): zero-dependency `.env` parser. Handles quoted values, inline comments, `export` prefix, blank lines, and no-override-by-default semantics. Wired into `createRuntimeContext` before any other subsystem reads `process.env`.
- **FileQueueBackend** (`orchestration/file-queue-backend.ts`): persistent JSONL-backed job queue. Atomic tmp→rename writes, crash recovery via `init()`, separate DLQ file, `clear()` and `reload()` operators.
- **RuntimeManager** rewritten from a 23-line stub to a full lifecycle manager: `registerService`, `markRunning/Stopped/Degraded/Error`, `startService/stopService/restartService`, `getHealthSummary()`.
- **Structured `/health` endpoint**: `GET /health` and `/healthz` now return `{ status, version, uptime_ms, boot_ms, timestamp, components }` with component-level detail for queue, Floci adapter, event bus, and workflow engine.
- **CLI commands**: `gs version`, `gs plan <objective>`, `gs queue` added to `runtime/cli.ts`.
- **Orchestrator helpers**: `run(maxIterations, idleDelayMs)` and `submitAndRun(objective, options)` added to `GhostStackOrchestrator`.

### Bug Fixes

- `TaskExecutor.runLoop()` exponential backoff moved out of `executeNext()` into the loop body — `executeNext()` stays non-blocking; existing tests that call it directly are unaffected.
- ESLint: `no-var-requires` → `@typescript-eslint/no-require-imports` in server health reader; `let nodeVersion` → `const`.

### Governance

- `GovernanceEngine` gained three new constraints: `TimeoutConstraint` (max execution ceiling), `HighCostPlanGuardrail` (total plan cost gate), `DuplicateActionGuardrail` (repeated action detection).

### Tooling

- `package.json` v1.1.1: all dev tools moved to `devDependencies`; only `js-yaml` remains as a runtime dep.
- `jest.config.js`: coverage directory, `collectCoverageFrom`, reporters, 60 % threshold configured.
- `tsconfig.json`: `resolveJsonModule`, `declaration`, `declarationMap`, `sourceMap`, `exclude` array added.

---

## v1.1.0 — 2026-05-18

### Initial Production Release

GhostStack transitioned from experimental architecture phases to a fully hardened, production-ready local orchestration nucleus. This release emphasizes extreme operational stability, static correctness, comprehensive observability, and safe environment integration.

### Major Capabilities

- **Deterministic Orchestration**: Topological DAG task execution powered by a local priority queue.
- **Governed Cognitive Engine**: Rigid capability bounds, required-approvals policies, and filesystem traversal protection prevent unchecked local mutations.
- **File-Locked Persistence**: Custom queue persistence layer guaranteeing zero file corruption during concurrent read/write operations.
- **Event Replay Engine**: 100 % crash recovery and telemetry restoration using complete event-sourcing JSONL backends.
- **MCP Execution Fabric**: Schema-validated MCP Tool integration directly into the workflow execution graph.

### Security and Governance

- **Sandbox Filesystem Bounds**: Relative path checks block all directory traversal vulnerabilities.
- **Approval Checkpoints**: Human-in-the-loop overrides for operations that break threshold budgets.
- **Thread-safe Execution**: Rigorously audited asynchronous JavaScript guarantees to prevent retry storms or runtime memory leaks.

### Benchmark Metrics (v1.1.0 baseline)

| Metric                          | Value         |
| ------------------------------- | ------------- |
| Task execution loop latency     | ~22.8 ms      |
| Local system throughput         | ~44 tasks/sec |
| Concurrent contention (100 ops) | ~2034 ms      |
| Storage read overhead           | ~13.4 ms      |

### Known Limitations

- **Local File Queue**: Targets single-instance developer machine execution. Distributed processing requires plugging in a Redis/Kafka `IQueueBackend` adapter.

### Operational Scope

GhostStack v1.1.0 is fit for enterprise local development tooling, build pipelines, offline integration testing, and local data ETL orchestration safely bound by governance capabilities.
