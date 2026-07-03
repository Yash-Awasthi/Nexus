// SPDX-License-Identifier: Apache-2.0
import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * agent_sessions — persisted state of a coding-agent (ToolAgentRuntime) run.
 *
 * Stores the full conversation `messages` so a session can be resumed: a new
 * agent.run with the same `id` reloads these messages and continues the loop.
 * `status` mirrors the runtime's SessionStatus; `usage` holds the cumulative
 * token totals. Messages are the provider-agnostic RuntimeMessage shape
 * (role/content/toolCalls/toolCallId) — no secrets are stored here.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Optional owning user (multi-tenant); nullable for system runs. */
    userId: uuid("user_id"),
    /** Optional linked runtime_tasks row. */
    taskId: uuid("task_id"),
    /** active | completed | aborted | error */
    status: text("status").notNull().default("active"),
    /** The original top-level instruction for the session. */
    instruction: text("instruction"),
    /** Full RuntimeMessage[] conversation history (for resume). */
    messages: jsonb("messages").$type<unknown[]>().notNull().default([]),
    /** Cumulative token usage {inputTokens, outputTokens, totalTokens}. */
    usage: jsonb("usage").$type<Record<string, number>>(),
    /** Error message when status=error. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("agent_sessions_user_id_idx").on(t.userId),
    index("agent_sessions_task_id_idx").on(t.taskId),
    index("agent_sessions_status_idx").on(t.status),
  ],
);

export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
