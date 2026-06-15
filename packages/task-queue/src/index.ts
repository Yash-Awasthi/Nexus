// SPDX-License-Identifier: Apache-2.0
/**
 * task-queue — In-memory task queue modelled after Redis Streams semantics.
 *
 * Since we can't depend on a real Redis in tests, this package provides a
 * fully in-memory implementation with the same API shape as the Redis Streams
 * target — enabling 100% test coverage with zero network dependencies.
 *
 * Provides:
 *   • TaskStatus          — pending | processing | done | failed | delayed
 *   • Task<T>             — typed task envelope
 *   • RetryPolicy         — max retries + backoff
 *   • InMemoryStreamClient — fake Redis Streams backend
 *   • TaskQueue           — consumer-group + delayed + cron abstraction
 *   • CronScheduler       — cron-like periodic task scheduler
 *   • @task() decorator   — method-level task registration helper
 *   • SyncTaskRunner      — synchronous test runner (drains queue immediately)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "processing" | "done" | "failed" | "delayed";

/** Task interface definition. */
export interface Task<T = unknown> {
  id: string;
  name: string;
  payload: T;
  status: TaskStatus;
  createdAt: number;
  runAt?: number; // epoch ms, for delayed tasks
  attempts: number;
  maxRetries: number;
  lastError?: string;
  result?: unknown;
}

/** Enqueue options interface definition. */
export interface EnqueueOptions {
  delayMs?: number;
  maxRetries?: number;
}

/** Consume options interface definition. */
export interface ConsumeOptions {
  groupId?: string;
  batchSize?: number;
}

/** Task handler type alias. */
export type TaskHandler<T = unknown> = (task: Task<T>) => Promise<unknown>;

/** Retry policy interface definition. */
export interface RetryPolicy {
  maxRetries: number;
  backoffMs: (attempt: number) => number;
}

/** Default retry policy. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: (attempt: number) => Math.min(1_000 * Math.pow(2, attempt), 30_000),
};

// ── InMemoryStreamClient ──────────────────────────────────────────────────────

let _taskSeq = 0;

/** In memory stream client. */
export class InMemoryStreamClient {
  private streams = new Map<string, Task[]>();
  private processed = new Map<string, Task>();

  xadd(stream: string, task: Omit<Task, "id">): string {
    const id = `task-${++_taskSeq}`;
    const full: Task = { ...task, id } as Task;
    if (!this.streams.has(stream)) this.streams.set(stream, []);
    this.streams.get(stream)!.push(full);
    return id;
  }

  xread(stream: string, count = 10, minRunAt?: number): Task[] {
    const now = Date.now();
    const tasks = (this.streams.get(stream) ?? []).filter((t) => {
      if (t.status !== "pending" && t.status !== "delayed") return false;
      if (t.runAt && t.runAt > (minRunAt ?? now)) return false;
      return true;
    });
    return tasks.slice(0, count);
  }

  xack(stream: string, taskId: string): void {
    const tasks = this.streams.get(stream);
    if (!tasks) return;
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = "done";
      this.processed.set(taskId, task);
    }
  }

  markFailed(stream: string, taskId: string, error: string): void {
    const tasks = this.streams.get(stream);
    const task = tasks?.find((t) => t.id === taskId);
    if (task) {
      task.status = "failed";
      task.lastError = error;
    }
  }

  updateStatus(stream: string, taskId: string, status: TaskStatus): void {
    const tasks = this.streams.get(stream);
    const task = tasks?.find((t) => t.id === taskId);
    if (task) task.status = status;
  }

  allTasks(stream: string): Task[] {
    return [...(this.streams.get(stream) ?? [])];
  }

  clear(stream?: string): void {
    if (stream) this.streams.delete(stream);
    else this.streams.clear();
  }

  streamNames(): string[] {
    return [...this.streams.keys()];
  }
}

// ── CronScheduler ─────────────────────────────────────────────────────────────

export interface CronEntry {
  name: string;
  intervalMs: number;
  lastRunAt: number;
  handler: () => Promise<void>;
}

/** Cron scheduler. */
export class CronScheduler {
  private entries: CronEntry[] = [];
  private running = false;
  private timer?: ReturnType<typeof setInterval>;

  register(name: string, intervalMs: number, handler: () => Promise<void>): void {
    this.entries.push({ name, intervalMs, lastRunAt: 0, handler });
  }

