<!-- SPDX-License-Identifier: Apache-2.0 -->
# apps/worker — NEXUS Queue Workers

BullMQ consumer processes for NEXUS. Pulls from Redis queues and drives the signal pipeline and task execution loops.

## Workers

### `signal-worker`

Consumes the `nexus:signals` queue. For each job:

1. Calls `SignalProcessor.processOnce()` from `@nexus/pipeline-signal`
2. Classifies raw ingested events into typed `Signal` rows
3. Publishes `nexus.signals.created` on the event bus
4. Logs batch metrics (processed / skipped / errors)

### `task-worker`

Consumes the `nexus:tasks` queue. For each job:

1. Wraps execution in `@nexus/runtime`'s CircuitBreaker
2. Creates a crash-recovery checkpoint before execution
3. Runs the task handler
4. Clears the checkpoint on success; leaves it for auto-resume on crash

## Development

```bash
pnpm --filter apps/worker dev
```

## Environment

```
DATABASE_URL=postgresql://...
REDIS_URL=redis://localhost:6379
NEXUS_API_KEY=...
LOG_LEVEL=info
```

## Scaling

Each worker process handles one queue. To scale horizontally:

```bash
# In Kubernetes — adjust replicas in values.yaml
helm upgrade nexus ./infra/helm/nexus --set worker.replicaCount=4
```

The HPA in `infra/helm/nexus/templates/hpa.yaml` auto-scales based on CPU utilisation (target: 80%).
