// SPDX-License-Identifier: Apache-2.0
/**
 * SignalWorker — polls for unprocessed ingested_events and promotes them to Signals.
 *
 * Acts as a fallback for events that were written to the DB but whose Redis
 * job was lost (e.g. Redis restart, missed publish).
 *
 * Polling interval: configurable via SIGNAL_WORKER_INTERVAL_MS (default: 5000)
 * Batch size:       configurable via SIGNAL_WORKER_BATCH_SIZE  (default: 10)
 *
 * This complements the queue-based path: events published via BullMQ are
 * processed by the TaskWorker; this worker catches any DB-resident stragglers.
 *
 * Architecture note:
 *   Previously this worker called handleIngestJob() directly and duplicated
 *   classification logic. It now delegates to SignalProcessor from
 *   @nexus/pipeline-signal which owns classification (via SignalClassifier)
 *   and persistence (via DrizzleEventSource / DrizzleSignalSink). The queue-
 *   based handleIngestJob path remains unchanged — it handles real-time BullMQ
 *   jobs; this worker handles DB-resident stragglers.
 */

import { SignalProcessor } from "@nexus/pipeline-signal";

import { DrizzleEventSource, DrizzleSignalSink } from "./drizzle-adapters.js";

const POLL_INTERVAL_MS = parseInt(process.env.SIGNAL_WORKER_INTERVAL_MS ?? "5000", 10);
const BATCH_SIZE = parseInt(process.env.SIGNAL_WORKER_BATCH_SIZE ?? "10", 10);

export class SignalWorker {
  private readonly processor: SignalProcessor;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.processor = new SignalProcessor({
      eventSource: new DrizzleEventSource(),
      signalSink: new DrizzleSignalSink(),
      batchSize: BATCH_SIZE,
      pollIntervalMs: POLL_INTERVAL_MS,
      onError: (err: Error, eventId: string) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "signal-worker.process-error",
            eventId,
            error: err.message,
          }),
        );
      },
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(
      JSON.stringify({
        level: "info",
        event: "signal-worker.started",
        interval_ms: POLL_INTERVAL_MS,
        batch_size: BATCH_SIZE,
      }),
    );
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log(JSON.stringify({ level: "info", event: "signal-worker.stopped" }));
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.poll().catch(console.error), POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    try {
      const result = await this.processor.processOnce();

      if (result.processed > 0 || result.errors > 0) {
        console.log(
          JSON.stringify({
            level: "info",
            event: "signal-worker.poll",
            processed: result.processed,
            errors: result.errors,
            skipped: result.skipped,
          }),
        );
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "signal-worker.poll-error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      this.schedule();
    }
  }
}
