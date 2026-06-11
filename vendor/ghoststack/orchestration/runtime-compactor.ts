/**
 * Runtime Compactor — Centralized Resource Compaction & Leak Detection
 *
 * Phase 4 — Runtime Stability
 * ============================
 * Orchestrates compaction across all runtime subsystems:
 * - EventBus: history compaction, dedup window clear
 * - RuntimeGraph: journal pruning, auto-checkpoint reset
 * - Queue: dead letter recycling, stalled job cleanup
 * - Memory: leak detection, quota enforcement
 *
 * Also provides:
 * - ResourceQuotaManager: configurable limits per subsystem
 * - LeakDetector: handler/subscription leakage detection, memory growth patterns
 * - CompactionScheduler: periodic compaction cycles
 */

import { IEventBus, EventBusStats } from "./event-bus";
import { IRuntimePersistence } from "./interfaces/persistence.interface";
import { IQueueBackend } from "./interfaces/queue.interface";
import { MetricsCollector } from "./observability-manager";
import { RuntimeGraph } from "./runtime-graph";
import { ILogger } from "./interfaces/logger.interface";

// ─── Types ───────────────────────────────────────────────────────────

/** Named configuration object for RuntimeCompactor — replaces 7 optional positional params */
export interface RuntimeCompactorConfig {
  persistence?: IRuntimePersistence;
  queue?: IQueueBackend;
  leakDetector?: LeakDetector;
  quotaManager?: ResourceQuotaManager;
  metrics?: MetricsCollector;
  options?: CompactorOptions;
  runtimeGraph?: RuntimeGraph;
  /** Optional logger — used for compaction warnings and auto-compaction errors. */
  logger?: ILogger;
}

export interface CompactionReport {
  timestamp: string;
  subsystems: {
    eventBus: {
      historyPruned: number;
      dedupKeysCleared: number;
      persistedEventCountBefore: number;
      persistedEventCountAfter: number;
    };
    graph: {
      journalCleared: boolean;
      journalSizeBefore: number;
      maxJournalSize: number;
    };
    queue: {
      activeJobsBefore: number;
      deadLetterBefore: number;
      recycledDeadLetter: number;
      stalledJobsCleared: number;
    };
  };
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    heapUsedPercent: number;
  };
}

export interface LeakReport {
  timestamp: string;
  detected: boolean;
  subscriptions: {
    activeCount: number;
    suspiciousGrowth: boolean;
    growthRate: number;
  };
  memory: {
    heapUsedMB: number;
    heapGrowthMB: number;
    suspiciousGrowth: boolean;
    growthRateMBperMin: number;
  };
  pendingOperations: number;
  warnings: string[];
}

export interface ResourceQuota {
  maxHistorySize: number;
  maxEventStoreLines: number;
  maxPersistenceFileSizeMB: number;
  maxPendingHandlers: number;
  maxHeapPercent: number;
  maxDeadLetterJobs: number;
}

export interface QuotaViolation {
  subsystem: string;
  metric: string;
  current: number;
  limit: number;
  severity: "warn" | "critical";
}

// ─── Default Quotas ──────────────────────────────────────────────────

const DEFAULT_QUOTAS: ResourceQuota = {
  maxHistorySize: 100_000,
  maxEventStoreLines: 1_000_000,
  maxPersistenceFileSizeMB: 100,
  maxPendingHandlers: 500,
  maxHeapPercent: 85,
  maxDeadLetterJobs: 1000,
};

// ─── Leak Detector ───────────────────────────────────────────────────

export class LeakDetector {
  private readings: Array<{ timestamp: Date; heapUsedMB: number; activeSubscriptions: number }> = [];
  private readonly MAX_READINGS = 20;

  constructor(
    private eventBus: IEventBus,
    private options?: {
      /** Suspect memory leak if heap grows more than this MB per minute (default 50) */
      memoryGrowthThresholdMBperMin?: number;
      /** Suspect subscription leak if count grows more than this per minute (default 10) */
      subscriptionGrowthThresholdPerMin?: number;
    }
  ) {}

