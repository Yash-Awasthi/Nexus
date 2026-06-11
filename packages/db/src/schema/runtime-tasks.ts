// SPDX-License-Identifier: Apache-2.0
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

import { verdicts } from "./verdicts.js";

/**
 * runtime_tasks — tasks submitted for execution by the GhostStack runtime.
 *
 * A task is the unit of work that flows through the IQueueBackend.
 * Tasks that require human or governance approval transition to
 * awaiting_approval before being allowed to run.
 */
export const runtimeTasks = pgTable(
  "runtime_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Semantic task type, maps to an adapter handler, e.g. "email.send" */
    type: text("type").notNull(),
    /** Task payload delivered to the adapter handler */
    payload: jsonb("payload").notNull(),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed", "cancelled", "awaiting_approval"],
    })
      .notNull()
      .default("queued"),
    priority: text("priority", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    /** Optional verdict that authorized this task (traceability) */
    verdictId: uuid("verdict_id").references(() => verdicts.id, { onDelete: "set null" }),
    /** Optional client idempotency key */
    idempotencyKey: text("idempotency_key"),
    /** Error message if status=failed */
    error: text("error"),
    /** Result payload if status=completed */
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("runtime_tasks_status_idx").on(t.status),
    index("runtime_tasks_priority_idx").on(t.priority),
    index("runtime_tasks_type_idx").on(t.type),
    index("runtime_tasks_verdict_id_idx").on(t.verdictId),
    index("runtime_tasks_created_at_idx").on(t.createdAt),
    uniqueIndex("runtime_tasks_idempotency_key_udx").on(t.idempotencyKey),
  ],
);

export type RuntimeTask = typeof runtimeTasks.$inferSelect;
export type NewRuntimeTask = typeof runtimeTasks.$inferInsert;
