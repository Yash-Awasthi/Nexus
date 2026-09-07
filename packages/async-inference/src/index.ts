// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/async-inference — Async inference job queue with HTTP poll semantics.
 *
 * Inspired by AIgate's proxq: queues LLM inference requests, returns a job ID
 * instantly, processes in the background. Clients poll for status and result.
 *
 * Features:
 *   • JobStatus         — queued | processing | completed | failed | cancelled
 *   • InferenceJob      — typed job envelope with request, result, timing
 *   • InferenceQueue    — submit, poll, cancel, retry operations
 *   • MemoryJobStore    — in-memory store (for tests / single-process)
 *   • KVJobStore        — KV-backed store for multi-process persistence
 *   • RateLimiter       — optional per-identity rate limiting on submit
 *   • JobCleanup        — TTL-based expiry of completed/failed jobs
 *   • WebhookNotifier   — optional callback on job completion
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type JobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

/** The original inference request submitted by the client. */
export interface InferenceRequest {
  /** Model alias or identifier (e.g. "nexus/smart"). */
  model: string;
  /** Messages in OpenAI chat format. */
  messages: { role: string; content: string }[];
  /** Optional system prompt (injected as first system message). */
  system?: string;
  /** Max tokens for the completion. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Whether to stream (ignored in async mode — always collects full response). */
  stream?: boolean;
  /** Estimated input tokens (for budget pre-check). */
  estimatedTokens?: number;
  /** Arbitrary metadata attached by the caller. */
  metadata?: Record<string, unknown>;
}

/** Result stored after successful completion. */
export interface InferenceResult {
  id: string;
  model: string;
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Which provider actually served this request (after fallback routing). */
  servedBy: string;
  /** Latency of the actual LLM call in ms. */
  llmLatencyMs: number;
  /** Total wall-clock time from queued to completed. */
  totalLatencyMs: number;
}

/** A full inference job record. */
export interface InferenceJob {
  /** Unique job identifier (returned immediately on submit). */
  id: string;
  /** Current status. */
  status: JobStatus;
  /** The original request. */
  request: InferenceRequest;
  /** Result (present when status === "completed"). */
  result?: InferenceResult;
  /** Error message (present when status === "failed"). */
  error?: string;
  /** Retry count (0 on first attempt). */
  attempts: number;
  /** Maximum retry attempts. */
  maxRetries: number;
  /** Epoch ms when the job was submitted. */
  createdAt: number;
  /** Epoch ms when processing started. */
  startedAt?: number;
  /** Epoch ms when the job reached a terminal state. */
  completedAt?: number;
  /** Identity of the submitter (for rate limiting / billing). */
  identity?: string;
}

/** Options for submitting a new job. */
export interface SubmitOptions {
  /** Max retries before marking as failed. Default: 2. */
  maxRetries?: number;
  /** Identity for rate limiting. */
  identity?: string;
  /** Webhook URL to POST to on completion. */
  webhookUrl?: string;
}

/** Options for polling job status. */
export interface PollOptions {
  /** If true, wait up to `timeoutMs` for the job to reach a terminal state. */
  longPoll?: boolean;
  /** Max wait time for long-poll in ms. Default: 30000. */
  timeoutMs?: number;
}

/** Configuration for the inference queue. */
export interface InferenceQueueConfig {
  /** Function that actually executes the LLM call. */
  executor: (request: InferenceRequest) => Promise<InferenceResult>;
  /** Optional rate limiter. */
  rateLimiter?: RateLimiter;
  /** Optional webhook notifier. */
  webhookNotifier?: WebhookNotifier;
  /** Max concurrent processing jobs. Default: 5. */
  concurrency?: number;
  /** TTL for completed/failed jobs in ms. Default: 3600000 (1 hour). */
  jobTtlMs?: number;
  /** Cleanup interval in ms. Default: 60000 (1 minute). */
  cleanupIntervalMs?: number;
}

// ── Job Store Interface ───────────────────────────────────────────────────────

export interface JobStore {
  /** Create a new job, returning its ID. */
  create(job: InferenceJob): Promise<string>;
  /** Get a job by ID. */
  get(id: string): Promise<InferenceJob | null>;
  /** Update a job's fields. */
  update(id: string, patch: Partial<InferenceJob>): Promise<void>;
  /** List jobs matching a status (optional). */
  list(status?: JobStatus, limit?: number): Promise<InferenceJob[]>;
  /** Delete a job. */
  delete(id: string): Promise<void>;
  /** Count jobs by status. */
  countByStatus(): Promise<Record<JobStatus, number>>;
}

