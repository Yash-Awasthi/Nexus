// SPDX-License-Identifier: Apache-2.0
/**
 * Persistence port for orchestration runs (§6.1).
 *
 * The orchestration handler writes a row per stage transition through this
 * injectable store so a run's progress is durable. On worker boot,
 * {@link reenqueueOrchestrationRuns} reloads every non-terminal run and re-adds
 * its original job, so an orchestration survives a worker restart.
 *
 * The interface keeps the handler unit-testable with an in-memory fake — the
 * Drizzle-backed implementation is only constructed in the worker entrypoint,
 * so tests never touch the database.
 */
import { db } from "@nexus/db";
import { orchestrationRuns } from "@nexus/db/schema";
import { eq, notInArray } from "drizzle-orm";

/**
 * Lifecycle of an orchestration run. Terminal = completed | failed. `blocked`
 * (merge gate failed, §6.3) is NON-terminal on purpose — it stays resumable so the
 * merge can be retried once the evidence exists.
 */
export type OrchestrationStatus =
  "pending" | "running" | "scoring" | "merging" | "blocked" | "completed" | "failed";

/** Statuses from which a run needs no further work. */
export const TERMINAL_STATUSES: readonly OrchestrationStatus[] = ["completed", "failed"];

export function isTerminal(status: OrchestrationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** A persisted orchestration run row (subset the handler reads/writes). */
export interface OrchestrationRunRecord {
  id: string;
  status: OrchestrationStatus;
  task: string;
  /** Original job payload, kept so a non-terminal run can be re-enqueued. */
  payload?: Record<string, unknown> | null;
  candidates?: unknown[];
  scores?: Record<string, number> | null;
  winner?: string | null;
  error?: string | null;
}

/** A partial update; `id` selects the row, other fields are merged in. */
export type OrchestrationRunPatch = Partial<OrchestrationRunRecord> & { id: string };

export interface OrchestrationRunStore {
  /** Insert or update a run by id (stage transition). */
  upsert(patch: OrchestrationRunPatch): Promise<void>;
  /** Fetch a single run by id, or null if absent (for checkpoint resume). */
  get(id: string): Promise<OrchestrationRunRecord | null>;
  /** All runs not in a terminal status (for restart recovery). */
  listNonTerminal(): Promise<OrchestrationRunRecord[]>;
}

/** No-op store — the default when the handler is called without persistence. */
export class NullOrchestrationRunStore implements OrchestrationRunStore {
  async upsert(): Promise<void> {
    /* intentionally does nothing */
  }
  async get(): Promise<OrchestrationRunRecord | null> {
    return null;
  }
  async listNonTerminal(): Promise<OrchestrationRunRecord[]> {
    return [];
  }
}

/** Drizzle/Postgres-backed store. Constructed only in the worker entrypoint. */
export class DrizzleOrchestrationRunStore implements OrchestrationRunStore {
  async upsert(patch: OrchestrationRunPatch): Promise<void> {
    const { id, ...rest } = patch;
    // Build the column set from provided fields only, so a status-only transition
    // doesn't clobber candidates/winner written by an earlier stage.
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (rest.status !== undefined) set.status = rest.status;
    if (rest.task !== undefined) set.task = rest.task;
    if (rest.payload !== undefined) set.payload = rest.payload;
    if (rest.candidates !== undefined) set.candidates = rest.candidates;
    if (rest.scores !== undefined) set.scores = rest.scores;
    if (rest.winner !== undefined) set.winner = rest.winner;
    if (rest.error !== undefined) set.error = rest.error;

    await db
      .insert(orchestrationRuns)
      .values({
        id,
        status: rest.status ?? "pending",
        task: rest.task ?? "",
        payload: rest.payload ?? null,
        candidates: rest.candidates ?? [],
        scores: rest.scores ?? null,
        winner: rest.winner ?? null,
        error: rest.error ?? null,
      })
      .onConflictDoUpdate({ target: orchestrationRuns.id, set });
  }

  async get(id: string): Promise<OrchestrationRunRecord | null> {
    const [r] = await db
      .select()
      .from(orchestrationRuns)
      .where(eq(orchestrationRuns.id, id))
      .limit(1);
    if (!r) return null;
    return {
      id: r.id,
      status: r.status as OrchestrationStatus,
      task: r.task,
      payload: r.payload,
      candidates: r.candidates ?? [],
      scores: r.scores,
      winner: r.winner,
      error: r.error,
    };
  }

  async listNonTerminal(): Promise<OrchestrationRunRecord[]> {
    const rows = await db
      .select()
      .from(orchestrationRuns)
      .where(notInArray(orchestrationRuns.status, [...TERMINAL_STATUSES]));
    return rows.map((r) => ({
      id: r.id,
      status: r.status as OrchestrationStatus,
      task: r.task,
      payload: r.payload,
      candidates: r.candidates ?? [],
      scores: r.scores,
      winner: r.winner,
      error: r.error,
    }));
  }
}

/** Enqueue callback — decoupled from BullMQ so the recovery path is testable. */
export type EnqueueFn = (jobName: string, payload: Record<string, unknown>) => Promise<void>;

/**
 * Re-enqueue every non-terminal orchestration run from its stored payload.
 * Called once on worker boot. Returns the ids that were re-enqueued.
 */
export async function reenqueueOrchestrationRuns(
  store: OrchestrationRunStore,
  enqueue: EnqueueFn,
): Promise<string[]> {
  const runs = await store.listNonTerminal();
  const requeued: string[] = [];
  for (const run of runs) {
    // A run with no stored payload can't be re-run — mark it failed instead of
    // leaving it stuck non-terminal forever.
    if (!run.payload) {
      await store.upsert({ id: run.id, status: "failed", error: "no payload to resume" });
      continue;
    }
    await enqueue("orchestration.run", { ...run.payload, taskId: run.id });
    requeued.push(run.id);
  }
  return requeued;
}
