// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/confidence-circuit-breaker — Confidence-aware circuit breaker for agents.
 *
 * Inspired by circuit-breaker-agents' ConfidenceThresholdStrategy.
 * Trips circuit breakers not just on errors but on low-confidence outputs,
 * preventing cascading bad decisions in agent systems.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitStats {
  state: CircuitState;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  averageConfidence: number;
  openedAt?: number;
}

export interface ResultMetadata {
  success: boolean;
  confidence?: number;
  latencyMs?: number;
  cost?: number;
  error?: string;
}

// ── Strategies ───────────────────────────────────────────────────────────────

export interface TripStrategy {
  name: string;
  shouldTrip(stats: CircuitStats): boolean;
  recordResult(metadata: ResultMetadata): void;
  reset(): void;
}

/**
 * Trip when error rate exceeds threshold.
 */
export class ErrorRateStrategy implements TripStrategy {
  name = "errorRate";
  private errors = 0;
  private total = 0;

  constructor(
    private threshold: number = 0.5,
    private windowMs: number = 60_000,
  ) {}

  shouldTrip(stats: CircuitStats): boolean {
    if (this.total < 5) return false;
    return this.errors / this.total > this.threshold;
  }

  recordResult(metadata: ResultMetadata): void {
    this.total++;
    if (!metadata.success) this.errors++;
  }

  reset(): void {
    this.errors = 0;
    this.total = 0;
  }
}

/**
 * Trip when average confidence drops below threshold.
 */
export class ConfidenceThresholdStrategy implements TripStrategy {
  name = "confidenceThreshold";
  private scores: Array<{ score: number; time: number }> = [];

  constructor(
    private minConfidence: number = 0.6,
    private windowMs: number = 60_000,
  ) {}

  shouldTrip(_stats: CircuitStats): boolean {
    this.pruneOldScores();
    if (this.scores.length === 0) return false;
    const avg = this.scores.reduce((sum, s) => sum + s.score, 0) / this.scores.length;
    return avg < this.minConfidence;
  }

  recordResult(metadata: ResultMetadata): void {
    if (metadata.confidence !== undefined) {
      this.scores.push({ score: metadata.confidence, time: Date.now() });
    }
  }

  reset(): void {
    this.scores.length = 0;
  }

  private pruneOldScores(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.scores.length > 0 && this.scores[0]!.time < cutoff) {
      this.scores.shift();
    }
  }
}

/**
 * Trip when cost exceeds budget.
 */
export class CostBudgetStrategy implements TripStrategy {
  name = "costBudget";
  private totalCost = 0;
  private windowStart = Date.now();

  constructor(
    private budgetPerWindow: number,
    private windowMs: number = 60_000,
  ) {}

  shouldTrip(): boolean {
    if (Date.now() - this.windowStart > this.windowMs) {
      this.totalCost = 0;
      this.windowStart = Date.now();
    }
    return this.totalCost > this.budgetPerWindow;
  }

  recordResult(metadata: ResultMetadata): void {
    if (metadata.cost) this.totalCost += metadata.cost;
  }

  reset(): void {
    this.totalCost = 0;
    this.windowStart = Date.now();
  }
}

/**
 * Trip when latency exceeds threshold.
 */
export class LatencyThresholdStrategy implements TripStrategy {
  name = "latencyThreshold";
  private latencies: Array<{ value: number; time: number }> = [];

  constructor(
    private maxAvgLatencyMs: number = 10_000,
    private windowMs: number = 60_000,
  ) {}

  shouldTrip(): boolean {
    const cutoff = Date.now() - this.windowMs;
    const recent = this.latencies.filter((l) => l.time > cutoff);
    if (recent.length < 3) return false;
    const avg = recent.reduce((sum, l) => sum + l.value, 0) / recent.length;
    return avg > this.maxAvgLatencyMs;
  }

  recordResult(metadata: ResultMetadata): void {
    if (metadata.latencyMs !== undefined) {
      this.latencies.push({ value: metadata.latencyMs, time: Date.now() });
    }
  }

