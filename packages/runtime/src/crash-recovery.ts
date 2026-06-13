// SPDX-License-Identifier: Apache-2.0
/**
 * CrashRecovery — deterministic startup recovery for the @nexus/runtime.
 *
 * Problem:
 *   If the process crashes or is killed while tasks are in "running" state,
 *   those tasks are stuck forever — no worker will pick them up because
 *   BullMQ considers them active.
 *
 * Solution:
 *   On every process startup, CrashRecovery:
 *     1. Reads all persisted task snapshots (via IRecoveryStore)
 *     2. Finds tasks in "running" state that have exceeded the stale threshold
 *     3. Moves stale-running → "queued" (re-enqueue with original priority)
 *     4. Moves tasks that have exhausted retries → "failed"
 *     5. Emits recovery events on the event bus
 *     6. Publishes metrics
 *
 * Idempotency:
 *   Safe to call multiple times. The second call will find no stale tasks
 *   (they were already re-queued by the first call).
 *
 * Crash detection heuristic:
 *   A task is "stale" if it has been in "running" state for longer than
 *   `staleThresholdMs` (default: 5 minutes) without a heartbeat update.
 */

import { randomUUID } from "node:crypto";

import type { IEventBus } from "./event-bus.js";
import type { IMetricsCollector, ITraceRecorder } from "./interfaces/observability.interface.js";
import type { IQueueBackend, QueueJob } from "./interfaces/queue.interface.js";

// ─── Recovery store interface ─────────────────────────────────────────────────

/**
 * IRecoveryStore — minimal persistence adapter for crash recovery.
 *
 * The concrete implementation reads from the Drizzle runtime_tasks table.
 * The MemoryRecoveryStore below is used for tests.
 */
export interface TaskRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "awaiting_approval";
  priority: "low" | "medium" | "high";
  retries: number;
  maxRetries: number;
  startedAt?: Date;
  /** Worker heartbeat timestamp — updated by the worker every 30s */
  lastHeartbeatAt?: Date;
}

export interface IRecoveryStore {
  /** Return all tasks in "running" status */
  getRunningTasks(): Promise<TaskRecord[]>;
  /** Update a task's status */
  updateStatus(taskId: string, status: TaskRecord["status"]): Promise<void>;
  /** Increment a task's retry count */
  incrementRetries(taskId: string): Promise<void>;
}

// ─── Recovery result ──────────────────────────────────────────────────────────

export interface RecoveryResult {
  scanned: number;
  requeued: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface CrashRecoveryConfig {
  store: IRecoveryStore;
  queue: IQueueBackend;
  eventBus: IEventBus;
  metrics?: IMetricsCollector;
  tracer?: ITraceRecorder;
  /**
   * A task stuck in "running" for longer than this is considered crashed.
   * Default: 5 minutes.
   */
  staleThresholdMs?: number;
}

// ─── CrashRecovery ────────────────────────────────────────────────────────────

export class CrashRecovery {
  private readonly store: IRecoveryStore;
  private readonly queue: IQueueBackend;
  private readonly eventBus: IEventBus;
  private readonly metrics?: IMetricsCollector;
  private readonly tracer?: ITraceRecorder;
  private readonly staleThresholdMs: number;

  constructor(config: CrashRecoveryConfig) {
    this.store = config.store;
    this.queue = config.queue;
    this.eventBus = config.eventBus;
    this.metrics = config.metrics;
    this.tracer = config.tracer;
    this.staleThresholdMs = config.staleThresholdMs ?? 5 * 60 * 1000;
  }

  /**
   * Run crash recovery. Call once on startup, before accepting new work.
   *
   * Returns a summary of what was recovered.
   */
  async recover(): Promise<RecoveryResult> {
    const startedAt = Date.now();
    const span = this.tracer?.startSpan("crash_recovery.run");

    const running = await this.store.getRunningTasks();

    let requeued = 0;
    let failed = 0;
    let skipped = 0;
    const now = Date.now();

    for (const task of running) {
      const staleRef = task.lastHeartbeatAt ?? task.startedAt;

      if (!staleRef) {
        // No start time — definitely stale, re-queue it
        const wasRequeued = await this.handleStale(task, now);
        if (wasRequeued) {
          requeued++;
        } else {
          failed++;
        }
        continue;
      }

      const staleDuration = now - staleRef.getTime();
      if (staleDuration < this.staleThresholdMs) {
        // Still within threshold — worker may still be alive, skip
        skipped++;
        continue;
      }

      const wasRequeued = await this.handleStale(task, now);
      if (wasRequeued) {
        requeued++;
      } else {
        failed++;
      }
    }

    const durationMs = Date.now() - startedAt;
    const result: RecoveryResult = {
      scanned: running.length,
      requeued,
      failed,
      skipped,
      durationMs,
    };

    // Metrics
    this.metrics?.recordGauge("nexus.recovery.scanned", result.scanned, { phase: "startup" });
    this.metrics?.recordGauge("nexus.recovery.requeued", result.requeued, { phase: "startup" });
    this.metrics?.recordGauge("nexus.recovery.failed", result.failed, { phase: "startup" });
    this.metrics?.recordTiming("nexus.recovery.duration_ms", durationMs, { phase: "startup" });

    // Event
    if (requeued > 0 || failed > 0) {
      await this.eventBus.publish("nexus.runtime.crash_recovery", {
        event_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        version: "1.0.0",
        scanned: result.scanned,
        requeued: result.requeued,
        failed: result.failed,
        skipped: result.skipped,
        duration_ms: durationMs,
      });
    }

    if (span) this.tracer?.endSpan(span.spanId, result as unknown as Record<string, unknown>);

    return result;
  }

  /** Returns true if the task was re-queued, false if it was moved to failed. */
  private async handleStale(task: TaskRecord, nowMs: number): Promise<boolean> {
    const exceededRetries = task.retries >= task.maxRetries;

    if (exceededRetries) {
      // Move to failed — no more retries available
      await this.store.updateStatus(task.id, "failed");
      await this.eventBus.publish("nexus.tasks.failed", {
        event_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        version: "1.0.0",
        task_id: task.id,
        error: "Task exceeded max retries during crash recovery",
        retries_exhausted: true,
      });
      return false;
    }

    // Increment retry count, reset to queued, re-enqueue
    await this.store.incrementRetries(task.id);
    await this.store.updateStatus(task.id, "queued");

    const job: QueueJob = {
      id: task.id,
      payload: task.payload,
      priority: task.priority,
      retries: task.retries + 1,
      maxRetries: task.maxRetries,
      createdAt: new Date(),
    };

    await this.queue.push(job);

    await this.eventBus.publish("nexus.tasks.recovered", {
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      version: "1.0.0",
      task_id: task.id,
      task_type: task.type,
      priority: task.priority,
      retries: task.retries + 1,
      max_retries: task.maxRetries,
      stale_duration_ms: task.startedAt ? nowMs - task.startedAt.getTime() : null,
    });
    return true;
  }
}

// ─── MemoryRecoveryStore — for tests ─────────────────────────────────────────

export class MemoryRecoveryStore implements IRecoveryStore {
  private tasks = new Map<string, TaskRecord>();

  /** Seed tasks directly for tests */
  seed(task: TaskRecord): void {
    this.tasks.set(task.id, { ...task });
  }

  async getRunningTasks(): Promise<TaskRecord[]> {
    return Array.from(this.tasks.values()).filter((t) => t.status === "running");
  }

  async updateStatus(taskId: string, status: TaskRecord["status"]): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) task.status = status;
  }

  async incrementRetries(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) task.retries++;
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }
}