// ── Memory Job Store ──────────────────────────────────────────────────────────

/** In-memory job store for tests and single-process deployments. */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, InferenceJob>();

  async create(job: InferenceJob): Promise<string> {
    this.jobs.set(job.id, job);
    return job.id;
  }

  async get(id: string): Promise<InferenceJob | null> {
    return this.jobs.get(id) ?? null;
  }

  async update(id: string, patch: Partial<InferenceJob>): Promise<void> {
    const existing = this.jobs.get(id);
    if (existing) {
      this.jobs.set(id, { ...existing, ...patch });
    }
  }

  async list(status?: JobStatus, limit = 100): Promise<InferenceJob[]> {
    const all = [...this.jobs.values()];
    const filtered = status ? all.filter((j) => j.status === status) : all;
    return filtered
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  async countByStatus(): Promise<Record<JobStatus, number>> {
    const counts: Record<JobStatus, number> = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const job of this.jobs.values()) {
      counts[job.status]++;
    }
    return counts;
  }

  /** Clear all jobs (for tests). */
  clear(): void {
    this.jobs.clear();
  }

  /** Expose the internal map for cleanup testing. */
  get size(): number {
    return this.jobs.size;
  }
}

// ── KV Job Store ──────────────────────────────────────────────────────────────

export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
}

/** KV-backed job store for multi-process persistence. */
export class KVJobStore implements JobStore {
  private prefix: string;

  constructor(private kv: KVStore, opts?: { keyPrefix?: string }) {
    this.prefix = opts?.keyPrefix ?? "async-job:";
  }

  private key(id: string): string {
    return `${this.prefix}${id}`;
  }

  private indexKey(status: JobStatus): string {
    return `${this.prefix}idx:${status}`;
  }

  async create(job: InferenceJob): Promise<string> {
    await Promise.all([
      this.kv.set(this.key(job.id), job, 3_600_000),
      this.kv.set(this.indexKey(job.status), job.id, 3_600_000),
    ]);
    return job.id;
  }

  async get(id: string): Promise<InferenceJob | null> {
    return (await this.kv.get<InferenceJob>(this.key(id))) ?? null;
  }

  async update(id: string, patch: Partial<InferenceJob>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;
    const updated = { ...existing, ...patch };
    await this.kv.set(this.key(id), updated, 3_600_000);
  }

  async list(status?: JobStatus, limit = 100): Promise<InferenceJob[]> {
    if (status) {
      const ids = await this.kv.keys(`${this.indexKey(status)}*`);
      const jobs = await Promise.all(ids.slice(0, limit).map((k) => this.kv.get<InferenceJob>(k)));
      return jobs.filter((j): j is InferenceJob => j !== undefined);
    }
    const allKeys = await this.kv.keys(`${this.prefix}*[!]idx*`);
    const jobs = await Promise.all(allKeys.slice(0, limit).map((k) => this.kv.get<InferenceJob>(k)));
    return jobs.filter((j): j is InferenceJob => j !== undefined);
  }

  async delete(id: string): Promise<void> {
    const job = await this.get(id);
    if (job) {
      await Promise.all([
        this.kv.delete(this.key(id)),
        this.kv.delete(this.indexKey(job.status)),
      ]);
    }
  }

  async countByStatus(): Promise<Record<JobStatus, number>> {
    const statuses: JobStatus[] = ["queued", "processing", "completed", "failed", "cancelled"];
    const counts: Record<JobStatus, number> = {
      queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0,
    };
    for (const s of statuses) {
      const ids = await this.kv.keys(`${this.indexKey(s)}*`);
      counts[s] = ids.length;
    }
    return counts;
  }
}

// ── Rate Limiter ──────────────────────────────────────────────────────────────

export interface RateLimiter {
  /** Returns true if the identity is allowed to submit. */
  allow(identity: string): Promise<boolean>;
  /** Record a submission for the identity. */
  record(identity: string): Promise<void>;
  /** Get remaining quota for the identity. */
  remaining(identity: string): Promise<number>;
}

/** Simple sliding-window rate limiter. */
export class SlidingWindowRateLimiter implements RateLimiter {
  private windows = new Map<string, number[]>();
  private now: () => number;

  constructor(
    private maxRequests: number,
    private windowMs: number,
    opts?: { now?: () => number },
  ) {
    this.now = opts?.now ?? Date.now;
  }

  async allow(identity: string): Promise<boolean> {
    const remaining = await this.remaining(identity);
    return remaining > 0;
  }

