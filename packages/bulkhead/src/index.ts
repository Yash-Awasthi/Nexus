/**
 * @nexus/bulkhead — Resource pool isolation (bulkhead pattern).
 *
 * Prevents a single failing or slow dependency from consuming all resources.
 * Inspired by Cockatiel's BulkheadIsolation — limits concurrent operations
 * per dependency/pool so failures are contained.
 *
 * Usage:
 *   const bulkhead = new Bulkhead({ maxConcurrent: 5, maxQueued: 10 });
 *   const result = await bulkhead.execute(async () => {
 *     return await callExternalApi();
 *   });
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BulkheadOptions {
  /** Maximum concurrent executions (default: 10) */
  maxConcurrent: number;
  /** Maximum queued requests waiting for a slot (default: 10) */
  maxQueued: number;
  /** Timeout for queued requests in ms (default: 30000) */
  queueTimeout?: number;
  /** Callback when a request is rejected due to full pool */
  onReject?: (info: BulkheadRejectInfo) => void;
  /** Callback when a request starts executing */
  onExecute?: (info: BulkheadExecuteInfo) => void;
  /** Callback when a request completes */
  onComplete?: (info: BulkheadCompleteInfo) => void;
}

export interface BulkheadRejectInfo {
  poolId: string;
  totalExecuting: number;
  totalQueued: number;
  timestamp: string;
}

export interface BulkheadExecuteInfo {
  poolId: string;
  position: number; // position in queue (0 = immediate)
  timestamp: string;
}

export interface BulkheadCompleteInfo {
  poolId: string;
  durationMs: number;
  success: boolean;
  error?: string;
  timestamp: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class BulkheadRejectionError extends Error {
  constructor(
    public readonly poolId: string,
    public readonly executing: number,
    public readonly queued: number,
  ) {
    super(
      `Bulkhead "${poolId}" rejected: ${executing} executing, ${queued} queued (max concurrent: ${executing + queued})`,
    );
    this.name = "BulkheadRejectionError";
  }
}

export class BulkheadTimeoutError extends Error {
  constructor(public readonly poolId: string, timeoutMs: number) {
    super(
      `Bulkhead "${poolId}" queue timeout after ${timeoutMs}ms`,
    );
    this.name = "BulkheadTimeoutError";
  }
}

// ─── Bulkhead ────────────────────────────────────────────────────────────────

export class Bulkhead {
  private executing = 0;
  private queued: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly options: Required<BulkheadOptions>;
  private readonly poolId: string;

  constructor(poolId: string, options: Partial<BulkheadOptions> = {}) {
    this.poolId = poolId;
    this.options = {
      maxConcurrent: options.maxConcurrent ?? 10,
      maxQueued: options.maxQueued ?? 10,
      queueTimeout: options.queueTimeout ?? 30_000,
      onReject: options.onReject ?? (() => {}),
      onExecute: options.onExecute ?? (() => {}),
      onComplete: options.onComplete ?? (() => {}),
    };
  }

  /** Current number of executing operations. */
  get executingCount(): number {
    return this.executing;
  }

  /** Current number of queued operations. */
  get queuedCount(): number {
    return this.queued.length;
  }

  /** Total capacity (executing + queued). */
  get capacity(): number {
    return this.options.maxConcurrent + this.options.maxQueued;
  }

  /** Whether the bulkhead has available slots. */
  get hasCapacity(): boolean {
    return this.executing < this.options.maxConcurrent;
  }

  /** Execute a function within the bulkhead's concurrency limit. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we can execute immediately
    if (this.executing < this.options.maxConcurrent) {
      this.executing++;
      return this.run(fn, 0);
    }

    // Check if we can queue
    if (this.queued.length >= this.options.maxQueued) {
      this.options.onReject({
        poolId: this.poolId,
        totalExecuting: this.executing,
        totalQueued: this.queued.length,
        timestamp: new Date().toISOString(),
      });
      throw new BulkheadRejectionError(
        this.poolId,
        this.executing,
        this.queued.length,
      );
    }

    // Queue the request
    return new Promise<T>((resolve, reject) => {
      const position = this.queued.length;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const entry = {
        resolve: () => resolve(undefined as T),
        reject: (err: Error) => reject(err),
        timer,
      };

      // Set timeout for queued requests
      if (this.options.queueTimeout > 0) {
        timer = setTimeout(() => {
          const idx = this.queued.indexOf(entry);
          if (idx !== -1) {
            this.queued.splice(idx, 1);
            reject(new BulkheadTimeoutError(this.poolId, this.options.queueTimeout));
          }
        }, this.options.queueTimeout);
        entry.timer = timer;
      }

      this.queued.push(entry);

      this.options.onExecute({
        poolId: this.poolId,
        position: position + 1,
        timestamp: new Date().toISOString(),
      });
    }).then(() => {
      this.executing++;
      return this.run(fn, this.queued.length);
    });
  }

  private async run<T>(fn: () => Promise<T>, position: number): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.options.onComplete({
        poolId: this.poolId,
        durationMs: Date.now() - start,
        success: true,
        timestamp: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      this.options.onComplete({
        poolId: this.poolId,
        durationMs: Date.now() - start,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
      throw err;
    } finally {
      this.executing--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    while (
      this.queued.length > 0 &&
      this.executing < this.options.maxConcurrent
    ) {
      const entry = this.queued.shift()!;
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve();
    }
  }

  /** Get current stats. */
  stats(): {
    poolId: string;
    executing: number;
    queued: number;
    capacity: number;
    hasCapacity: boolean;
  } {
    return {
      poolId: this.poolId,
      executing: this.executing,
      queued: this.queued.length,
      capacity: this.capacity,
      hasCapacity: this.hasCapacity,
    };
  }
}

// ─── Bulkhead Pool ───────────────────────────────────────────────────────────

/**
 * Manages multiple bulkhead pools for different dependencies.
 * Prevents a single dependency from starving others.
 */
export class BulkheadPool {
  private pools = new Map<string, Bulkhead>();
  private defaultOptions: Partial<BulkheadOptions>;

  constructor(defaultOptions: Partial<BulkheadOptions> = {}) {
    this.defaultOptions = defaultOptions;
  }

  /** Get or create a bulkhead pool. */
  getPool(poolId: string, options?: Partial<BulkheadOptions>): Bulkhead {
    let pool = this.pools.get(poolId);
    if (!pool) {
      pool = new Bulkhead(poolId, { ...this.defaultOptions, ...options });
      this.pools.set(poolId, pool);
    }
    return pool;
  }

  /** Execute within a named pool. */
  async execute<T>(
    poolId: string,
    fn: () => Promise<T>,
    options?: Partial<BulkheadOptions>,
  ): Promise<T> {
    const pool = this.getPool(poolId, options);
    return pool.execute(fn);
  }

  /** Get stats for all pools. */
  stats(): Array<{
    poolId: string;
    executing: number;
    queued: number;
    capacity: number;
  }> {
    return [...this.pools.values()].map((p) => p.stats());
  }

  /** Get total executing across all pools. */
  totalExecuting(): number {
    return [...this.pools.values()].reduce(
      (sum, p) => sum + p.executingCount,
      0,
    );
  }

  /** Get total queued across all pools. */
  totalQueued(): number {
    return [...this.pools.values()].reduce(
      (sum, p) => sum + p.queuedCount,
      0,
    );
  }
}