  async tick(now = Date.now()): Promise<string[]> {
    const ran: string[] = [];
    for (const entry of this.entries) {
      if (now - entry.lastRunAt >= entry.intervalMs) {
        try {
          await entry.handler();
          entry.lastRunAt = now;
          ran.push(entry.name);
        } catch {
          /* isolate */
        }
      }
    }
    return ran;
  }

  start(tickMs = 1_000): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
  entries_(): CronEntry[] {
    return [...this.entries];
  }
  clear(): void {
    this.entries = [];
  }
}

// ── TaskQueue ─────────────────────────────────────────────────────────────────

export class TaskQueue {
  private client: InMemoryStreamClient;
  private stream: string;
  private handlers = new Map<string, TaskHandler>();
  private retryPolicy: RetryPolicy;
  private cron: CronScheduler;

  constructor(stream: string, client?: InMemoryStreamClient, retryPolicy?: RetryPolicy) {
    this.stream = stream;
    this.client = client ?? new InMemoryStreamClient();
    this.retryPolicy = retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.cron = new CronScheduler();
  }

  /** Register a handler for a task type. @task()-like decorator pattern. */
  task<T = unknown>(name: string, handler: TaskHandler<T>): void {
    this.handlers.set(name, handler as TaskHandler);
  }

  /** Enqueue a task (optionally delayed). */
  enqueue<T = unknown>(name: string, payload: T, opts: EnqueueOptions = {}): Task<T> {
    const now = Date.now();
    const runAt = opts.delayMs ? now + opts.delayMs : undefined;
    const status: TaskStatus = runAt ? "delayed" : "pending";
    const id = this.client.xadd(this.stream, {
      name,
      payload,
      status,
      createdAt: now,
      runAt,
      attempts: 0,
      maxRetries: opts.maxRetries ?? this.retryPolicy.maxRetries,
    });
    return this.client.allTasks(this.stream).find((t) => t.id === id) as Task<T>;
  }

  /** Process up to batchSize ready tasks synchronously. */
  async processBatch(opts: ConsumeOptions = {}): Promise<{ processed: number; failed: number }> {
    const tasks = this.client.xread(this.stream, opts.batchSize ?? 10);
    let processed = 0;
    let failed = 0;

    for (const task of tasks) {
      const handler = this.handlers.get(task.name);
      if (!handler) {
        this.client.markFailed(this.stream, task.id, `No handler for task: ${task.name}`);
        failed++;
        continue;
      }

      this.client.updateStatus(this.stream, task.id, "processing");
      task.attempts++;

      try {
        const result = await handler(task);
        (task as Task).result = result;
        this.client.xack(this.stream, task.id);
        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (task.attempts < task.maxRetries) {
          // Schedule retry (mark as delayed with backoff)
          task.status = "delayed";
          task.runAt = Date.now() + this.retryPolicy.backoffMs(task.attempts);
          task.lastError = msg;
          this.client.updateStatus(this.stream, task.id, "delayed");
        } else {
          this.client.markFailed(this.stream, task.id, msg);
          failed++;
        }
      }
    }

    return { processed, failed };
  }

  /** Cron: register a periodic task. */
  cron_(name: string, intervalMs: number, handler: () => Promise<void>): void {
    this.cron.register(name, intervalMs, handler);
  }

  async tickCron(): Promise<string[]> {
    return this.cron.tick();
  }

  getClient(): InMemoryStreamClient {
    return this.client;
  }
  getCron(): CronScheduler {
    return this.cron;
  }

  allTasks(): Task[] {
    return this.client.allTasks(this.stream);
  }
  tasksByStatus(status: TaskStatus): Task[] {
    return this.allTasks().filter((t) => t.status === status);
  }
}

// ── SyncTaskRunner ────────────────────────────────────────────────────────────

/** Drain all pending tasks synchronously — used in tests. */
export class SyncTaskRunner {
  private queue: TaskQueue;

  constructor(queue: TaskQueue) {
    this.queue = queue;
  }

  async drainAll(maxPasses = 10): Promise<{ processed: number; failed: number }> {
    let totalProcessed = 0;
    let totalFailed = 0;
    for (let i = 0; i < maxPasses; i++) {
      const { processed, failed } = await this.queue.processBatch({ batchSize: 100 });
      totalProcessed += processed;
      totalFailed += failed;
      if (processed === 0 && failed === 0) break;
    }
    return { processed: totalProcessed, failed: totalFailed };
  }
}

// ── Redis-backed client + async queue ─────────────────────────────────────────
// ioredis is an optional peer dependency — only instantiate RedisStreamClient
// when REDIS_URL is set and ioredis is installed.

export { RedisStreamClient, AsyncTaskQueue } from "./redis-stream-client.js";