  async record(identity: string): Promise<void> {
    const timestamps = this.windows.get(identity) ?? [];
    timestamps.push(this.now());
    // Prune old entries
    const cutoff = this.now() - this.windowMs;
    const pruned = timestamps.filter((t) => t > cutoff);
    this.windows.set(identity, pruned);
  }

  async remaining(identity: string): Promise<number> {
    const timestamps = this.windows.get(identity) ?? [];
    const cutoff = this.now() - this.windowMs;
    const active = timestamps.filter((t) => t > cutoff);
    return Math.max(0, this.maxRequests - active.length);
  }
}

// ── Webhook Notifier ──────────────────────────────────────────────────────────

export interface WebhookNotifier {
  notify(job: InferenceJob): Promise<void>;
}

/** HTTP webhook notifier — POSTs job completion to a URL. */
export class HttpWebhookNotifier implements WebhookNotifier {
  constructor(
    private fetchFn: typeof fetch = fetch,
  ) {}

  async notify(job: InferenceJob): Promise<void> {
    const webhookUrl = (job.request.metadata as Record<string, string>)?.webhookUrl;
    if (!webhookUrl) return;

    try {
      await this.fetchFn(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: job.id,
          status: job.status,
          result: job.result,
          error: job.error,
          completedAt: job.completedAt,
        }),
      });
    } catch {
      // Webhook failures are non-fatal
    }
  }
}

// ── Inference Queue ───────────────────────────────────────────────────────────

/** Event emitted when a job status changes. */
export type JobEvent =
  | { type: "submitted"; job: InferenceJob }
  | { type: "processing"; job: InferenceJob }
  | { type: "completed"; job: InferenceJob }
  | { type: "failed"; job: InferenceJob }
  | { type: "cancelled"; job: InferenceJob };

export type JobEventListener = (event: JobEvent) => void;

/**
 * Async inference queue — submit LLM requests, poll for results.
 *
 * @example
 * ```ts
 * const queue = new InferenceQueue({
 *   executor: async (req) => {
 *     const res = await callLLM(req);
 *     return res;
 *   },
 * });
 *
 * // Submit
 * const { jobId } = await queue.submit({ model: "nexus/smart", messages: [...] });
 *
 * // Poll
 * const job = await queue.poll(jobId);
 * if (job.status === "completed") console.log(job.result);
 * ```
 */
