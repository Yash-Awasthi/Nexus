# GhostStack v1.2.0 — Operational Runbook

This document covers system boot, health verification, CLI usage, diagnostics, crash recovery, and performance benchmarking for **GhostStack v1.2.0**.

---

## 1. System Boot & Initialization

### API server (foreground)

```bash
npm start
# or
npm run gs -- start
```

Starts the HTTP diagnostic API on `GHOSTSTACK_API_PORT` (default `3000`).

### Full federation (Floci + API + optional MCP)

```bash
npm run start:federation
```

Starts Docker-based Floci emulator, then the API server. Requires Docker.

### Bootstrap demo (one-shot showcase)

```bash
npm run bootstrap
# With governed workflow showcase:
GHOSTSTACK_BOOTSTRAP_SHOWCASE=true npm run bootstrap
```

Loads all YAML configs, replays event history, registers workflow templates, and (optionally) runs three governed workflow demos: Safe, Blocked, and Approval-gated.

**Expected startup log sequence:**

1. GhostStack v1.2.0 banner
2. Runtime sandbox created under `data-runtime/`
3. Workflow templates registered (`browser-research`, `local-provisioning`, `doc-processing`, `spec-to-execution`, `governed-etl`)
4. Workflow specs loaded from `specs/`
5. Orchestrator event replay complete
6. Floci health probe result logged

---

## 2. CLI Reference (`gs`)

```bash
npm run gs -- <command>
```

| Command                | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `init`                 | Scaffold config, spec dirs, and example workflows             |
| `start`                | Start HTTP API server                                         |
| `start:federation`     | Start Floci + API + optional MCP server                       |
| `stop`                 | Stop federation resources                                     |
| `restart`              | Stop then start federation                                    |
| `ps`                   | List running federation services                              |
| `bootstrap`            | One-shot runtime initialization                               |
| `status` / `health`    | Federation + Floci + API health snapshot                      |
| `e2e`                  | Run S3 → Lambda → invoke federation E2E (requires live Floci) |
| `e2e:http`             | Run E2E against a running API (`GHOSTSTACK_API_URL`)          |
| `adapters`             | List adapter manifest entries                                 |
| `diagnose`             | Config + healthcheck + federation status report               |
| `workflows`            | List registered workflow definitions                          |
| `workflows:executions` | Workflow execution history and telemetry                      |
| `workflows:templates`  | Registered workflow templates                                 |
| `approve <id>`         | Approve a pending workflow execution                          |
| `cancel <id>`          | Cancel a running workflow execution                           |
| `logs [n]`             | Show last n event log entries (default 20)                    |
| `memory`               | Query memory store entries and stats                          |
| `graph`                | RuntimeGraph topology snapshot                                |
| `graph:nodes`          | List all graph nodes                                          |
| `graph:edges`          | List all graph edges                                          |
| `graph:validate`       | Validate graph integrity (cycles, dangling edges)             |
| `graph:repair`         | Remove dangling edges and fix dependencies                    |
| `plan <objective>`     | Generate a governed plan from a natural-language objective    |
| `queue`                | Show executor queue state (pending + DLQ)                     |
| `dlq list`             | List dead-letter queue entries                                |
| `dlq retry <id>`       | Re-enqueue a dead-letter job                                  |
| `dlq clear`            | Purge all dead-letter entries                                 |
| `run <spec-path>`      | Load a workflow spec file and execute it immediately          |
| `submit <objective>`   | Plan + govern + execute an objective end-to-end               |
| `version`              | Print GhostStack version and runtime info                     |

---

## 3. Health & Integrity Audits

```bash
npm run healthcheck
```

Audits:

- Core directory structure
- YAML config file syntax (`ports.yaml`, `services.yaml`, `healthchecks.yaml`)
- TypeScript compilation (key source files)
- JSON schema document validity

Exit code `0` = all clear. Exit code `1` = one or more checks failed. Use in CI/CD gates.

---

## 4. Real-Time Introspection & Metrics

**Runtime data files** (under `data-runtime/` by default):