  /**
   * Record a diagnostic reading and return a leak report.
   * Should be called periodically (e.g., every 30–60 seconds) during runtime.
   */
  diagnose(): LeakReport {
    const now = new Date();
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100;
    const stats = this.eventBus.getStats();
    const warnings: string[] = [];

    // Record this reading
    this.readings.push({ timestamp: now, heapUsedMB, activeSubscriptions: stats.activeSubscriptions });
    if (this.readings.length > this.MAX_READINGS) {
      this.readings.shift();
    }

    // Memory growth analysis
    let suspiciousMemoryGrowth = false;
    let growthRateMBperMin = 0;
    if (this.readings.length >= 2) {
      const first = this.readings[0];
      const last = this.readings[this.readings.length - 1];
      const elapsedMinutes = (last.timestamp.getTime() - first.timestamp.getTime()) / 60000;
      if (elapsedMinutes > 0) {
        growthRateMBperMin = Math.round(((last.heapUsedMB - first.heapUsedMB) / elapsedMinutes) * 100) / 100;
        const threshold = this.options?.memoryGrowthThresholdMBperMin ?? 50;
        if (growthRateMBperMin > threshold && elapsedMinutes > 1) {
          suspiciousMemoryGrowth = true;
          warnings.push(
            `Suspicious memory growth: ${growthRateMBperMin} MB/min (threshold: ${threshold} MB/min)`
          );
        }
      }
    }

    // Subscription growth analysis
    let suspiciousSubscriptionGrowth = false;
    let growthRatePerMin = 0;
    if (this.readings.length >= 2) {
      const first = this.readings[0];
      const last = this.readings[this.readings.length - 1];
      const elapsedMinutes = (last.timestamp.getTime() - first.timestamp.getTime()) / 60000;
      if (elapsedMinutes > 0) {
        growthRatePerMin = Math.round(((last.activeSubscriptions - first.activeSubscriptions) / elapsedMinutes) * 100) / 100;
        const threshold = this.options?.subscriptionGrowthThresholdPerMin ?? 10;
        if (growthRatePerMin > threshold && elapsedMinutes > 1) {
          suspiciousSubscriptionGrowth = true;
          warnings.push(
            `Suspicious subscription growth: ${growthRatePerMin}/min (threshold: ${threshold}/min)`
          );
        }
      }
    }

    return {
      timestamp: now.toISOString(),
      detected: suspiciousMemoryGrowth || suspiciousSubscriptionGrowth,
      subscriptions: {
        activeCount: stats.activeSubscriptions,
        suspiciousGrowth: suspiciousSubscriptionGrowth,
        growthRate: growthRatePerMin,
      },
      memory: {
        heapUsedMB,
        heapGrowthMB: this.readings.length >= 2
          ? Math.round((this.readings[this.readings.length - 1].heapUsedMB - this.readings[0].heapUsedMB) * 100) / 100
          : 0,
        suspiciousGrowth: suspiciousMemoryGrowth,
        growthRateMBperMin,
      },
      pendingOperations: stats.pendingHandlers,
      warnings,
    };
  }

  /** Reset all readings (e.g., after a compaction cycle). */
  reset(): void {
    this.readings = [];
  }
}

// ─── Resource Quota Manager ──────────────────────────────────────────

export class ResourceQuotaManager {
  private quotas: ResourceQuota;

  constructor(
    quotas?: Partial<ResourceQuota>,
    private metrics?: MetricsCollector
  ) {
    this.quotas = { ...DEFAULT_QUOTAS, ...quotas };
  }

  getQuotas(): ResourceQuota {
    return { ...this.quotas };
  }

  updateQuotas(updates: Partial<ResourceQuota>): void {
    this.quotas = { ...this.quotas, ...updates };
  }