export class InferenceQueue {
  private store: JobStore;
  private config: InferenceQueueConfig;
  private processing = new Set<string>();
  private listeners: JobEventListener[] = [];
  private cleanupTimer?: ReturnType<typeof setInterval>;
  /** Map of job ID → long-poll resolvers */
  private waiters = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }[]>();

  constructor(config: InferenceQueueConfig, store?: JobStore) {
    this.config = config;
    this.store = store ?? new MemoryJobStore();
    if (config.cleanupIntervalMs && config.jobTtlMs) {
      this.cleanupTimer = setInterval(() => void this.cleanup(), config.cleanupIntervalMs);
    }
  }

  /** Subscribe to job events. */
  on(listener: JobEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Submit an inference request. Returns the job ID immediately. */
  async submit(
    request: InferenceRequest,
    opts: SubmitOptions = {},
  ): Promise<{ jobId: string }> {
    // Rate limit check
    if (this.config.rateLimiter && opts.identity) {
      const allowed = await this.config.rateLimiter.allow(opts.identity);
      if (!allowed) {
        throw new Error(`Rate limit exceeded for identity: ${opts.identity}`);
      }
      await this.config.rateLimiter.record(opts.identity);
    }

    const id = `inf-${crypto.randomUUID()}`;
    const job: InferenceJob = {
      id,
      status: "queued",
      request: { ...request },
      attempts: 0,
      maxRetries: opts.maxRetries ?? 2,
      createdAt: Date.now(),
      identity: opts.identity,
    };

    await this.store.create(job);
    this.emit({ type: "submitted", job });

    // Start processing in background (don't await)
    void this._processJob(id);

    return { jobId: id };
  }

  /** Poll for a job's current status. */
  async poll(id: string, opts: PollOptions = {}): Promise<InferenceJob> {
    const job = await this.store.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);

    if (!opts.longPoll || _isTerminal(job.status)) return job;

    // Long-poll: wait for status change or timeout
    return new Promise((resolve) => {
      const timeout = opts.timeoutMs ?? 30_000;
      const waiter = {
        resolve: () => {
          this.store.get(id).then((j) => resolve(j ?? job));
        },
        timer: setTimeout(() => {
          // Timeout — return current status
          this.store.get(id).then((j) => resolve(j ?? job));
          this._removeWaiter(id, waiter);
        }, timeout),
      };
      this._addWaiter(id, waiter);
    });
  }

  /** Cancel a queued job (not yet processing). */
  async cancel(id: string): Promise<InferenceJob> {
    const job = await this.store.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (job.status !== "queued") {
      throw new Error(`Cannot cancel job in status: ${job.status}`);
    }
    await this.store.update(id, {
      status: "cancelled",
      completedAt: Date.now(),
    });
    const updated = (await this.store.get(id))!;
    this.emit({ type: "cancelled", job: updated });
    this._notifyWaiters(id);
    return updated;
  }

  /** Manually retry a failed job. */
  async retry(id: string): Promise<InferenceJob> {
    const job = await this.store.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (job.status !== "failed" && job.status !== "cancelled") {
      throw new Error(`Cannot retry job in status: ${job.status}`);
    }
    await this.store.update(id, {
      status: "queued",
      error: undefined,
      result: undefined,
      attempts: 0,
      completedAt: undefined,
    });
    const updated = (await this.store.get(id))!;
    void this._processJob(id);
    return updated;
  }

  /** Get queue statistics. */
  async stats(): Promise<{
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
    concurrency: number;
  }> {
    const counts = await this.store.countByStatus();
    return { ...counts, concurrency: this.processing.size };
  }

  /** Get the underlying store. */
  getStore(): JobStore {
    return this.store;
  }

  /** Stop cleanup timer. */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    // Clear all waiters
    for (const [, waiters] of this.waiters) {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve();
      }
    }
    this.waiters.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _processJob(id: string): Promise<void> {
    const maxConcurrency = this.config.concurrency ?? 5;
    if (this.processing.size >= maxConcurrency) {
      // Re-queue: will be picked up by the next processing slot
      return;
    }

    const job = await this.store.get(id);
    if (!job || job.status !== "queued") return;

    this.processing.add(id);

    try {
      await this.store.update(id, {
        status: "processing",
        startedAt: Date.now(),
        attempts: job.attempts + 1,
      });
      const processingJob = (await this.store.get(id))!;
      this.emit({ type: "processing", job: processingJob });

      const llmStart = Date.now();
      const result = await this.config.executor(job.request);
      const llmLatencyMs = Date.now() - llmStart;

      const finalResult = {
        ...result,
        llmLatencyMs,
        totalLatencyMs: Date.now() - job.createdAt,
      };

      await this.store.update(id, {
        status: "completed",
        result: finalResult,
        completedAt: Date.now(),
      });

      const completedJob = (await this.store.get(id))!;
      this.emit({ type: "completed", job: completedJob });

      // Webhook notification
      if (this.config.webhookNotifier) {
        void this.config.webhookNotifier.notify(completedJob);
      }

      this._notifyWaiters(id);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const currentJob = (await this.store.get(id))!;

      if (currentJob.attempts < currentJob.maxRetries) {
        // Will be retried
        await this.store.update(id, {
          status: "queued",
          error: errorMsg,
        });
        this.processing.delete(id);
        void this._processJob(id);
        return;
      }

      await this.store.update(id, {
        status: "failed",
        error: errorMsg,
        completedAt: Date.now(),
      });

      const failedJob = (await this.store.get(id))!;
      this.emit({ type: "failed", job: failedJob });

      if (this.config.webhookNotifier) {
        void this.config.webhookNotifier.notify(failedJob);
      }

      this._notifyWaiters(id);
    } finally {
      this.processing.delete(id);
    }
  }

  private emit(event: JobEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* isolate */ }
    }
  }

  private _addWaiter(id: string, waiter: { resolve: () => void; timer: ReturnType<typeof setTimeout> }): void {
    const list = this.waiters.get(id) ?? [];
    list.push(waiter);
    this.waiters.set(id, list);
  }

  private _removeWaiter(id: string, waiter: { resolve: () => void; timer: ReturnType<typeof setTimeout> }): void {
    const list = this.waiters.get(id);
    if (list) {
      const idx = list.indexOf(waiter);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.waiters.delete(id);
    }
  }

  private _notifyWaiters(id: string): void {
    const list = this.waiters.get(id);
    if (list) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.resolve();
      }
      this.waiters.delete(id);
    }
  }

  private async cleanup(): Promise<void> {
    const ttl = this.config.jobTtlMs ?? 3_600_000;
    const cutoff = Date.now() - ttl;
    for (const status of ["completed", "failed", "cancelled"] as JobStatus[]) {
      const jobs = await this.store.list(status, 200);
      for (const job of jobs) {
        if (job.completedAt && job.completedAt < cutoff) {
          await this.store.delete(job.id);
        }
      }
    }
  }
}

function _isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
