// SPDX-License-Identifier: Apache-2.0
/**
 * RedisStreamClient — ioredis-backed client using real Redis Streams.
 *
 * Data layout in Redis:
 *   nexus:stream:{name}        — Redis Stream (XADD / XREADGROUP / XACK)
 *   nexus:task:{msgId}         — STRING: full Task JSON (random-access by id)
 *   nexus:streams              — SET: known stream names
 *   nexus:failed:{name}        — HASH: msgId → Task JSON (dead-letter store)
 *   nexus:dlq:{name}           — Redis Stream: dead-letter audit trail
 *
 * Consumer group: "nexus-workers"
 * Consumer name:  "worker-{pid}" by default (configurable)
 *
 * Key improvements over the previous LIST-based approach:
 *   • XADD writes: each task gets a stream-native monotonic message ID
 *   • XREADGROUP: at-least-once delivery with consumer group tracking
 *   • PEL (Pending Entry List): messages in flight are tracked automatically
 *   • XAUTOCLAIM: re-delivers messages idle > 30s (crashed-worker recovery)
 *   • XACK: removes from PEL, confirming successful processing
 *   • Dead-letter: failed tasks are XACKed out of PEL and moved to nexus:dlq:{name}
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

// ── ioredis lazy import ───────────────────────────────────────────────────────

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

const CONSUMER_GROUP    = "nexus-workers";
const STALE_IDLE_MS     = 30_000; // reclaim messages idle > 30s

export class RedisStreamClient {
  private redisUrl: string;
  private consumer: string;
  private _redis: import("ioredis").Redis | null = null;
  private _ready: Promise<import("ioredis").Redis> | null = null;
  /** Track which streams already have the consumer group so we skip CREATE on hot path */
  private _groupsCreated = new Set<string>();

  constructor(redisUrl: string, consumer?: string) {
    this.redisUrl = redisUrl;
    this.consumer = consumer ?? `worker-${process.pid}`;
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

  private streamKey(name: string): string { return `nexus:stream:${name}`; }
  private failedKey(name: string): string { return `nexus:failed:${name}`; }
  private dlqKey(name: string): string    { return `nexus:dlq:${name}`; }
  private taskKey(msgId: string): string  { return `nexus:task:${msgId}`; }

  /**
   * Ensure the consumer group exists for this stream.
   * MKSTREAM creates the stream if it doesn't exist yet.
   * BUSYGROUP error means the group already exists — safe to ignore.
   */
  private async ensureGroup(stream: string): Promise<void> {
    if (this._groupsCreated.has(stream)) return;
    const r = await this.redis();
    try {
      await r.xgroup("CREATE", this.streamKey(stream), CONSUMER_GROUP, "0", "MKSTREAM");
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
    this._groupsCreated.add(stream);
  }

  /**
   * Append a task to the stream using XADD.
   * Returns the Redis stream message ID (e.g. "1718000000000-0") which becomes task.id.
   */
  async xadd(stream: string, task: Omit<Task, "id">): Promise<string> {
    await this.ensureGroup(stream);
    const r = await this.redis();

    // XADD nexus:stream:{name} * task {json}
    const msgId = await r.xadd(
      this.streamKey(stream),
      "*",           // auto-generate message ID
      "task", JSON.stringify(task),
    ) as string;

    if (!msgId) throw new Error(`RedisStreamClient: XADD returned null for stream "${stream}"`);

    // Store full task with resolved id for random-access lookups
    const full: Task = { ...(task as Task), id: msgId };
    await Promise.all([
      r.set(this.taskKey(msgId), JSON.stringify(full)),
      r.sadd("nexus:streams", stream),
    ]);

    return msgId;
  }

  /**
   * Read up to `count` tasks using XREADGROUP (consumer group delivery).
   * Attempts XAUTOCLAIM first to recover stale messages from crashed workers,
   * then falls through to XREADGROUP ">" for fresh messages.
   */
  async xread(stream: string, count = 10, _minRunAt?: number): Promise<Task[]> {
    await this.ensureGroup(stream);
    const r = await this.redis();
    const key = this.streamKey(stream);
    const tasks: Task[] = [];

    // ── 1. Reclaim stale messages (idle > STALE_IDLE_MS) ──────────────────
    try {
      // XAUTOCLAIM stream group consumer min-idle-time start COUNT count
      // Returns: [nextId, [[msgId, [field, val, ...]], ...], [deletedIds]]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const claimed = await (r as any).xautoclaim(
        key, CONSUMER_GROUP, this.consumer,
        STALE_IDLE_MS, "0-0",
        "COUNT", count,
      ) as [string, [string, string[]][], string[]?] | null;

      if (claimed && claimed[1]?.length) {
        for (const [msgId, fields] of claimed[1]) {
          const task = await this._resolveTask(r, msgId, fields);
          if (task && tasks.length < count) tasks.push(task);
        }
      }
    } catch {
      // XAUTOCLAIM requires Redis 6.2+ — fall through if not available
    }

    if (tasks.length >= count) return tasks;

    // ── 2. Read new messages with XREADGROUP ──────────────────────────────
    // ">" means deliver messages not yet delivered to any consumer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (r as any).xreadgroup(
      "GROUP", CONSUMER_GROUP, this.consumer,
      "COUNT", count - tasks.length,
      "STREAMS", key, ">",
    ) as [string, [string, string[]][]][] | null;

    if (results) {
      for (const [, messages] of results) {
        for (const [msgId, fields] of messages) {
          if (tasks.length >= count) break;
          const task = await this._resolveTask(r, msgId, fields);
          if (task) tasks.push(task);
        }
      }
    }

    return tasks;
  }

  /**
   * Acknowledge a task: XACK removes it from the PEL.
   * Also deletes the task lookup key.
   */
  async xack(stream: string, taskId: string): Promise<void> {
    const r = await this.redis();
    await Promise.all([
      r.xack(this.streamKey(stream), CONSUMER_GROUP, taskId),
      r.del(this.taskKey(taskId)),
    ]);
  }

  /**
   * Mark a task as failed:
   *   1. XACK to remove from PEL (stop re-delivery)
   *   2. HSET to dead-letter hash for inspection
   *   3. XADD to dead-letter audit stream
   */
  async markFailed(stream: string, taskId: string, error: string): Promise<void> {
    const r = await this.redis();
    const raw = await r.get(this.taskKey(taskId));
    const task: Task = raw
      ? { ...(JSON.parse(raw) as Task), status: "failed" as TaskStatus, lastError: error }
      : { id: taskId, name: "unknown", payload: null, status: "failed", createdAt: Date.now(), attempts: 0, maxRetries: 0 } as unknown as Task;

    await Promise.all([
      r.xack(this.streamKey(stream), CONSUMER_GROUP, taskId),
      r.hset(this.failedKey(stream), taskId, JSON.stringify(task)),
      r.xadd(this.dlqKey(stream), "*", "taskId", taskId, "error", error, "failedAt", String(Date.now())),
      r.del(this.taskKey(taskId)),
    ]);
  }

  /** Update the persisted task status (used by AsyncTaskQueue during processing). */
  async updateStatus(stream: string, taskId: string, status: TaskStatus): Promise<void> {
    const r = await this.redis();
    const raw = await r.get(this.taskKey(taskId));
    if (!raw) return;
    const updated: Task = { ...(JSON.parse(raw) as Task), status };
    await r.set(this.taskKey(taskId), JSON.stringify(updated));
    // If marking as delayed, also store runAt for visibility
    void stream; // stream context not needed for key lookup
  }

  /**
   * Return all tasks for a stream (any status).
   * Uses XRANGE to enumerate message IDs, then GET for each task.
   * Failed tasks are sourced from the dead-letter HASH.
   */
  async allTasks(stream: string): Promise<Task[]> {
    const r = await this.redis();
    const tasks: Task[] = [];

    // Active tasks via XRANGE (includes delivered + pending)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = await (r as any).xrange(
      this.streamKey(stream), "-", "+",
    ) as [string, string[]][] | null;

    if (entries) {
      for (const [msgId] of entries) {
        const raw = await r.get(this.taskKey(msgId));
        if (raw) tasks.push(JSON.parse(raw) as Task);
      }
    }

    // Failed tasks from dead-letter hash
    const failedMap = await r.hgetall(this.failedKey(stream)) ?? {};
    for (const raw of Object.values(failedMap)) {
      const t = JSON.parse(raw) as Task;
      // Avoid duplicates (shouldn't happen but guard anyway)
      if (!tasks.find((x) => x.id === t.id)) tasks.push(t);
    }

    return tasks;
  }

  /** Return all known stream names. */
  async streamNames(): Promise<string[]> {
    const r = await this.redis();
    return r.smembers("nexus:streams");
  }

  /** Clear one stream or all streams (including dead-letter data). */
  async clear(stream?: string): Promise<void> {
    const r = await this.redis();
    if (stream) {
      const key = this.streamKey(stream);
      // XRANGE to get all msgIds for task key cleanup
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries = await (r as any).xrange(key, "-", "+") as [string, string[]][] | null;
      if (entries?.length) {
        const taskKeys = entries.map(([msgId]) => this.taskKey(msgId));
        await r.del(...taskKeys);
      }
      await Promise.all([
        r.del(key),
        r.del(this.failedKey(stream)),
        r.del(this.dlqKey(stream)),
        r.srem("nexus:streams", stream),
      ]);
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

  /**
   * Resolve a task from its message ID.
   * Prefers the task lookup key (which has the latest status) over the stream payload.
   */
  private async _resolveTask(
    r: import("ioredis").Redis,
    msgId: string,
    fields: string[],
  ): Promise<Task | null> {
    // First try the task lookup key (has updated status / attempts)
    const stored = await r.get(this.taskKey(msgId));
    if (stored) {
      return { ...(JSON.parse(stored) as Task), id: msgId };
    }

    // Fall back to parsing the stream payload
    const taskIdx = fields.indexOf("task");
    if (taskIdx === -1) return null;
    try {
      const parsed = JSON.parse(fields[taskIdx + 1]!) as Partial<Task>;
      return { ...parsed, id: msgId } as Task;
    } catch {
      return null;
    }
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