  reset(): void {
    this.latencies.length = 0;
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Thrown by `execute()` when the circuit is open and no fallback was provided.
 */
export class CircuitOpenError extends Error {
  constructor(
    public readonly circuitName: string,
    message?: string,
  ) {
    super(message ?? `Circuit "${circuitName}" is open — failing fast`);
    this.name = "CircuitOpenError";
  }
}

// ── Circuit Breaker ──────────────────────────────────────────────────────────

export class ConfidenceCircuitBreaker {
  private stats: CircuitStats;
  private strategies: TripStrategy[];
  private state: CircuitState = "closed";
  private openedAt = 0;
  private recoveryAttempts = 0;

  constructor(
    private name: string,
    strategies?: TripStrategy[],
    options?: {
      openDurationMs?: number;
      halfOpenMaxAttempts?: number;
      onSuccess?: (stats: CircuitStats) => void;
      onTrip?: (stats: CircuitStats, strategy: string) => void;
    },
  ) {
    this.strategies = strategies ?? [new ErrorRateStrategy()];
    this.stats = {
      state: "closed",
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      averageConfidence: 1,
    };
  }

  /**
   * Check if a request is allowed through.
   */
  canExecute(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      const openDurationMs = 30_000;
      if (Date.now() - this.openedAt > openDurationMs) {
        this.state = "half-open";
        this.recoveryAttempts = 0;
        return true;
      }
      return false;
    }

    // half-open: allow limited requests
    return this.recoveryAttempts < 3;
  }

  /**
   * Execute an async function under the circuit breaker (opossum-style).
   *
   * When the circuit is open the call fails fast: if a `fallback` is provided it
   * is executed and its result returned, otherwise a `CircuitOpenError` is thrown.
   * Successes and failures are recorded for the trip strategies.
   */
  async execute<T>(fn: () => Promise<T>, fallback?: () => T | Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      if (fallback) return fallback();
      throw new CircuitOpenError(this.name);
    }
    try {
      const result = await fn();
      this.recordResult({ success: true });
      return result;
    } catch (err) {
      this.recordResult({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Record the result of an execution.
   */
  recordResult(metadata: ResultMetadata): void {
    this.stats.totalRequests++;
    this.stats.averageConfidence =
      (this.stats.averageConfidence * (this.stats.totalRequests - 1) + (metadata.confidence ?? 1)) /
      this.stats.totalRequests;

    if (metadata.success) {
      this.stats.successCount++;
      this.stats.consecutiveFailures = 0;
      this.stats.lastSuccessTime = Date.now();

      if (this.state === "half-open") {
        this.recoveryAttempts++;
        if (this.recoveryAttempts >= 3) {
          this.state = "closed";
          this.recoveryAttempts = 0;
          for (const strategy of this.strategies) strategy.reset();
        }
      }
    } else {
      this.stats.failureCount++;
      this.stats.consecutiveFailures++;
      this.stats.lastFailureTime = Date.now();

      for (const strategy of this.strategies) {
        strategy.recordResult(metadata);
        if (strategy.shouldTrip(this.stats)) {
          this.trip(strategy.name);
          break;
        }
      }
    }
  }

  /**
   * Get current stats.
   */
  getStats(): CircuitStats {
    return { ...this.stats, state: this.state, openedAt: this.openedAt };
  }

  /**
   * Get the circuit name.
   */
  getName(): string {
    return this.name;
  }

  /**
   * Force reset the circuit breaker.
   */
  reset(): void {
    this.state = "closed";
    this.recoveryAttempts = 0;
    this.stats.consecutiveFailures = 0;
    for (const strategy of this.strategies) strategy.reset();
  }

  private trip(strategyName: string): void {
    this.state = "open";
    this.openedAt = Date.now();
    this.stats.state = "open";
    this.stats.openedAt = Date.now();
  }
}

// ── Circuit Breaker Registry ─────────────────────────────────────────────────

export class CircuitBreakerRegistry {
  private breakers: Map<string, ConfidenceCircuitBreaker> = new Map();

  getOrCreate(
    name: string,
    strategies?: TripStrategy[],
  ): ConfidenceCircuitBreaker {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new ConfidenceCircuitBreaker(name, strategies));
    }
    return this.breakers.get(name)!;
  }

  get(name: string): ConfidenceCircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  getAll(): ConfidenceCircuitBreaker[] {
    return Array.from(this.breakers.values());
  }

  getOpenCircuits(): ConfidenceCircuitBreaker[] {
    return this.getAll().filter((b) => b.getStats().state === "open");
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

// ── Sliding-Window Circuit Breaker ───────────────────────────────────────────

/**
 * Standard sliding-window circuit breaker.
 * Inspired by SmarterRouter's CircuitBreaker with failure_threshold,
 * reset_timeout, half_open state, and quota-exhausted handling.
 */

export type SlidingCircuitState = "closed" | "open" | "half-open";

export interface SlidingCircuitConfig {
  /** Number of failures in the sliding window before opening. Default: 5. */
  failureThreshold: number;
  /** Seconds to wait before attempting half-open. Default: 60. */
  resetTimeoutMs: number;
  /** Successful attempts needed in half-open to close. Default: 3. */
  halfOpenMaxAttempts: number;
  /** Max recent calls to track. Default: 100. */
  slidingWindowSize: number;
  /** Timeout for quota-exhausted failures in ms. Default: 3600000 (1h). */
  quotaResetTimeoutMs: number;
}

const DEFAULT_SLIDING_CONFIG: SlidingCircuitConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  halfOpenMaxAttempts: 3,
  slidingWindowSize: 100,
  quotaResetTimeoutMs: 3_600_000,
};

export class SlidingWindowCircuitBreaker {
  private config: SlidingCircuitConfig;
  private state: SlidingCircuitState = "closed";
  private recentCalls: boolean[] = [];  // true=success, false=failure
  private failureCount = 0;
  private halfOpenSuccesses = 0;
  private lastFailureTime = 0;
  private lastFailureType: string | null = null;
  private stateChangeTime = Date.now();
  private onStateChange?: (name: string, from: SlidingCircuitState, to: SlidingCircuitState) => void;

  constructor(
    private readonly name: string,
    config?: Partial<SlidingCircuitConfig>,
    onStateChange?: (name: string, from: SlidingCircuitState, to: SlidingCircuitState) => void,
  ) {
    this.config = { ...DEFAULT_SLIDING_CONFIG, ...config };
    this.onStateChange = onStateChange;
  }

  /**
   * Execute an async function under the sliding-window circuit breaker.
   *
   * Fails fast while open, using `fallback` when provided (opossum-style),
   * otherwise throwing a `CircuitOpenError`. Records success/failure.
   */
  async execute<T>(fn: () => Promise<T>, fallback?: () => T | Promise<T>): Promise<T> {
    if (!this.isCallAllowed()) {
      if (fallback) return fallback();
      throw new CircuitOpenError(this.name);
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  getState(): SlidingCircuitState {
    if (this.state === "open") {
      const timeout = this.lastFailureType === "quota_exhausted"
        ? this.config.quotaResetTimeoutMs
        : this.config.resetTimeoutMs;
      if (Date.now() - this.lastFailureTime >= timeout) {
        this.transitionTo("half-open");
        this.halfOpenSuccesses = 0;
      }
    }
    return this.state;
  }

  isCallAllowed(): boolean {
    const currentState = this.getState();
    return currentState !== "open";
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenMaxAttempts) {
        this.transitionTo("closed");
        this.recentCalls = [];
        this.failureCount = 0;
      }
    } else {
      this.recentCalls.push(true);
      if (this.recentCalls.length > this.config.slidingWindowSize) {
        this.recentCalls.shift();
      }
    }
  }

  recordFailure(failureType?: string): void {
    this.lastFailureTime = Date.now();
    this.lastFailureType = failureType ?? null;

    if (this.state === "half-open") {
      this.transitionTo("open");
      return;
    }

    this.recentCalls.push(false);
    if (this.recentCalls.length > this.config.slidingWindowSize) {
      this.recentCalls.shift();
    }

    this.failureCount = this.recentCalls.filter((c) => !c).length;
    if (this.failureCount >= this.config.failureThreshold) {
      this.transitionTo("open");
    }
  }

  reset(): void {
    this.transitionTo("closed");
    this.recentCalls = [];
    this.failureCount = 0;
    this.halfOpenSuccesses = 0;
  }

  getStats(): {
    state: SlidingCircuitState;
    failureCount: number;
    recentCallCount: number;
    lastFailureTime: number;
    halfOpenSuccesses: number;
  } {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      recentCallCount: this.recentCalls.length,
      lastFailureTime: this.lastFailureTime,
      halfOpenSuccesses: this.halfOpenSuccesses,
    };
  }

  private transitionTo(newState: SlidingCircuitState): void {
    const prev = this.state;
    this.state = newState;
    this.stateChangeTime = Date.now();
    this.onStateChange?.(this.name, prev, newState);
  }
}

export default SlidingWindowCircuitBreaker;
