// SPDX-License-Identifier: Apache-2.0
/**
 * FileQueueBackend — a persistent IQueueBackend implementation.
 *
 * Queued jobs and dead-letter entries survive process restarts because the
 * state is stored in two JSONL files on disk.  The in-memory array is always
 * the source of truth for ordering; the files are the durable representation.
 *
 * File format (JSONL — one JSON object per line):
 *   queue.jsonl       — active jobs
 *   queue-dlq.jsonl   — dead-letter jobs
 *
 * Crash recovery behaviour
 * ─────────────────────────
 * On construction/init() the backend reads both files into memory.
 * Any line that cannot be parsed is silently dropped (corrupted line resilience).
 * Dates stored as ISO strings are revived back to Date objects.
 *
 * Write strategy
 * ──────────────
 * After every mutating operation the active queue (or DLQ) is rewritten atomically
 * using a write-to-temp-file-then-rename pattern so a crash mid-write never leaves
 * a corrupt file.
 */

import * as fs from "fs";
import * as path from "path";

import type { IMetricsCollector } from "./interfaces/observability.interface.js";
import type { IQueueBackend, QueueJob } from "./interfaces/queue.interface.js";

const PRIORITY_WEIGHTS: Record<string, number> = { high: 3, medium: 2, low: 1 };

export class FileQueueBackend implements IQueueBackend {
  private readonly queuePath: string;
  private readonly dlqPath: string;
  private activeQueue: QueueJob[] = [];
  private deadLetterQueue: QueueJob[] = [];
  private _initialized = false;
  private metrics?: IMetricsCollector;

  constructor(dataDir: string, metrics?: IMetricsCollector) {
    this.queuePath = path.join(dataDir, "queue.jsonl");
    this.dlqPath = path.join(dataDir, "queue-dlq.jsonl");
    this.metrics = metrics;
  }

  private _emitQueueMetrics(): void {
    if (!this.metrics) return;
    this.metrics.recordGauge("queue.active_length", this.activeQueue.length);
    this.metrics.recordGauge("queue.dlq_length", this.deadLetterQueue.length);
  }

  private _countPush(): void {
    this.metrics?.increment("queue.push_total");
  }

  private _countPop(): void {
    this.metrics?.increment("queue.pop_total");
  }

  /**
   * Load persisted state from disk. Must be called once before using the backend.
   * Safe to call multiple times (idempotent after first call).
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    const dir = path.dirname(this.queuePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.activeQueue = this._readJobsFromFile(this.queuePath);
    this.deadLetterQueue = this._readJobsFromFile(this.dlqPath);
  }

  private _readJobsFromFile(filePath: string): QueueJob[] {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    const jobs: QueueJob[] = [];
    for (const line of lines) {
      try {
        const raw = JSON.parse(line);
        // Revive Date fields
        if (typeof raw.createdAt === "string") {
          raw.createdAt = new Date(raw.createdAt);
        }
        jobs.push(raw as QueueJob);
      } catch {
        // Corrupt line — skip silently
      }
    }
    return jobs;
  }

  private _writeJobsToFile(filePath: string, jobs: QueueJob[]): void {
    const tmpPath = `${filePath}.tmp`;
    const content = jobs.map((j) => JSON.stringify(j)).join("\n") + (jobs.length ? "\n" : "");
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filePath);
  }

  private _ensureInit(): void {
    if (!this._initialized) {
      // Synchronous fallback if someone forgets to call init()
      this.activeQueue = this._readJobsFromFile(this.queuePath);
      this.deadLetterQueue = this._readJobsFromFile(this.dlqPath);
      this._initialized = true;
    }
  }

  async push(job: QueueJob): Promise<void> {
    this._ensureInit();
    if (job.retries >= job.maxRetries) {
      await this.moveToDeadLetter(job, "Retry attempts exhausted");
      return;
    }
    this.activeQueue.push(job);
    this._writeJobsToFile(this.queuePath, this.activeQueue);
    this._countPush();
    this._emitQueueMetrics();
  }

  async pop(): Promise<QueueJob | undefined> {
    this._ensureInit();
    if (this.activeQueue.length === 0) return undefined;

    // Sort by priority (desc) then by creation time (asc — FIFO within priority)
    this.activeQueue.sort((a, b) => {
      const wa = PRIORITY_WEIGHTS[a.priority] ?? 0;
      const wb = PRIORITY_WEIGHTS[b.priority] ?? 0;
      if (wa !== wb) return wb - wa;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    const job = this.activeQueue.shift()!;
    this._writeJobsToFile(this.queuePath, this.activeQueue);
    this._countPop();
    this._emitQueueMetrics();
    return job;
  }

  async moveToDeadLetter(job: QueueJob, _error: string): Promise<void> {
    this._ensureInit();
    this.activeQueue = this.activeQueue.filter((j) => j.id !== job.id);
    this.deadLetterQueue.push(job);
    this._writeJobsToFile(this.queuePath, this.activeQueue);
    this._writeJobsToFile(this.dlqPath, this.deadLetterQueue);
    this._emitQueueMetrics();
    this.metrics?.increment("queue.dlq_total");
  }

  async getDeadLetterQueue(): Promise<QueueJob[]> {
    this._ensureInit();
    return this.deadLetterQueue;
  }

  async clearDeadLetterQueue(): Promise<void> {
    this._ensureInit();
    this.deadLetterQueue = [];
    this._writeJobsToFile(this.dlqPath, []);
  }

  async getQueueLength(): Promise<number> {
    this._ensureInit();
    return this.activeQueue.length;
  }

  async getActiveJobs(): Promise<QueueJob[]> {
    this._ensureInit();
    return [...this.activeQueue];
  }

  /**
   * Clear the active queue and optionally the DLQ.
   * Useful for testing or operator-initiated resets.
   */
  async clear(includeDlq = false): Promise<void> {
    this._ensureInit();
    this.activeQueue = [];
    this._writeJobsToFile(this.queuePath, []);
    if (includeDlq) {
      this.deadLetterQueue = [];
      this._writeJobsToFile(this.dlqPath, []);
    }
  }

  /** Re-read from disk — useful if an external process modified the files. */
  async reload(): Promise<void> {
    this.activeQueue = this._readJobsFromFile(this.queuePath);
    this.deadLetterQueue = this._readJobsFromFile(this.dlqPath);
  }
}
