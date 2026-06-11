# GhostStack — Roadmap

**Last updated:** 2026-06-10
**Current state:** v1.2.0 · 499 tests · 65 suites · 0 ESLint errors · 0 TS errors · backlog clear

---

## All Issues Resolved

Every identified issue from v1.0 through v1.2.0 has been fixed, tested, and committed.

| ID | Description | Status |
|---|---|---|
| W1–W4 | WebSearchAdapter, CodeAgentPool, LocalInferenceAdapter wired; `code` type routing fixed | Done |
| F1–F6 | offlineMode default, planner→executor disconnect, task-payload fallback, dual system message, fake streaming, CodeAgentPool `code` type | Done |
| C1–C3 | Third-party names removed, apps/ cleaned, HTML artefacts deleted | Done |
| T5 | `Orchestrator.submitAndRun()` integration test | Done |
| T6 | `EnvLoader` propagation test (runtime propagation describe block) | Done |
| T7 | 14-case adapter routing test suite (canExecute, adapterType threading, E2E spy routing, LLM fallback) | Done |
| F-LLM-PLAN | `PlanningEngine` accepts optional `ILanguageModel`; LLM blueprint classification with keyword fallback; word-boundary matching | Done |
| A7 | `mcp_registry.json` populated with all 27 GhostStack MCP tool names | Done |
| A8 | `RuntimeManager.getActiveServices()` no longer silently auto-registers config services as "unknown" | Done |
| F-METRICS | `FileQueueBackend` emits `queue.push_total` / `queue.pop_total` counters on every push/pop | Done |
| Q1 | `IExecutionAdapter.execute()` return type narrowed from `Promise<any>` to `Promise<Record<string,unknown>>` | Done |
| Q2 | `ITaskDependencyResolver` injectable via `GhostStackOrchestrator.create({ resolver })` | Done |
| Q3 | `spec.schema.json` priority enum — confirmed already includes `"medium"` | Done |
| D2 | `OPERATIONS.md` fully rewritten for v1.2.0 (CLI table, env vars, metrics, benchmarks) | Done |
| D3 | `apps/floci/README.md` — already present in floci source tree | Done |
| D4 | `CONTRIBUTING.md` created — setup, tests, commit conventions, adapter guide | Done |

---

## Future Backlog (not blocking)

These are valid improvements but require external dependencies or significant scope — deferred until genuinely needed:

| ID | Description |
|---|---|
| F-REDIS | `RedisQueueBackend` implementing `IQueueBackend` via LPUSH/BRPOP for multi-process deployments |
| F-WEBHOOK | `GHOSTSTACK_APPROVAL_WEBHOOK_URL` outbound notification for human-in-the-loop approval flows |
