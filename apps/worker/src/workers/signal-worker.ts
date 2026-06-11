// SPDX-License-Identifier: Apache-2.0
/**
 * SignalWorker — polls for unprocessed ingested_events and promotes them to Signals.
 *
 * Acts as a fallback for events that were written to the DB but whose Redis
 * job was lost (e.g. Redis restart, missed publish).
 *
 * Polling interval: configurable via SIGNAL_WORKER_INTERVAL_MS (default: 5000)
 *
 * This complements the queue-based path: events published via BullMQ are
 * processed by the TaskWorker; this worker catches any DB-resident stragglers.
 */

import { db } from "@nexus/db";
import { ingestedEvents } from "@nexus/db/schema";
import { isNull, asc } from "drizzle-orm";
import { handleIngestJob } from "../handlers/ingest-handler.js";

const POLL_INTERVAL_MS = parseInt(process.env["SIGNAL_WORKER_INTERVAL_MS"] ?? "5000", 10);
const BATCH_SIZE = parseInt(process.env["SIGNAL_WORKER_BATCH_SIZE"] ?? "10", 10);

export class SignalWorker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(
      JSON.stringify({ level: "info", event: "signal-worker.started", interval_ms: POLL_INTERVAL_MS }),
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
      // Fetch unprocessed events in creation order
      const unprocessed = await db
        .select()
        .from(ingestedEvents)
        .where(isNull(ingestedEvents.processedAt))
        .orderBy(asc(ingestedEvents.createdAt))
        .limit(BATCH_SIZE);

      if (unprocessed.length > 0) {
        console.log(
          JSON.stringify({
            level: "info",
            event: "signal-worker.poll",
            found: unprocessed.length,
          }),
        );
      }

      for (const event of unprocessed) {
        await handleIngestJob({
          eventId: event.id,
          source: event.source,
          eventType: event.eventType,
          payload: event.payload as Record<string, unknown>,
        }).catch((err) => {
          console.error(
            JSON.stringify({
              level: "error",
              event: "signal-worker.process-error",
              eventId: event.id,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
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
