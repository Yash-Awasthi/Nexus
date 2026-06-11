// SPDX-License-Identifier: Apache-2.0
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * ingested_events — raw events received from external adapters.
 *
 * The idempotency_key unique index guarantees at-most-once ingestion
 * per source+key pair, enabling safe retries from adapters.
 */
export const ingestedEvents = pgTable(
  "ingested_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Adapter source identifier, e.g. "gmail", "github", "slack" */
    source: text("source").notNull(),
    /** Structured event type, e.g. "email.received", "pr.opened" */
    eventType: text("event_type").notNull(),
    /** Raw payload from the adapter — stored as JSONB for query flexibility */
    payload: jsonb("payload").notNull(),
    /** Optional adapter-level metadata (headers, trace ids, etc.) */
    metadata: jsonb("metadata"),
    /** Optional deduplication key supplied by the adapter client */
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set once the pipeline-signal worker has processed this event into a Signal */
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("ingested_events_source_idx").on(t.source),
    index("ingested_events_event_type_idx").on(t.eventType),
    index("ingested_events_created_at_idx").on(t.createdAt),
    uniqueIndex("ingested_events_idempotency_key_udx").on(t.idempotencyKey),
  ],
);

export type IngestedEvent = typeof ingestedEvents.$inferSelect;
export type NewIngestedEvent = typeof ingestedEvents.$inferInsert;
