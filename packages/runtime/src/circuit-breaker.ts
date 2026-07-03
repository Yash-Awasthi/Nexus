// SPDX-License-Identifier: Apache-2.0
/**
 * Circuit Breaker for Floci and external service resilience.
 *
 * Prevents cascading failures by tracking failure rates,
 * opening the circuit when thresholds are exceeded, and
 * allowing recovery via health probes.
 */

import type { IEventBus } from "./event-bus.js";
import type { ILogger } from "./interfaces/logger.interface.js";
import type { IMetricsCollector } from "./interfaces/observability.interface.js";

// ─── Types ───────────────────────────────────────────────────────────

type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Maximum failures within the sliding window before opening the circuit */
  failureThreshold: number;
  /**
   * Sliding window (in ms) over which failures are counted.
   * Only failures within the last `failureWindowMs` contribute to the threshold.
   * Defaults to 60 000 ms (1 minute).
   */
  failureWindowMs?: number;
  /** Time in ms to wait before transitioning from open to half-open */
  recoveryTimeoutMs: number;
  /** Maximum number of requests allowed in half-open state */
  halfOpenMaxRequests: number;
  /** Percentage of requests that must succeed in half-open to close */
  halfOpenSuccessRate: number;
  /** Name for metrics/tracing */
  name: string;
}

interface CircuitBreakerMetrics {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  totalRequests: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  openedAt: number | null;
  halfOpenAllowed: number;
  halfOpenSuccesses: number;
}

// ─── Errors ──────────────────────────────────────────────────────────

export class CircuitBreakerOpenError extends Error {
  constructor(
    message: string,
    public readonly breakerName: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

// ─── Implementation ──────────────────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitState = "closed";
  /** Timestamps (ms) of recent failures — used for the sliding-window threshold check. */
  private failureTimestamps: number[] = [];
  private successCount = 0;
  private totalRequests = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private openedAt: number | null = null;
  private halfOpenRequests = 0;
  private halfOpenSuccesses = 0;

  constructor(
    private config: CircuitBreakerConfig,
    private eventBus?: IEventBus,
    private logger?: ILogger,
    private metrics?: IMetricsCollector,
  ) {}

  getState(): CircuitState {
    return this.state;
  }

  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failureCount: this._recentFailureCount(),
      successCount: this.successCount,
      totalRequests: this.totalRequests,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      openedAt: this.openedAt,
      halfOpenAllowed: this.halfOpenRequests,
      halfOpenSuccesses: this.halfOpenSuccesses,
    };
  }

  /** Count failures that fall within the configured sliding window. */
  private _recentFailureCount(): number {
    const windowMs = this.config.failureWindowMs ?? 60_000;
    const cutoff = Date.now() - windowMs;
    return this.failureTimestamps.filter((t) => t >= cutoff).length;
  }

  /** Discard failure timestamps older than the sliding window. */
  private _pruneFailureTimestamps(): void {
    const windowMs = this.config.failureWindowMs ?? 60_000;
    const cutoff = Date.now() - windowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
  }

  /**
   * Execute an operation through the circuit breaker.
   * Throws CircuitBreakerOpenError if the circuit is open.
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    if (this.state === "open") {
      // Check if recovery timeout has elapsed
      if (this.openedAt && Date.now() - this.openedAt >= this.config.recoveryTimeoutMs) {
        this.transitionToHalfOpen();
      } else {
        const retryAfter = this.openedAt
          ? this.config.recoveryTimeoutMs - (Date.now() - this.openedAt)
          : this.config.recoveryTimeoutMs;
        throw new CircuitBreakerOpenError(
          `Circuit breaker "${this.config.name}" is open. Retry after ${retryAfter}ms.`,
          this.config.name,
          retryAfter,
        );
      }
    }

    if (this.state === "half-open") {
      if (this.halfOpenRequests >= this.config.halfOpenMaxRequests) {
        throw new CircuitBreakerOpenError(
          `Circuit breaker "${this.config.name}" half-open max requests (${this.config.halfOpenMaxRequests}) reached`,
          this.config.name,
          0,
        );
      }
      this.halfOpenRequests++;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.successCount++;
    this.lastSuccessTime = Date.now();

    if (this.state === "half-open") {
      this.halfOpenSuccesses++;
      // Use max requests as denominator so the rate is a meaningful projection
      const rate = this.halfOpenSuccesses / this.config.halfOpenMaxRequests;
      if (rate >= this.config.halfOpenSuccessRate) {
        this.transitionToClosed();
      }
    }
  }

  private onFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    this.lastFailureTime = now;
    // Keep the timestamps array bounded to the window
    this._pruneFailureTimestamps();

    if (this.state === "closed") {
      if (this._recentFailureCount() >= this.config.failureThreshold) {
        this.transitionToOpen();
      }
    } else if (this.state === "half-open") {
      // Any failure in half-open immediately re-opens
      this.transitionToOpen();
    }
  }

  private transitionToOpen(): void {
    this.state = "open";
    this.openedAt = Date.now();
    const recentCount = this._recentFailureCount();
    this.logger?.warn(`Circuit breaker "${this.config.name}" OPENED`, {
      failureCount: recentCount,
      openedAt: new Date(this.openedAt).toISOString(),
    });
    this.metrics?.recordGauge(`circuit_breaker.${this.config.name}.state`, 1, { state: "open" });
    this.eventBus?.publish("circuit_breaker_opened", {
      name: this.config.name,
      failureCount: recentCount,
      openedAt: new Date().toISOString(),
    });
  }

  protected transitionToHalfOpen(): void {
    this.state = "half-open";
    this.halfOpenRequests = 0;
    this.halfOpenSuccesses = 0;
    this.logger?.info(`Circuit breaker "${this.config.name}" HALF-OPEN (testing recovery)`);
    this.metrics?.recordGauge(`circuit_breaker.${this.config.name}.state`, 1, {
      state: "half-open",
    });
    this.eventBus?.publish("circuit_breaker_half_opened", {
      name: this.config.name,
      timestamp: new Date().toISOString(),
    });
  }

  private transitionToClosed(): void {
    this.state = "closed";
    this.failureTimestamps = [];
    this.halfOpenRequests = 0;
    this.halfOpenSuccesses = 0;
    this.openedAt = null;
    this.logger?.info(`Circuit breaker "${this.config.name}" CLOSED (recovered)`);
    this.metrics?.recordGauge(`circuit_breaker.${this.config.name}.state`, 0, { state: "closed" });
    this.eventBus?.publish("circuit_breaker_closed", {
      name: this.config.name,
      timestamp: new Date().toISOString(),
    });
  }

  reset(): void {
    this.state = "closed";
    this.failureTimestamps = [];
    this.successCount = 0;
    this.totalRequests = 0;
    this.halfOpenRequests = 0;
    this.halfOpenSuccesses = 0;
    this.openedAt = null;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
  }
}

// ─── Circuit Breaker Adapter Wrapper ─────────────────────────────────
// Wraps any adapter with circuit breaker protection (replaces fragile monkey-patching)

export class CircuitBreakerAdapterWrapper {
  constructor(
    private breaker: CircuitBreaker,
    private logger?: ILogger,
  ) {}

  /**
   * Wrap an execute method through the circuit breaker.
   */
  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      return this.breaker.execute(() => fn(...args));
    };
  }

  /**
   * Wrap an adapter's execute method through the circuit breaker.
   */
  wrapAdapter<T extends { execute(task: unknown, context: unknown): Promise<unknown> }>(
    adapter: T,
  ): T {
    const wrapped = Object.create(adapter);
    const originalExecute = adapter.execute.bind(adapter);
    wrapped.execute = async (task: unknown, context: unknown) => {
      return this.breaker.execute(() => originalExecute(task, context));
    };
    // If adapter has executeAction, wrap that too
    if ("executeAction" in adapter) {
      const originalExecuteAction = (
        adapter as Record<string, unknown> & { executeAction(...args: unknown[]): unknown }
      ).executeAction.bind(adapter);
      wrapped.executeAction = async (
        action: string,
        payload: Record<string, unknown>,
        context: unknown,
      ) => {
        return this.breaker.execute(
          () => originalExecuteAction(action, payload, context) as Promise<unknown>,
        );
      };
    }
    return wrapped;
  }

  getBreaker(): CircuitBreaker {
    return this.breaker;
  }
}

