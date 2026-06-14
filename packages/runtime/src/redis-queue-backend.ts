// SPDX-License-Identifier: Apache-2.0
/**
 * RedisQueueBackend — production IQueueBackend implementation backed by
 * BullMQ on Redis 7 (ADR-0007, ADR-0012).
 *
 * Design:
 *  - One BullMQ Queue per priority tier (high / medium / low).
 *    BullMQ handles priority ordering natively within a queue, but we
 *    explicitly fan out across three queues so workers can consume
 *    them with weighted concurrency policies.
 *  - The dead-letter queue (DLQ) is a separate BullMQ Queue: "nexus-dlq".
 *    Jobs land there via `moveToDeadLetter`; they are not BullMQ's built-in
 *    failed state so we retain full metadata control.
 *  - `getActiveJobs` returns currently-active (running) BullMQ jobs across
 *    all three priority queues.
 *  - `getDeadLetterQueue` returns all DLQ jobs with their original payload.
 *
 * Connection:
 *  Pass a Redis connection string or an ioredis-compatible config object.
 *  The backend lazily creates a single shared IORedis connection used by
 *  all BullMQ instances (per BullMQ best practice).
 *
 * Lifecycle:
 *  Always call `close()` before process exit to drain connections cleanly.
 */

import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";

import type { IQueueBackend, QueueJob } from "./interfaces/queue.interface.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const QUEUE_HIGH = "nexus-high";
const QUEUE_MEDIUM = "nexus-medium";
const QUEUE_LOW = "nexus-low";
const QUEUE_DLQ = "nexus-dlq";

const PRIORITY_TO_QUEUE: Record<QueueJob["priority"], string> = {
  high: QUEUE_HIGH,
  medium: QUEUE_MEDIUM,
  low: QUEUE_LOW,
};

/** BullMQ numeric priority: lower = higher priority. We invert our enum. */
const BULLMQ_PRIORITY: Record<QueueJob["priority"], number> = {
  high: 1,
  medium: 2,
  low: 3,
};

// ─── Backend ──────────────────────────────────────────────────────────────────

export interface RedisQueueBackendOptions {
  connection: ConnectionOptions;
  /** Default job TTL in the DLQ before auto-removal. Default: 7 days (ms). */
  dlqRetentionMs?: number;
}

export class RedisQueueBackend implements IQueueBackend {
  private readonly queues: Record<string, Queue>;
  private readonly dlq: Queue;
  private readonly connection: ConnectionOptions;

  constructor(private readonly options: RedisQueueBackendOptions) {
    this.connection = options.connection;

    const sharedOpts = { connection: this.connection };

    this.queues = {
      [QUEUE_HIGH]: new Queue(QUEUE_HIGH, sharedOpts),
      [QUEUE_MEDIUM]: new Queue(QUEUE_MEDIUM, sharedOpts),
      [QUEUE_LOW]: new Queue(QUEUE_LOW, sharedOpts),
    };

    this.dlq = new Queue(QUEUE_DLQ, sharedOpts);
  }