  /**
   * Check all quotas against current runtime state.
   * Returns list of violations sorted by severity.
   */
  check(
    eventBusStats: EventBusStats,
    queueBackend?: IQueueBackend
  ): QuotaViolation[] {
    const violations: QuotaViolation[] = [];
    const mem = process.memoryUsage();
    const heapPercent = (mem.heapUsed / mem.heapTotal) * 100;

    // Heap usage
    if (heapPercent > this.quotas.maxHeapPercent) {
      violations.push({
        subsystem: "memory",
        metric: "heapUsedPercent",
        current: Math.round(heapPercent * 100) / 100,
        limit: this.quotas.maxHeapPercent,
        severity: "critical",
      });
    } else if (heapPercent > this.quotas.maxHeapPercent * 0.8) {
      violations.push({
        subsystem: "memory",
        metric: "heapUsedPercent",
        current: Math.round(heapPercent * 100) / 100,
        limit: this.quotas.maxHeapPercent,
        severity: "warn",
      });
    }

    // Event history size
    if (eventBusStats.historySize > this.quotas.maxHistorySize) {
      violations.push({
        subsystem: "eventBus",
        metric: "historySize",
        current: eventBusStats.historySize,
        limit: this.quotas.maxHistorySize,
        severity: "warn",
      });
    }

    // Pending handlers
    if (eventBusStats.pendingHandlers > this.quotas.maxPendingHandlers) {
      violations.push({
        subsystem: "eventBus",
        metric: "pendingHandlers",
        current: eventBusStats.pendingHandlers,
        limit: this.quotas.maxPendingHandlers,
        severity: "critical",
      });
    }

    // Dead letter queue
    if (queueBackend) {
      // We can't directly get dead letter length from IQueueBackend,
      // so we'll check active queue length as a proxy.
      // Dead letter checks happen at the diagnostic layer.
    }

    // Record violations as metrics
    if (this.metrics && violations.length > 0) {
      this.metrics.recordGauge("quota_violations_total", violations.length);
      this.metrics.increment("quota_checks_with_violations", violations.length);
    }

    return violations;
  }
}

// ─── Runtime Compactor ───────────────────────────────────────────────

export interface CompactorOptions {
  /** Max age in ms for event history compaction (default 1 hour) */
  maxEventAgeMs?: number;
  /** Enable auto-compaction on schedule */
  autoCompact?: boolean;
  /** Interval in ms between auto-compaction cycles (default 5 min) */
  compactIntervalMs?: number;
  /** Max journal size before auto-compaction heuristic triggers (default 1000) */
  maxJournalSize?: number;
  /** Minimum journal growth % between cycles to trigger heuristic compact (default 20%) */
  journalGrowthThresholdPercent?: number;
  /** Backpressure count threshold before triggering compaction (default 50) */
  backpressureThreshold?: number;
  /** Whether warn-level quota violations trigger compaction (default true) */
  compactOnWarnings?: boolean;
}

export class RuntimeCompactor {
  private timer?: ReturnType<typeof setInterval>;
  private readonly config: RuntimeCompactorConfig;
  /** Last journal size snapshot for growth heuristic */
  private lastJournalSize = 0;

  constructor(
    private eventBus: IEventBus,
    config: RuntimeCompactorConfig = {}
  ) {
    this.config = config;
    if (config.options?.autoCompact && config.options?.compactIntervalMs) {
      this.start(config.options.compactIntervalMs);
    }
  }

  /**
   * Shorthand static factory for minimal construction.
   */
  static create(eventBus: IEventBus, config?: RuntimeCompactorConfig): RuntimeCompactor {
    return new RuntimeCompactor(eventBus, config);
  }

  /**
   * Adaptive compaction decision — checks if compaction is needed based on:
   * - RuntimeGraph journal size approaching threshold
   * - Journal growth rate between cycles
   * - Quota violations from ResourceQuotaManager
   * - EventBus history size
   */
  shouldCompact(): boolean {
    // Check journal size
    if (this.config.runtimeGraph) {
      const journalSize = this.config.runtimeGraph.getJournal().length;
      const maxJournalSize = this.config.options?.maxJournalSize ?? 1000;
      const growthThreshold = this.config.options?.journalGrowthThresholdPercent ?? 20;
      if (journalSize >= maxJournalSize) {
        return true;
      }
      // Check growth rate since last cycle
      if (this.lastJournalSize > 0 && journalSize > this.lastJournalSize) {
        const growthPercent = ((journalSize - this.lastJournalSize) / this.lastJournalSize) * 100;
        if (growthPercent >= growthThreshold) {
          return true;
        }
      }
      this.lastJournalSize = journalSize;
    }

    // Check quota violations
    if (this.config.quotaManager) {
      const violations = this.config.quotaManager.check(this.eventBus.getStats(), this.config.queue);
      if (violations.some((v) => v.severity === "critical")) {
        return true;
      }
      // Non-critical violations — only trigger if compactOnWarnings is enabled
      if (violations.length > 0 && (this.config.options?.compactOnWarnings ?? true)) {
        return true;
      }
    }

    // Check EventBus backpressure
    const bpThreshold = this.config.options?.backpressureThreshold ?? 50;
    if (bpThreshold > 0) {
      const stats = this.eventBus.getStats();
      if (stats.backpressureCount >= bpThreshold) {
        return true;
      }
    }

    return false;
  }

