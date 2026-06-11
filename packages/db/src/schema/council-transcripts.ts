// SPDX-License-Identifier: Apache-2.0
import { pgTable, uuid, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { verdicts } from "./verdicts.js";

/**
 * council_transcripts — full turn-by-turn LLM conversation logs for each verdict.
 *
 * Stored separately from verdicts to keep the verdict table lean for query
 * paths that only need the decision.  Used for audit, cost attribution, and
 * fine-tuning data collection.
 *
 * Schema of the `turns` JSONB array:
 *   [{
 *     archetype: string,
 *     role: "system" | "user" | "assistant",
 *     content: string,
 *     token_count: number,
 *     cost_usd: number
 *   }]
 */
export const councilTranscripts = pgTable(
  "council_transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    verdictId: uuid("verdict_id")
      .notNull()
      .unique()
      .references(() => verdicts.id, { onDelete: "cascade" }),
    /** Array of deliberation turns — see schema in JSDoc above */
    turns: jsonb("turns").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("council_transcripts_verdict_id_idx").on(t.verdictId),
    index("council_transcripts_created_at_idx").on(t.createdAt),
  ],
);

export type CouncilTranscript = typeof councilTranscripts.$inferSelect;
export type NewCouncilTranscript = typeof councilTranscripts.$inferInsert;
