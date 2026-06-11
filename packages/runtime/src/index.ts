// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/runtime — public API
 *
 * Execution kernel: queue backends, council bridge, crash recovery,
 * OTel tracing, runtime wiring factory, and all supporting interfaces.
 */

// ── Queue backends ────────────────────────────────────────────────────────────
export { MemoryQueueBackend } from "./queue-backend.js";
export { FileQueueBackend } from "./file-queue-backend.js";
export { RedisQueueBackend } from "./redis-queue-backend.js";
export type { RedisQueueBackendOptions } from "./redis-queue-backend.js";

// ── Interfaces ────────────────────────────────────────────────────────────────
export type {
  IQueueBackend,
  QueueJob,
  RetryPolicy,
} from "./interfaces/queue.interface.js";
export type {
  IMetricsCollector,
  ITraceRecorder,
  ITraceSpan,
  ITaskSnapshot,
  IQueueSnapshot,
  IEventSnapshot,
  ITelemetrySink,
  IRuntimeInspector,
} from "./interfaces/observability.interface.js";
export type { IRuntimePersistence } from "./interfaces/persistence.interface.js";

// ── Event bus ─────────────────────────────────────────────────────────────────
export { LocalEventBus } from "./event-bus.js";
export type { IEventBus, EventSubscription } from "./event-bus.js";

// ── Circuit breaker ───────────────────────────────────────────────────────────
export {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerAdapterWrapper,
  HealthAwareCircuitBreaker,
} from "./circuit-breaker.js";

// ── Council bridge ────────────────────────────────────────────────────────────
export { CouncilBridge, PlannerCouncilRouter } from "./council-bridge.js";
export type {
  ICouncilEngine,
  ICouncilResult,
  ICouncilVote,
  CouncilSignal,
  RuntimeVerdict,
  VerdictDecision,
  CouncilBridgeConfig,
  RouterConfig,
  RoutedTask,
} from "./council-bridge.js";

// ── Crash recovery ────────────────────────────────────────────────────────────
export { CrashRecovery, MemoryRecoveryStore } from "./crash-recovery.js";
export type {
  TaskRecord,
  IRecoveryStore,
  RecoveryResult,
  CrashRecoveryConfig,
} from "./crash-recovery.js";

// ── OTel tracing ──────────────────────────────────────────────────────────────
export { NexusOtelTracer, encodeTraceparent, parseTraceparent } from "./tracing/otel-tracer.js";
export type {
  NexusSpan,
  TraceContext,
  PropagationHeaders,
  OtelTracerConfig,
} from "./tracing/otel-tracer.js";

// ── Runtime wiring factory ────────────────────────────────────────────────────
export { createNexusRuntime } from "./runtime-wiring.js";
export type {
  NexusRuntime,
  NexusRuntimeConfig,
  QueueBackendType,
} from "./runtime-wiring.js";
