// SPDX-License-Identifier: Apache-2.0
/**
 * Drizzle-backed adapters for the SignalProcessor pipeline.
 *
 * DrizzleEventSource  — reads unprocessed rows from `ingested_events`
 * DrizzleSignalSink   — inserts rows into `signals`
 *
 * Both implement the interfaces defined in @nexus/pipeline-signal so that
 * SignalProcessor can run without knowing anything about the DB layer.
 */

import { randomUUID } from "node:crypto";

import { db } from "@nexus/db";
import { ingestedEvents, signals } from "@nexus/db/schema";
import type { IEventSource, ISignalSink, RawEvent, CreatedSignal } from "@nexus/pipeline-signal";
import { eq, isNull, asc } from "drizzle-orm";

// ── DrizzleEventSource ────────────────────────────────────────────────────────

export class DrizzleEventSource implements IEventSource {
  async getUnprocessed(limit: number): Promise<RawEvent[]> {
    const rows = await db
      .select()
      .from(ingestedEvents)
      .where(isNull(ingestedEvents.processedAt))
      .orderBy(asc(ingestedEvents.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      eventType: row.eventType,
      payload: row.payload as Record<string, unknown>,
      ...(row.metadata != null ? { metadata: row.metadata as Record<string, unknown> } : {}),
      createdAt: row.createdAt,
    }));
  }

  async markProcessed(eventId: string): Promise<void> {
    await db
      .update(ingestedEvents)
      .set({ processedAt: new Date() })
      .where(eq(ingestedEvents.id, eventId));
  }
}

// ── DrizzleSignalSink ─────────────────────────────────────────────────────────

export class DrizzleSignalSink implements ISignalSink {
  async create(signal: Omit<CreatedSignal, "id" | "createdAt">): Promise<CreatedSignal> {
    const id = randomUUID();
    const createdAt = new Date();

    await db.insert(signals).values({
      id,
      signalType: signal.signalType,
      sourceEventIds: signal.sourceEventIds,
      summary: signal.summary,
      priority: signal.priority as "low" | "medium" | "high" | "critical",
      metadata: signal.metadata ?? null,
    });

    return { ...signal, id, createdAt };
  }
}
