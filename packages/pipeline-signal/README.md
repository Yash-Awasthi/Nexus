<!-- SPDX-License-Identifier: Apache-2.0 -->
# @nexus/pipeline-signal

Ingest-to-signal pipeline worker for NEXUS.

Converts raw `ingested_events` rows (produced by `services/ingest` adapters) into typed `Signal` records with classified type, priority, and metadata — ready for council deliberation.

## Overview

```
ingested_events  ──▶  SignalClassifier  ──▶  ISignalSink.create()  ──▶  signals table
                                                     │
                                                     └──▶  EventBus.publish("nexus.signals.created")
```

## Installation

Internal monorepo package. Consumed by `apps/worker`.

```ts
import {
  SignalClassifier,
  SignalProcessor,
  MemoryEventSource,
  MemorySignalSink,
} from "@nexus/pipeline-signal";
```

## `SignalClassifier`

Classifies a raw event into a `{ signalType, priority, tags }` result using priority-ordered rules. First matching rule wins; falls back to `general.event` at `medium` priority.

### Built-in rules

| Rule | Matches | Priority |
|---|---|---|
| `github.pr` | `source=github`, `type=pull_request` | `high` |
| `github.security` | `source=github`, `type=security_alert` | `critical` |
| `gmail.action-required` | `source=gmail`, subject contains "action required" | `high` |
| `gmail.received` | `source=gmail` | `medium` |
| `slack.mention` | `source=slack`, `type=mention` | `high` |
| `linear.issue` | `source=linear` | `medium` |
| `ingest.scrape` | `source=scrape` | `low` |

### Custom rules

```ts
const classifier = new SignalClassifier();

classifier.registerRule({
  id: "my-rule",
  matches: (input) => input.source === "pagerduty",
  classify: () => ({ signalType: "pagerduty.alert", priority: "critical", tags: ["oncall"] }),
});
```

Custom rules are prepended — they take priority over built-ins.

## `SignalProcessor`

Polling worker that drives the pipeline. Implements push-based (`processOnce`) and timer-based (`start`/`stop`) modes.

```ts
const processor = new SignalProcessor({
  eventSource,  // IEventSource — getUnprocessed(limit) + markProcessed(id)
  signalSink,   // ISignalSink  — create(signal)
  classifier,   // optional: defaults to new SignalClassifier()
  eventBus,     // optional: publishes "nexus.signals.created" after each signal
  batchSize: 50,
  pollIntervalMs: 1000,
});

// Push-based (called by BullMQ worker)
const result = await processor.processOnce();
// { processed, skipped, errors, signals }

// Timer-based
processor.start();
// ...
await processor.stop();
```

Error isolation: one event failure doesn't stop the batch. Errors are recorded in the result and logged.

## Interfaces

```ts
interface IEventSource {
  getUnprocessed(limit: number): Promise<RawEvent[]>;
  markProcessed(id: string): Promise<void>;
}

interface ISignalSink {
  create(signal: NewSignal): Promise<Signal>;
}
```

### Test doubles

`MemoryEventSource` and `MemorySignalSink` are in-memory implementations for unit tests — no DB required.

## Testing

```bash
pnpm --filter @nexus/pipeline-signal test
```

15 tests: classification per source, fallback, custom rule priority, zero-event batch, single/batch processing, idempotency, event bus publish, error isolation.
