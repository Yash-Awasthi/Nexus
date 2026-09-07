/**
 * API Key Rotation — intelligent key management with health tracking and failover.
 *
 * Extracted from llm-api-key-proxy: pools multiple API keys, tracks their health
 * (success rate, latency, error counts), rotates on failure, and provides
 * quota-aware selection.
 */

export interface ApiKeyEntry {
  key: string;
  provider: string;
  label?: string;
  healthy: boolean;
  successCount: number;
  errorCount: number;
  lastUsed: number;
  lastError?: { code: number; message: string; timestamp: number };
  avgLatencyMs: number;
  latencySamples: number;
  rateLimitReset?: number; // epoch ms when rate limit resets
  dailyQuota?: number;
  dailyUsed: number;
  dailyReset?: number;
}

export interface KeyPoolConfig {
  maxErrorsBeforeUnhealthy?: number;
  healthCheckIntervalMs?: number;
  latencyWindow?: number;
  dailyResetHour?: number; // 0-23 UTC
  strategy?: 'round-robin' | 'least-recently-used' | 'lowest-latency' | 'most-healthy';
}

export interface KeySelection {
  entry: ApiKeyEntry;
  index: number;
}

export class ApiKeyPool {
  private keys: ApiKeyEntry[] = [];
  private lastIndex = -1;
  private config: Required<KeyPoolConfig>;
  private rotationTimer?: ReturnType<typeof setInterval>;

  constructor(config: KeyPoolConfig = {}) {
    this.config = {
      maxErrorsBeforeUnhealthy: config.maxErrorsBeforeUnhealthy ?? 5,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 60_000,
      latencyWindow: config.latencyWindow ?? 20,
      dailyResetHour: config.dailyResetHour ?? 0,
      strategy: config.strategy ?? 'round-robin',
    };

    this.rotationTimer = setInterval(() => this.healthCheck(), this.config.healthCheckIntervalMs);
  }

  /**
   * Add an API key to the pool.
   */
  addKey(key: string, provider: string, label?: string, dailyQuota?: number): void {
    if (this.keys.some((k) => k.key === key)) return;
    this.keys.push({
      key,
      provider,
      label,
      healthy: true,
      successCount: 0,
      errorCount: 0,
      lastUsed: 0,
      avgLatencyMs: 0,
      latencySamples: 0,
      dailyUsed: 0,
      dailyQuota,
    });
  }

  /**
   * Remove a key from the pool.
   */
  removeKey(key: string): void {
    this.keys = this.keys.filter((k) => k.key !== key);
  }

  /**
   * Select the best key for a request.
   */
  select(provider?: string): KeySelection | null {
    const candidates = this.keys.filter(
      (k) => k.healthy && (!provider || k.provider === provider) && !this.isRateLimited(k) && !this.isQuotaExhausted(k)
    );

    if (candidates.length === 0) return null;

    let selected: ApiKeyEntry;

    switch (this.config.strategy) {
      case 'least-recently-used':
        selected = candidates.reduce((a, b) => (a.lastUsed < b.lastUsed ? a : b));
        break;
      case 'lowest-latency':
        selected = candidates.reduce((a, b) => (a.avgLatencyMs || Infinity) < (b.avgLatencyMs || Infinity) ? a : b);
        break;
      case 'most-healthy':
        selected = candidates.reduce((a, b) => {
          const aScore = a.successCount / (a.successCount + a.errorCount + 1);
          const bScore = b.successCount / (b.successCount + b.errorCount + 1);
          return aScore > bScore ? a : b;
        });
        break;
      default: // round-robin
        this.lastIndex = (this.lastIndex + 1) % candidates.length;
        selected = candidates[this.lastIndex]!;
    }

    selected.lastUsed = Date.now();
    const idx = this.keys.indexOf(selected);
    return { entry: selected, index: idx };
  }

  /**
   * Record a successful request.
   */
  recordSuccess(key: string, latencyMs: number): void {
    const entry = this.keys.find((k) => k.key === key);
    if (!entry) return;

    entry.successCount++;
    entry.healthy = true;
    entry.errorCount = Math.max(0, entry.errorCount - 1); // decay errors

    // Rolling average latency
    entry.latencySamples++;
    entry.avgLatencyMs =
      entry.avgLatencyMs + (latencyMs - entry.avgLatencyMs) / entry.latencySamples;
    if (entry.latencySamples > this.config.latencyWindow) {
      entry.latencySamples = this.config.latencyWindow;
      entry.avgLatencyMs = latencyMs; // reset window
    }
  }

  /**
   * Record a failed request.
   */
  recordError(key: string, code: number, message: string): void {
    const entry = this.keys.find((k) => k.key === key);
    if (!entry) return;

    entry.errorCount++;
    entry.lastError = { code, message, timestamp: Date.now() };

    if (entry.errorCount >= this.config.maxErrorsBeforeUnhealthy) {
      entry.healthy = false;
    }

    // Rate limit detection
    if (code === 429) {
      entry.rateLimitReset = Date.now() + 60_000; // assume 1 min
    }
  }

  /**
   * Get stats for all keys.
   */
  stats(): Array<ApiKeyEntry & { healthScore: number }> {
    return this.keys.map((k) => ({
      ...k,
      healthScore: k.successCount / (k.successCount + k.errorCount + 1),
    }));
  }

  private isRateLimited(key: ApiKeyEntry): boolean {
    return !!key.rateLimitReset && Date.now() < key.rateLimitReset;
  }

  private isQuotaExhausted(key: ApiKeyEntry): boolean {
    if (!key.dailyQuota) return false;
    if (!key.dailyReset || Date.now() > key.dailyReset) {
      key.dailyUsed = 0;
      key.dailyReset = this.nextDailyReset();
    }
    return key.dailyUsed >= key.dailyQuota;
  }

  private nextDailyReset(): number {
    const now = new Date();
    const reset = new Date(now);
    reset.setUTCHours(this.config.dailyResetHour, 0, 0, 0);
    if (reset <= now) reset.setDate(reset.getDate() + 1);
    return reset.getTime();
  }

  private healthCheck(): void {
    for (const key of this.keys) {
      // Auto-recover unhealthy keys after 5 minutes
      if (!key.healthy && key.lastError && Date.now() - key.lastError.timestamp > 300_000) {
        key.healthy = true;
        key.errorCount = 0;
      }

      // Reset daily quota
      if (key.dailyReset && Date.now() > key.dailyReset) {
        key.dailyUsed = 0;
        key.dailyReset = this.nextDailyReset();
      }
    }
  }

  destroy(): void {
    if (this.rotationTimer) clearInterval(this.rotationTimer);
  }
}
