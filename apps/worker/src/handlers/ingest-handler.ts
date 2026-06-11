// SPDX-License-Identifier: Apache-2.0
/**
 * Ingest event handler — processes `ingest:event` jobs.
 *
 * Takes an ingested_event and converts it to a Signal row.
 * The resulting signal can then trigger a council deliberation.
 */

import { db } from "@nexus/db";
import { ingestedEvents, signals } from "@nexus/db/schema";
import { eq } from "drizzle-orm";

export interface IngestJobPayload {
  eventId: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Maps an ingested event type to a signal type and priority.
 */
function classifyEvent(
  source: string,
  eventType: string,
): { signalType: string; priority: "low" | "medium" | "high" | "critical" } {
  // Security / high-priority signals
  if (eventType.includes("security") || eventType.includes("breach") || eventType.includes("alert")) {
    return { signalType: `${source}.security-alert`, priority: "critical" };
  }
  if (eventType.includes("deploy") || eventType.includes("release")) {
    return { signalType: `${source}.deployment`, priority: "high" };
  }
  if (eventType.includes("pr") || eventType.includes("pull_request")) {
    return { signalType: `${source}.pr-event`, priority: "medium" };
  }
  if (eventType.includes("email") || eventType.includes("message")) {
    return { signalType: `${source}.communication`, priority: "medium" };
  }
  if (eventType.includes("financial") || eventType.includes("market")) {
    return { signalType: `${source}.market-signal`, priority: "high" };
  }
  return { signalType: `${source}.${eventType}`, priority: "low" };
}

export async function handleIngestJob(payload: IngestJobPayload): Promise<unknown> {
  const { eventId, source, eventType, payload: eventPayload } = payload;

  // Build a human-readable summary for council consumption
  const summary = `[${source}] ${eventType} received — ${JSON.stringify(eventPayload).slice(0, 200)}`;

  const { signalType, priority } = classifyEvent(source, eventType);

  // Create a signal from this event
  const [signal] = await db
    .insert(signals)
    .values({
      signalType,
      sourceEventIds: [eventId],
      summary,
      priority,
      metadata: { source, eventType, rawPayload: eventPayload },
    })
    .returning({ id: signals.id });

  // Mark the source event as processed
  if (signal) {
    await db
      .update(ingestedEvents)
      .set({ processedAt: new Date() })
      .where(eq(ingestedEvents.id, eventId));
  }

  return { signalId: signal?.id, signalType, priority };
}