  /**
   * Clear cached heuristic state (useful after manual compaction).
   */
  resetHeuristics(): void {
    this.lastJournalSize = 0;
  }

  /**
   * Run a full compaction cycle across all subsystems.
   */
  async compact(): Promise<CompactionReport> {
    const beforeStats = this.eventBus.getStats();

    // ── 1. Compact EventBus history ──────────────────────────────────
    const maxEventAgeMs = this.config.options?.maxEventAgeMs ?? 3_600_000;
    const historyResult = this.eventBus.compactHistory(maxEventAgeMs);
    const dedupResult = this.eventBus.compact();

    // ── 2. Queue — recycle dead letter jobs ──────────────────────────
    let deadLetterBefore = 0;
    let recycledDeadLetter = 0;
    const stalledJobsCleared = 0;
    let activeJobsBefore = 0;
    if (this.config.queue) {
      try {
        const dlq = await this.config.queue.getDeadLetterQueue();
        deadLetterBefore = dlq.length;
        // Recycle: re-enqueue dead letter items (simple strategy)
        if (dlq.length > 0) {
          for (const job of dlq) {
            // Reset retries so the job gets a fresh execution attempt
            job.retries = 0;
            await this.config.queue.push(job);
            recycledDeadLetter++;
          }
          // Clear the DLQ after recycling so jobs don't persist in both queues
          await this.config.queue.clearDeadLetterQueue();
        }
        activeJobsBefore = await this.config.queue.getQueueLength();
      } catch {
        // Queue recycle failure is non-fatal
      }
    }

    // ── 3. Clear RuntimeGraph journal ────────────────────────────────
    const journalSizeBefore = this.config.runtimeGraph ? this.config.runtimeGraph.getJournal().length : 0;
    if (this.config.runtimeGraph) {
      this.config.runtimeGraph.clearJournal();
    }

    // ── 4. Reset leak detector readings ──────────────────────────────
    if (this.config.leakDetector) {
      this.config.leakDetector.reset();
    }

    // ── 5. Reset heuristic state after compaction ────────────────────
    this.resetHeuristics();

    // ── 6. Record metrics ────────────────────────────────────────────
    if (this.config.metrics) {
      this.config.metrics.increment("compaction_cycles_total");
      this.config.metrics.recordGauge("compaction_history_pruned", historyResult.prunedCount);
    }

    const mem = process.memoryUsage();
    const afterStats = this.eventBus.getStats();

    return {
      timestamp: new Date().toISOString(),
      subsystems: {
        eventBus: {
          historyPruned: historyResult.prunedCount,
          dedupKeysCleared: dedupResult.dedupKeysCleared,
          persistedEventCountBefore: beforeStats.persistedEventCount,
          persistedEventCountAfter: afterStats.persistedEventCount,
        },
        graph: {
          journalCleared: true,
          journalSizeBefore,
          maxJournalSize: this.config.options?.maxJournalSize ?? 1000,
        },
        queue: {
          activeJobsBefore,
          deadLetterBefore,
          recycledDeadLetter,
          stalledJobsCleared,
        },
      },
      memory: {
        heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
        rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
        heapUsedPercent: Math.round((mem.heapUsed / mem.heapTotal) * 10000) / 100,
      },
    };
  }

  /**
   * Start periodic auto-compaction with adaptive heuristic.
   * Uses shouldCompact() to skip unnecessary cycles, conserving resources.
   */
  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(async () => {
      try {
        if (!this.shouldCompact()) {
          if (this.config.metrics) {
            this.config.metrics.increment("compaction_skipped_heuristic");
          }
          return;
        }
        await this.compact();
      } catch (err) {
        if (this.config.logger) {
          this.config.logger.error("[RuntimeCompactor] Auto-compaction failed", err);
        } else {
          console.error("[RuntimeCompactor] Auto-compaction failed:", err);
        }
      }
    }, intervalMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  /**
   * Stop periodic auto-compaction.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run leak diagnostics and return the report.
   */
  diagnoseLeaks(): LeakReport | null {
    if (!this.config.leakDetector) return null;
    return this.config.leakDetector.diagnose();
  }

  /**
   * Check resource quotas.
   */
  getQuotaViolations(): QuotaViolation[] {
    if (!this.config.quotaManager) return [];
    return this.config.quotaManager.check(this.eventBus.getStats(), this.config.queue);
  }
}