// ─── Health-Checking Circuit Breaker ─────────────────────────────────

export class HealthAwareCircuitBreaker extends CircuitBreaker {
  constructor(
    config: CircuitBreakerConfig,
    private healthCheck: () => Promise<boolean>,
    private healthCheckIntervalMs: number,
    eventBus?: IEventBus,
    logger?: ILogger,
    metrics?: IMetricsCollector,
  ) {
    super(config, eventBus, logger, metrics);
    this.startHealthProbes();
  }

  private healthProbeTimer: ReturnType<typeof setInterval> | null = null;

  private startHealthProbes(): void {
    const probe = async () => {
      try {
        const healthy = await this.healthCheck();
        if (healthy && this.getState() === "open") {
          // Force transition to half-open when health check passes
          this.transitionToHalfOpen();
        }
      } catch {
        // Health check failed, circuit stays open
      }
    };

    // Run health check periodically (unref so it doesn't block process exit)
    this.healthProbeTimer = setInterval(probe, this.healthCheckIntervalMs);
    this.healthProbeTimer.unref();
    // Also run immediately
    probe().catch(() => {});
  }

  /**
   * Stop health probes and release resources.
   * Idempotent — safe to call multiple times.
   * Call this in test teardown or when shutting down the circuit breaker.
   */
  destroy(): void {
    if (this.healthProbeTimer !== null) {
      clearInterval(this.healthProbeTimer);
      this.healthProbeTimer = null;
    }
    // Reset state so the breaker starts fresh if re-initialized
    this.reset();
  }
}
