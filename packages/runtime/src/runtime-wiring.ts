// SPDX-License-Identifier: Apache-2.0
/**
 * runtime-wiring.ts — M6 Nexus Runtime factory
 *
 * createNexusRuntime(config) wires together:
 *   EventBus → CouncilBridge → PlannerCouncilRouter
 *              CrashRecovery (runs on startup)
 *              NexusOtelTracer (distributed tracing)
 *              IQueueBackend (Memory | File | Redis)
 *
 * Usage:
 *   import { createNexusRuntime } from "@nexus/runtime/runtime-wiring";
 *
 *   const runtime = await createNexusRuntime({ engine: myCouncilEngine });
 *   await runtime.start();
 *   // ...
 *   await runtime.shutdown();
 */

import { CouncilBridge, PlannerCouncilRouter } from "./council-bridge.js";
import type { ICouncilEngine } from "./council-bridge.js";
import { CrashRecovery, MemoryRecoveryStore } from "./crash-recovery.js";
import type { IRecoveryStore, RecoveryResult } from "./crash-recovery.js";
import { EventBus } from "./event-bus.js";
import type { IMetricsCollector } from "./interfaces/observability.interface.js";
import type { IQueueBackend } from "./interfaces/queue.interface.js";
import { MemoryQueueBackend } from "./queue-backend.js";
import { RedisQueueBackend } from "./redis-queue-backend.js";
import { NexusOtelTracer } from "./tracing/otel-tracer.js";

// ─── Runtime config ───────────────────────────────────────────────────────────

export type QueueBackendType = "memory" | "redis";

export interface NexusRuntimeConfig {
  /** Council engine — inject a DeliberationEngine from @nexus/council */
  engine: ICouncilEngine;

  /** Queue backend selection (default: "memory" for local dev) */
  queueBackend?: QueueBackendType;

  /** Required when queueBackend === "redis" */
  redisUrl?: string;

  /**
   * Recovery store — provide a Drizzle-backed implementation for production.
   * Defaults to MemoryRecoveryStore (dev/test only).
   */
  recoveryStore?: IRecoveryStore;

  /** Optional metrics collector */
  metrics?: IMetricsCollector;

  /** OTel tracer config */
  tracing?: {
    serviceName?: string;
    otlpEndpoint?: string;
    sampleRate?: number;
  };

  /** Council bridge config */
  council?: {
    defaultBudgetUsd?: number;
    defaultTimeoutMs?: number;
    autoApproveThresholdUsd?: number;
  };

  /** Crash recovery config */
  recovery?: {
    staleThresholdMs?: number;
    /** Skip crash recovery on startup (e.g. in tests) */
    skip?: boolean;
  };
}

// ─── Runtime handle ───────────────────────────────────────────────────────────

export interface NexusRuntime {
  /** EventBus — publish / subscribe to nexus.* events */
  eventBus: EventBus;
  /** Route a task through governance → council → queue */
  router: PlannerCouncilRouter;
  /** Queue backend */
  queue: IQueueBackend;
  /** OTel tracer */
  tracer: NexusOtelTracer;
  /** Crash recovery (already ran at startup) */
  recovery: CrashRecovery;
  /** Recovery result from startup */
  recoveryResult: RecoveryResult;
  /** Shut down all connections cleanly */
  shutdown(): Promise<void>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export async function createNexusRuntime(config: NexusRuntimeConfig): Promise<NexusRuntime> {
  // ── 1. Tracer (init first — needed by all components) ──────────────────
  const tracer = new NexusOtelTracer(config.tracing);
  await tracer.init();

  const rootSpan = tracer.startSpan("nexus.runtime.startup");

  try {
    // ── 2. Event bus ───────────────────────────────────────────────────────
    const eventBus = new EventBus();

    // ── 3. Queue backend ───────────────────────────────────────────────────
    let queue: IQueueBackend;
    if (config.queueBackend === "redis") {
      if (!config.redisUrl) {
        throw new Error(
          "redisUrl is required when queueBackend is 'redis'. " +
            "Set REDIS_URL environment variable or pass redisUrl in config.",
        );
      }
      queue = RedisQueueBackend.fromUrl(config.redisUrl);
    } else {
      queue = new MemoryQueueBackend();
    }

    // ── 4. Council bridge ──────────────────────────────────────────────────
    const bridge = new CouncilBridge({
      engine: config.engine,
      eventBus,
      tracer,
      defaultBudgetUsd: config.council?.defaultBudgetUsd,
      defaultTimeoutMs: config.council?.defaultTimeoutMs,
    });

    const router = new PlannerCouncilRouter({
      bridge,
      autoApproveThresholdUsd: config.council?.autoApproveThresholdUsd,
    });

    // ── 5. Crash recovery ──────────────────────────────────────────────────
    const store = config.recoveryStore ?? new MemoryRecoveryStore();

    const recovery = new CrashRecovery({
      store,
      queue,
      eventBus,
      metrics: config.metrics,
      tracer,
      staleThresholdMs: config.recovery?.staleThresholdMs,
    });

    let recoveryResult: RecoveryResult = {
      scanned: 0,
      requeued: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
    };

    if (!config.recovery?.skip) {
      recoveryResult = await recovery.recover();
      tracer.setAttribute(rootSpan.spanId, "recovery.requeued", recoveryResult.requeued);
      tracer.setAttribute(rootSpan.spanId, "recovery.scanned", recoveryResult.scanned);
    }

    // ── 6. Wire event bus listeners ────────────────────────────────────────

    // Log budget exceeded events
    eventBus.subscribe("nexus.budget.exceeded", (payload) => {
      config.metrics?.increment("nexus.budget.exceeded", 1, {
        context_type: String((payload as Record<string, unknown>).context_type ?? "unknown"),
      });
    });

    // Track task events in metrics
    eventBus.subscribe("nexus.tasks.recovered", () => {
      config.metrics?.increment("nexus.tasks.recovered", 1);
    });

    tracer.addEvent(rootSpan.spanId, "runtime.ready", {
      queueBackend: config.queueBackend ?? "memory",
      recoveryRequeued: recoveryResult.requeued,
    });
    tracer.endSpan(rootSpan.spanId);

    // ── Shutdown ───────────────────────────────────────────────────────────
    const shutdown = async (): Promise<void> => {
      const shutdownSpan = tracer.startSpan("nexus.runtime.shutdown");
      try {
        if (queue instanceof RedisQueueBackend) {
          await queue.close();
        }
        await tracer.shutdown();
        tracer.endSpan(shutdownSpan.spanId);
      } catch (err) {
        tracer.errorSpan(shutdownSpan.spanId, err instanceof Error ? err : String(err));
        throw err;
      }
    };

    return {
      eventBus,
      router,
      queue,
      tracer,
      recovery,
      recoveryResult,
      shutdown,
    };
  } catch (err) {
    tracer.errorSpan(rootSpan.spanId, err instanceof Error ? err : String(err));
    throw err;
  }
}