  /** Push a job into the appropriate priority queue. */
  async push(job: QueueJob): Promise<void> {
    if (job.retries >= job.maxRetries) {
      await this.moveToDeadLetter(job, "Retry attempts exhausted before enqueue");
      return;
    }

    const queueName = PRIORITY_TO_QUEUE[job.priority] ?? QUEUE_MEDIUM;
    const queue = this.queues[queueName];
    if (!queue) throw new Error(`Unknown queue: ${queueName}`);

    const dlqRetentionMs = this.options.dlqRetentionMs ?? 7 * 24 * 60 * 60 * 1000;

    await queue.add(
      job.id, // name = job id for traceability
      {
        nexusJobId: job.id,
        payload: job.payload,
        priority: job.priority,
        retries: job.retries,
        maxRetries: job.maxRetries,
        createdAt: job.createdAt.toISOString(),
      },
      {
        jobId: job.id,
        priority: BULLMQ_PRIORITY[job.priority],
        attempts: Math.max(1, job.maxRetries - job.retries),
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: dlqRetentionMs / 1000 },
      },
    );
  }

  /**
   * Pop a job from the highest-priority non-empty queue.
   *
   * Note: this uses BullMQ's `drain` + `getJobs` approach for inspection.
   * For actual worker consumption, use BullMQ Worker directly — this method
   * is provided for compatibility with the IQueueBackend interface and is
   * suitable for test scenarios.
   */
  async pop(): Promise<QueueJob | undefined> {
    // Check queues in priority order
    for (const queueName of [QUEUE_HIGH, QUEUE_MEDIUM, QUEUE_LOW]) {
      const queue = this.queues[queueName];
      if (!queue) continue;

      const waiting = await queue.getJobs(["waiting"], 0, 0);
      const job = waiting[0];
      if (!job) continue;

      // Remove from waiting and return as QueueJob
      await job.remove();

      return {
        id: job.data.nexusJobId as string,
        payload: job.data.payload,
        priority: job.data.priority as QueueJob["priority"],
        retries: job.data.retries as number,
        maxRetries: job.data.maxRetries as number,
        createdAt: new Date(job.data.createdAt as string),
      };
    }

    return undefined;
  }

  /** Move a job to the dead-letter queue with an error annotation. */
  async moveToDeadLetter(job: QueueJob, error: string): Promise<void> {
    // Remove from source queue if it's still there
    const queueName = PRIORITY_TO_QUEUE[job.priority] ?? QUEUE_MEDIUM;
    const sourceQueue = this.queues[queueName];
    if (sourceQueue) {
      const existing = await sourceQueue.getJob(job.id);
      if (existing) await existing.remove();
    }

    const dlqRetentionMs = this.options.dlqRetentionMs ?? 7 * 24 * 60 * 60 * 1000;

    await this.dlq.add(
      job.id,
      {
        nexusJobId: job.id,
        payload: job.payload,
        priority: job.priority,
        retries: job.retries,
        maxRetries: job.maxRetries,
        createdAt: job.createdAt.toISOString(),
        dlqError: error,
        dlqAt: new Date().toISOString(),
      },
      {
        jobId: `dlq-${job.id}`,
        removeOnComplete: false,
        removeOnFail: { age: dlqRetentionMs / 1000 },
      },
    );
  }

  /** Return all jobs currently in the DLQ. */
  async getDeadLetterQueue(): Promise<QueueJob[]> {
    const jobs = await this.dlq.getJobs(["waiting", "delayed", "failed"]);
    return jobs.map((j: { data: Record<string, unknown> }) => ({
      id: j.data.nexusJobId as string,
      payload: j.data.payload,
      priority: j.data.priority as QueueJob["priority"],
      retries: j.data.retries as number,
      maxRetries: j.data.maxRetries as number,
      createdAt: new Date(j.data.createdAt as string),
    }));
  }

  /** Remove all jobs from the DLQ. */
  async clearDeadLetterQueue(): Promise<void> {
    await this.dlq.drain();
  }

  /** Total waiting + delayed jobs across all priority queues. */
  async getQueueLength(): Promise<number> {
    let total = 0;
    for (const queue of Object.values(this.queues)) {
      total += await queue.count();
    }
    return total;
  }

  /** Return currently-active (running) jobs across all priority queues. */
  async getActiveJobs(): Promise<QueueJob[]> {
    const result: QueueJob[] = [];

    for (const queue of Object.values(this.queues)) {
      const active = await queue.getJobs(["active"]);
      for (const j of active) {
        result.push({
          id: j.data.nexusJobId as string,
          payload: j.data.payload,
          priority: j.data.priority as QueueJob["priority"],
          retries: j.data.retries as number,
          maxRetries: j.data.maxRetries as number,
          createdAt: new Date(j.data.createdAt as string),
        });
      }
    }

    return result;
  }

  /**
   * Gracefully close all queue connections.
   * Must be called before process.exit() to avoid hanging connections.
   */
  async close(): Promise<void> {
    await Promise.all([...Object.values(this.queues).map((q) => q.close()), this.dlq.close()]);
  }

  /**
   * Factory helper — creates a backend from a Redis URL string.
   *
   * @example
   *   const backend = RedisQueueBackend.fromUrl("redis://localhost:6379");
   */
  static fromUrl(
    redisUrl: string,
    opts?: Omit<RedisQueueBackendOptions, "connection">,
  ): RedisQueueBackend {
    const url = new URL(redisUrl);
    const connection: ConnectionOptions = {
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : 6379,
      password: url.password || undefined,
      db: url.pathname ? parseInt(url.pathname.slice(1), 10) || 0 : 0,
      tls: url.protocol === "rediss:" ? {} : undefined,
    };
    return new RedisQueueBackend({ connection, ...opts });
  }
}
