// SPDX-License-Identifier: Apache-2.0
/**
 * RedisStreamClient — ioredis-backed async stream client that mirrors the
 * InMemoryStreamClient API shape (with async methods).
 *
 * Data layout in Redis:
 *   nexus:task:{id}            — JSON-serialised Task (STRING)
 *   nexus:stream:{name}:ids    — ordered list of task IDs (LIST, RPUSH)
 *   nexus:streams              — known stream names (SET)
 *   nexus:task:seq             — monotonic counter for task IDs (STRING/INCR)
 *
 * Use AsyncTaskQueue to drive a RedisStreamClient.
 *
 * @example
 * ```ts
 * import { RedisStreamClient, AsyncTaskQueue } from "@nexus/task-queue";
 *
 * const client = new RedisStreamClient(process.env.REDIS_URL!);
 * const queue  = new AsyncTaskQueue("nexus:jobs", client);
 * queue.task("send-email", async (t) => { ... });
 * await queue.enqueue("send-email", { to: "user@example.com" });
 * await queue.processBatch({ batchSize: 10 });
 * await client.quit();
 * ```
 */

import type { Task, TaskStatus } from "./index.js";

// Lazy import ioredis — avoids hard dependency in tests that don't use Redis.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RedisClass: any = null;

async function getRedis(url: string): Promise<import("ioredis").Redis> {
  if (!RedisClass) {
    const mod = await import("ioredis");
    RedisClass = mod.default ?? mod.Redis;
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  return new RedisClass(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
}

// ── RedisStreamClient ─────────────────────────────────────────────────────────

let _globalSeq = 0;

export class RedisStreamClient {
  private redisUrl: string;
  private _redis: import("ioredis").Redis | null = null;
  private _ready: Promise<import("ioredis").Redis> | null = null;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  private async redis(): Promise<import("ioredis").Redis> {
    if (!this._ready) {
      this._ready = getRedis(this.redisUrl).then(async (r) => {
        await r.connect();
        this._redis = r;
        return r;
      });
    }
    return this._ready;
  }

  /** Add a task to the stream. Returns the generated task id. */
  async xadd(stream: string, task: Omit<Task, "id">): Promise<string> {
    const r = await this.redis();
    const seq = await r.incr("nexus:task:seq").catch(() => ++_globalSeq);
    const id = `task-${seq}`;
    const full: Task = { ...task, id } as Task;
    await Promise.all([
      r.set(`nexus:task:${id}`, JSON.stringify(full)),
      r.rpush(`nexus:stream:${stream}:ids`, id),
      r.sadd("nexus:streams", stream),
    ]);
    return id;
  }

  /** Read up to `count` ready tasks from the stream. */
  async xread(stream: string, count = 10, minRunAt?: number): Promise<Task[]> {
    const r = await this.redis();
    const now = Date.now();
    const ids = await r.lrange(`nexus:stream:${stream}:ids`, 0, -1);
    const tasks: Task[] = [];

    for (const id of ids) {
      if (tasks.length >= count) break;
      const raw = await r.get(`nexus:task:${id}`);
      if (!raw) continue;
      const t = JSON.parse(raw) as Task;
      if (t.status !== "pending" && t.status !== "delayed") continue;
      if (t.runAt && t.runAt > (minRunAt ?? now)) continue;
      tasks.push(t);
    }

    return tasks;
  }

  /** Acknowledge a task (mark as done). */
  async xack(stream: string, taskId: string): Promise<void> {
    await this._updateTask(stream, taskId, (t) => ({ ...t, status: "done" as TaskStatus }));
  }

  /** Mark a task as failed with an error message. */
  async markFailed(stream: string, taskId: string, error: string): Promise<void> {
    await this._updateTask(stream, taskId, (t) => ({ ...t, status: "failed" as TaskStatus, lastError: error }));
  }

  /** Update the status of a task. */
  async updateStatus(stream: string, taskId: string, status: TaskStatus): Promise<void> {
    await this._updateTask(stream, taskId, (t) => ({ ...t, status }));
  }

  /** Return all tasks for a stream (any status). */
  async allTasks(stream: string): Promise<Task[]> {
    const r = await this.redis();
    const ids = await r.lrange(`nexus:stream:${stream}:ids`, 0, -1);
    const tasks: Task[] = [];
    for (const id of ids) {
      const raw = await r.get(`nexus:task:${id}`);
      if (raw) tasks.push(JSON.parse(raw) as Task);
    }
    return tasks;
  }

  /** Return all known stream names. */
  async streamNames(): Promise<string[]> {
    const r = await this.redis();
    return r.smembers("nexus:streams");
  }

  /** Clear one stream or all streams. */
  async clear(stream?: string): Promise<void> {
    const r = await this.redis();
    if (stream) {
      const ids = await r.lrange(`nexus:stream:${stream}:ids`, 0, -1);
      const keys = ids.map((id) => `nexus:task:${id}`);
      if (keys.length) await r.del(...keys);
      await r.del(`nexus:stream:${stream}:ids`);
      await r.srem("nexus:streams", stream);
    } else {
      const streams = await r.smembers("nexus:streams");
      for (const s of streams) {
        await this.clear(s);
      }
      await r.del("nexus:streams");
    }
  }

  /** Close the Redis connection. */
  async quit(): Promise<void> {
    if (this._redis) {
      await this._redis.quit();
      this._redis = null;
      this._ready = null;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async _updateTask(
    _stream: string,
    taskId: string,
    updater: (t: Task) => Task,
  ): Promise<void> {
    const r = await this.redis();
    const raw = await r.get(`nexus:task:${taskId}`);
    if (!raw) return;
    const updated = updater(JSON.parse(raw) as Task);
    await r.set(`nexus:task:${taskId}`, JSON.stringify(updated));
  }
}

// ── AsyncTaskQueue — drives a RedisStreamClient ───────────────────────────────

import type { TaskHandler, EnqueueOptions, ConsumeOptions, RetryPolicy } from "./index.js";
import { DEFAULT_RETRY_POLICY } from "./index.js";

export class AsyncTaskQueue {
  private client: RedisStreamClient;
  private stream: string;
  private handlers = new Map<string, TaskHandler>();
  private retryPolicy: RetryPolicy;

  constructor(stream: string, client: RedisStreamClient, retryPolicy?: RetryPolicy) {
    this.stream = stream;
    this.client = client;
    this.retryPolicy = retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  task<T = unknown>(name: string, handler: TaskHandler<T>): void {
    this.handlers.set(name, handler as TaskHandler);
  }

  async enqueue<T = unknown>(name: string, payload: T, opts: EnqueueOptions = {}): Promise<Task<T>> {
    const now = Date.now();
    const runAt = opts.delayMs ? now + opts.delayMs : undefined;
    const status: Task["status"] = runAt ? "delayed" : "pending";
    const id = await this.client.xadd(this.stream, {
      name,
      payload,
      status,
      createdAt: now,
      runAt,
      attempts: 0,
      maxRetries: opts.maxRetries ?? this.retryPolicy.maxRetries,
    });
    const all = await this.client.allTasks(this.stream);
    return all.find((t) => t.id === id) as Task<T>;
  }

  async processBatch(opts: ConsumeOptions = {}): Promise<{ processed: number; failed: number }> {
    const tasks = await this.client.xread(this.stream, opts.batchSize ?? 10);
    let processed = 0;
    let failed = 0;

    for (const task of tasks) {
      const handler = this.handlers.get(task.name);
      if (!handler) {
        await this.client.markFailed(this.stream, task.id, `No handler for task: ${task.name}`);
        failed++;
        continue;
      }

      await this.client.updateStatus(this.stream, task.id, "processing");
      task.attempts++;

      try {
        await handler(task);
        await this.client.xack(this.stream, task.id);
        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (task.attempts < task.maxRetries) {
          task.status = "delayed";
          task.runAt = Date.now() + this.retryPolicy.backoffMs(task.attempts);
          task.lastError = msg;
          await this.client.updateStatus(this.stream, task.id, "delayed");
        } else {
          await this.client.markFailed(this.stream, task.id, msg);
          failed++;
        }
      }
    }

    return { processed, failed };
  }

  async allTasks(): Promise<Task[]> {
    return this.client.allTasks(this.stream);
  }

  getClient(): RedisStreamClient {
    return this.client;
  }
}
