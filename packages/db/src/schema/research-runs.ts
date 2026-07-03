// SPDX-License-Identifier: Apache-2.0
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * research_runs — persisted researcher run results.
 *
 * Written by apps/api/src/routes/researcher.ts on every successful research call.
 * Provides durable runId → citations lookup that survives restarts and the
 * in-process 500-entry eviction cap.
 */
export const researchRuns = pgTable("research_runs", {
  /** UUID assigned by the caller (randomUUID in the route). */
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  /** Full serialised finding: synthesis, citations[], richCitations[], results[] */
  result: jsonb("result").notNull(),
  /** SourceReference[] — redundant fast path for the /citations endpoint. */
  citations: jsonb("citations").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ResearchRun = typeof researchRuns.$inferSelect;
export type NewResearchRun = typeof researchRuns.$inferInsert;
