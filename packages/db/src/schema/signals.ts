// SPDX-License-Identifier: Apache-2.0
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * signals — processed, enriched signals derived from one or more ingested events.
 *
 * The pipeline-signal worker creates Signal rows; the council dispatcher
 * subscribes to signal creation and starts deliberations.
 */
export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Semantic signal type, e.g. "email.action-required", "code.security-finding" */
    signalType: text("signal_type").notNull(),
    /** Array of ingested_event IDs that contributed to this signal */
    sourceEventIds: uuid("source_event_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    /** Human-readable summary for the council */
    summary: text("summary").notNull(),
    /** Triage priority — used to select council archetypes and queue priority */
    priority: text("priority", { enum: ["low", "medium", "high", "critical"] })
      .notNull()
      .default("medium"),
    /** Arbitrary signal metadata (enrichment, tags, extracted entities, etc.) */
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("signals_signal_type_idx").on(t.signalType),
    index("signals_priority_idx").on(t.priority),
    index("signals_created_at_idx").on(t.createdAt),
  ],
);

export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
