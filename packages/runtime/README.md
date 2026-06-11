<!-- SPDX-License-Identifier: Apache-2.0 -->
# @nexus/runtime

Execution kernel for NEXUS (evolved from GhostStack).

Provides the low-level building blocks that every service depends on: queue backends, circuit breaker, crash recovery, event bus, OTel distributed tracing, and the `createNexusRuntime` factory that wires them together.

## Installation

Internal monorepo package. Consumed by `apps/api`, `apps/worker`, and `services/ingest`.

```ts
import { createNexusRuntime } from "@nexus/runtime";
```

## Quick start

```ts
const runtime = createNexusRuntime({
  queueBackend: "redis",
  redisOptions: { url: process.env.REDIS_URL },
  councilBridge: {
    providers: [{ id: "groq", apiKey: process.env.GROQ_API_KEY }],
  },
  otel: { serviceName: "nexus-api", enabled: true },
});

await runtime.start();
// use runtime.queue, runtime.eventBus, runtime.tracer, runtime.council
await runtime.stop();
```

## Components

### Queue backends

| Class | Use case |
|---|---|
| `MemoryQueueBackend` | Unit tests — no external deps |
| `FileQueueBackend` | Integration tests — persists to disk |
| `RedisQueueBackend` | Production — BullMQ over Redis |

```ts
import { RedisQueueBackend } from "@nexus/runtime";

const queue = new RedisQueueBackend({ url: "redis://localhost:6379" });
await queue.enqueue("signals", { signalId: "..." });
```

### CircuitBreaker

Three-state FSM: `closed → open → half-open → closed`. Prevents cascade failures.

```ts
import { CircuitBreaker } from "@nexus/runtime";

const breaker = new CircuitBreaker({
  threshold: 5,          // failures before opening
  timeout: 30_000,       // ms before trying half-open
  successThreshold: 2,   // successes in half-open before closing
});

const result = await breaker.execute(() => callExternalService());
```

### CouncilBridge

Routes planning queries to `@nexus/council` for multi-model deliberation.

```ts
import { CouncilBridge } from "@nexus/runtime";

const bridge = new CouncilBridge({ providers: [...] });
const decision = await bridge.deliberate({ question: "...", context: {...} });
```

### CrashRecovery

Snapshot + WAL-style recovery. On restart, resumes in-progress tasks automatically.

```ts
import { CrashRecovery } from "@nexus/runtime";

const recovery = new CrashRecovery({ store: new MemoryRecoveryStore() });
const checkpoint = await recovery.checkpoint("task-123", { step: 3, data: {...} });
await recovery.resume(); // replays unfinished checkpoints
```

### LocalEventBus

In-process pub/sub for decoupled component communication. Swap for a Redis-backed bus in multi-process deployments.

```ts
import { LocalEventBus } from "@nexus/runtime";

const bus = new LocalEventBus();
bus.subscribe("nexus.signals.created", async (payload) => { /* ... */ });
await bus.publish("nexus.signals.created", { signalId: "..." });
```

### NexusOtelTracer

W3C traceparent propagation. Wraps `@opentelemetry/api` with NEXUS-specific helpers.

```ts
import { NexusOtelTracer, encodeTraceparent } from "@nexus/runtime";

const tracer = new NexusOtelTracer({ serviceName: "nexus-api" });
const span = tracer.startSpan("process-signal", { signalId: "..." });
const header = encodeTraceparent(span.context);
// forward header to downstream services
span.end();
```

## Testing

```bash
pnpm --filter @nexus/runtime test
```
