// SPDX-License-Identifier: Apache-2.0
import { pgTable, text, uuid, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * orchestration_runs — persisted state of a multi-agent orchestration run
 * (@nexus/agent-orchestrator fan-out → score → optional merge).
 *
 * One row per `orchestration.run` job. The worker handler upserts the row on each
 * stage transition (running → completed | failed) so a run's progress survives a
 * worker restart: on boot, non-terminal rows are re-enqueued from their stored
 * `payload`. `candidates`/`scores`/`winner` capture the fan-out result for the
 * compare/merge UI (§6.2). `id` is the free-form runId string (e.g. "orc-…" or the
 * originating taskId), not a UUID — it names the run's git worktrees/branches.
 */
export const orchestrationRuns = pgTable(
  "orchestration_runs",
  {
    /** Free-form runId (payload.taskId ?? "orc-<ts>"); also the worktree/branch prefix. */
    id: text("id").primaryKey(),
    /** Optional owning user (multi-tenant); nullable for system runs. */
    userId: uuid("user_id"),
    /** pending | running | scoring | merging | completed | failed */
    status: text("status").notNull().default("pending"),
    /** The instruction every agent works on. */
    task: text("task").notNull(),
    /** Original job payload, kept verbatim so a non-terminal run can be re-enqueued. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** Candidate diffs/summaries produced by the fan-out (Candidate[] shape). */
    candidates: jsonb("candidates").$type<unknown[]>().notNull().default([]),
    /** Per-candidate scores {candidateId: 0..1}, when scoring completed. */
    scores: jsonb("scores").$type<Record<string, number>>(),
    /** Winning candidate id, once chosen. */
    winner: text("winner"),
    /** Error message when status=failed. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("orchestration_runs_status_idx").on(t.status),
    index("orchestration_runs_user_id_idx").on(t.userId),
  ],
);

export type OrchestrationRun = typeof orchestrationRuns.$inferSelect;
export type NewOrchestrationRun = typeof orchestrationRuns.$inferInsert;