| File              | Contents                                                 |
| ----------------- | -------------------------------------------------------- |
| `events.jsonl`    | Append-only structured event log                         |
| `cache.json`      | Key-value persistence store (workflow results, memory)   |
| `queue.jsonl`     | Active executor queue (durable across restarts)          |
| `queue-dlq.jsonl` | Dead-letter queue                                        |
| `backups/`        | Auto-created backups when `GHOSTSTACK_BACKUP_ON_START=1` |

**Metrics available via API:**

```
GET /metrics/prometheus   — Prometheus text format
GET /runtime/queue        — Live queue depth + DLQ count
GET /runtime/diagnostics  — Full diagnostic snapshot
```

**Key metric names:**

| Metric                | Type    | Description                  |
| --------------------- | ------- | ---------------------------- |
| `queue.active_length` | gauge   | Current active queue depth   |
| `queue.dlq_length`    | gauge   | Dead-letter queue depth      |
| `queue.push_total`    | counter | Total jobs pushed to queue   |
| `queue.pop_total`     | counter | Total jobs popped from queue |
| `queue.dlq_total`     | counter | Total jobs moved to DLQ      |
| `floci.reachable`     | gauge   | 1 = Floci reachable, 0 = not |
| `bootstrap.duration`  | timing  | Orchestrator boot time (ms)  |

### Exporting a diagnostic snapshot

```bash
npm run diagnose
```

Writes `logs/diagnostics-export.json` with queue stats, workflow history, registered templates, and event replay count.

---

## 5. Crash Recovery

When the process exits unexpectedly, the runtime recovers automatically on next boot:

```
Process crash / SIGKILL
        ↓
Bootstrap reads events.jsonl → replays to rebuild state
        ↓
cache.json consulted for completed task results
        ↓
Active queue restored from queue.jsonl
        ↓
Pending tasks resume execution
```

**Manual state reset** (maintenance only):

```bash
# Unix
rm -f data-runtime/*.json data-runtime/*.jsonl

# Windows
Remove-Item data-runtime\*.json
Remove-Item data-runtime\*.jsonl
```

Restart normally after clearing. All historical events and queue state will be lost.

---

## 6. Performance Benchmarking

```bash
npm run benchmark
```

Profiles persistence latency, queue throughput, and contention overhead. Results written to `docs/BENCHMARKS.md`.

**Measured targets (v1.2.0):**

| Metric                   | Target         |
| ------------------------ | -------------- |
| Sequential write latency | < 25 ms        |
| Queue throughput         | > 30 tasks/sec |
| Parallel contention p99  | < 3 000 ms     |
| Executor loop overhead   | < 30 ms        |

---

## 7. Environment Variables

| Variable                        | Default | Description                                                        |
| ------------------------------- | ------- | ------------------------------------------------------------------ |
| `GHOSTSTACK_OFFLINE_MODE`       | `false` | Set to `1` or `true` to enable mock adapters (no live network)     |
| `GHOSTSTACK_API_PORT`           | `3000`  | HTTP diagnostic server port                                        |
| `GHOSTSTACK_API_TOKEN`          | —       | Bearer token for API auth (unset = no auth)                        |
| `GHOSTSTACK_FLOCI_STRICT`       | `false` | Fail hard on Floci errors instead of using mock fallback           |
| `GHOSTSTACK_BACKUP_ON_START`    | `false` | Set to `1` to snapshot event log and cache on each boot            |
| `GHOSTSTACK_BOOTSTRAP_SHOWCASE` | `false` | Set to `true` to run governed workflow demos on bootstrap          |
| `GHOSTSTACK_LOG_LEVEL`          | `INFO`  | Log level: `DEBUG`, `INFO`, `WARN`, `ERROR`                        |
| `GHOSTSTACK_LOG_FORMAT`         | `text`  | Set to `json` for structured JSON log output                       |
| `GHOSTSTACK_LOG_FILE`           | —       | Absolute path to write log output to a file                        |
| `GROQ_API_KEY`                  | —       | Groq API key for LLM-backed planning and web-search classification |
| `TAVILY_API_KEY`                | —       | Tavily API key for WebSearchAdapter                                |
