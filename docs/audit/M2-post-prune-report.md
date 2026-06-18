<!-- SPDX-License-Identifier: Apache-2.0 -->

# M2 Post-Prune Report — GhostStack + workspace

**Date:** 2026-06-11
**Scope:** GhostStack (master) + workspace (main) forensic pruning

---

## File counts

| Source     | Upstream files   | MOVE            | DELETE | Net to Nexus    |
| ---------- | ---------------- | --------------- | ------ | --------------- |
| GhostStack | ~120 TS + config | 73              | 47+    | 73 source files |
| workspace  | 90 files         | 13 integrations | 77     | 13 source files |

---

## Destination mapping

### GhostStack → packages/runtime/src/ (60 files)

All `orchestration/` modules except floci-_ + governance/telemetry extracted.
All `runtime/_.ts` entry points.
Interfaces contract layer fully preserved.

### GhostStack → packages/governance/src/ (6 files)

- approval-workflow.ts
- capability-policy.ts
- governance-engine.ts
- resource-enforcer.ts
- interfaces/governance.interface.ts

### GhostStack → packages/telemetry/src/ (7 files)

- environment-telemetry.ts
- logger.ts
- observability-manager.ts
- prometheus-format.ts
- interfaces/logger.interface.ts
- interfaces/observability.interface.ts

### GhostStack → apps/api/src/ (2 seed files)

- conductor-server.ts (migrates to Fastify in M6)
- runtime-server.ts (migrates to Fastify in M6)

### GhostStack → apps/cli/src/ (1 seed file)

- runtime-cli.ts (migrates to @nexus/cli in M9)

### workspace → packages/adapters/\*/src/integration.ts (13 files)

All 13 integration SDK wrappers moved to their respective adapter packages.
Existing `src/index.ts` skeletons remain — integration.ts is the seed code.

---

## Deleted (GhostStack)

- `orchestration/floci-{adapter,client,extended,lambda,zip}.ts` — ADR-0001
- `apps/floci/` — 16 MB Java AWS emulator — ADR-0001
- `archive/` — quarantine dir
- `tests/` — 66 spec files rewritten as Vitest in M6
- `docker/` — rebuilt in infra/docker/ per ADR-0018
- `runtime/bridges/*.py` — rewritten in nexus-ingest (M4)
- `runtime/mcp/conductor_mcp_server.py` — rewritten in M6
- `runtime/docker-compose-runner.ts` — handled by infra/
- `runtime/benchmark-runner.ts` — per-package benchmarks in M6

## Deleted (workspace)

- `packages/agents/` (18 files) — thin Claude wrappers → adapter pattern
- `packages/core/src/agent-base.ts` — superseded by adapter pattern
- `packages/orchestrator/` — superseded by @nexus/runtime
- `apps/server/` — superseded by @nexus/api
- `db/` — 5 SQL schemas merged into @nexus/db unified schema (M3)

---

## Pending (other agent — sidebranch1)

- Judica → @nexus/council, @nexus/db (M2-3)
- fin-scrape → nexus-ingest Python service (M2-6)
- M2-7 Execute all MOVE decisions (after sidebranch1 merge)

---

## Cyclic imports

Not yet analysed — madge run deferred to after all packages have real implementations (M3).

## Unused exports

Deferred — packages are skeleton; knip will fire false positives until implementations are wired.
