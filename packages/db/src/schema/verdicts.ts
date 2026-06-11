// SPDX-License-Identifier: Apache-2.0
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, real, numeric, jsonb, timestamp, index } from "drizzle-orm/pg-core";

import { signals } from "./signals.js";

/**
 * verdicts — council deliberation outcomes.
 *
 * Each verdict is linked 1:1 to a Signal.  The council engine writes the
 * verdict row when a majority decision is reached; the runtime task dispatcher
 * reads it to enqueue approved actions.
 */
export const verdicts = pgTable(
  "verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    /** Council decision */
    decision: text("decision", { enum: ["approve", "reject", "defer", "escalate"] }).notNull(),
    /** Aggregate confidence score [0, 1] from the deliberating archetypes */
    confidence: real("confidence").notNull(),
    /** Majority-consensus rationale */
    rationale: text("rationale").notNull(),
    /** Archetype names that dissented from the majority */
    dissents: text("dissents")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** Structured council actions from the verdict (what to do if approved) */
    actions: jsonb("actions"),
    /** Total LLM cost for this deliberation in USD */
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("verdicts_signal_id_idx").on(t.signalId),
    index("verdicts_decision_idx").on(t.decision),
    index("verdicts_created_at_idx").on(t.createdAt),
  ],
);

export type Verdict = typeof verdicts.$inferSelect;
export type NewVerdict = typeof verdicts.$inferInsert;
