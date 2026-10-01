<!-- SPDX-License-Identifier: Apache-2.0 -->

# @nexus/telemetry

Observability stack for NEXUS: health aggregation, SLO tracking, structured logging, Prometheus metrics, HMAC-chained audit log, disaster recovery, and OpenTelemetry bootstrap.

## Installation

Internal monorepo package. Consumed by `apps/api` and `apps/worker`.

```ts
import { HealthAggregator, SloTracker, ObservabilityManager, createLogger } from "@nexus/telemetry";
```

## Components

### `HealthAggregator`

Runs configurable probes (Postgres, Redis, queue depth) and aggregates them into a single health status for `/v1/health/aggregate`.

```ts
const health = new HealthAggregator({
  probes: [
    postgresProbe({ connectionString: process.env.DATABASE_URL }),
    redisProbe({ url: process.env.REDIS_URL }),
    queueDepthProbe({ queue: runtime.queue, maxDepth: 10_000 }),
  ],
  cacheTtlMs: 5_000,
});

const result = await health.check();
// result.status: "healthy" | "degraded" | "unhealthy"
// result.components: ProbeResult[]
// result.checkedAt: Date
```

### `SloTracker`

Tracks P50/P95/P99 latency, error rate, and availability against configurable SLO targets. Emits violations to the event bus.

```ts
const slo = new SloTracker({
  targets: {
    p99LatencyMs: 500,
    errorRatePct: 1,
    availabilityPct: 99.9,
  },
  windowMs: 60_000,
});

slo.record({ durationMs: 120, success: true });

const report = slo.report();
// report.p50, report.p95, report.p99, report.errorRate, report.violations[]
```

### `createLogger`

Pino-based structured logger. `LOG_LEVEL` and `LOG_FORMAT` from the environment control verbosity and output format.

```ts
import { createLogger } from "@nexus/telemetry";

const log = createLogger("nexus-api");
log.info({ signalId: "..." }, "signal processed");
log.error({ err }, "council deliberation failed");
```

### `ObservabilityManager`

Bootstraps OpenTelemetry: registers the OTLP exporter, sets service name/version, and wires `@nexus/runtime`'s `NexusOtelTracer` into the global TracerProvider.

```ts
const obs = new ObservabilityManager({
  serviceName: "nexus-api",
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  prometheusPort: 9464,
});

await obs.start();
// Prometheus metrics now scrape-able on :9464/metrics
// OTLP traces exported to configured endpoint
```

### `DisasterRecovery`

Wraps `@nexus/runtime`'s `CrashRecovery` with a DB-backed store for cross-process durability. On startup, replays unfinished checkpoints.

```ts
const dr = new DisasterRecovery({ db, maxCheckpointAgeMs: 3_600_000 });
await dr.restore(); // replays any unfinished runtime tasks
```

### `PerformanceBenchmark`

Utility for measuring throughput, latency distributions, and memory usage — used by `infra/k6/` scripts and CI benchmarks.

### `EnvironmentTelemetry`

Emits structured startup metadata: Node version, env name, package versions, enabled feature flags.

### Prometheus output

`prometheusFormat()` converts `SloReport` and `AggregatedHealth` into Prometheus text exposition format — served at `GET /metrics`.

## SLO targets

Full SLO definitions and alerting rules are in [`docs/slos.md`](../../docs/slos.md).
