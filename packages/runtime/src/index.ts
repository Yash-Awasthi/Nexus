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
export type { IQueueBackend, QueueJob, RetryPolicy } from "./interfaces/queue.interface.js";
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
export type { NexusRuntime, NexusRuntimeConfig, QueueBackendType } from "./runtime-wiring.js";

// ── Execution interfaces ───────────────────────────────────────────────────────
export type {
  IExecutionContext,
  IRuntimeEvent,
  IExecutionAdapter,
  ITaskDependencyResolver,
  ITaskExecutor,
} from "./interfaces/execution.interface.js";

// ── Diagnostic API ────────────────────────────────────────────────────────────
export { RuntimeDiagnosticAPI } from "./diagnostic-api.js";

// ── MCP bridge ────────────────────────────────────────────────────────────────
export { registerConductorMcpBridge, GHOSTSTACK_MCP_TOOLS } from "./conductor-mcp-bridge.js";

// ── Planning engine ───────────────────────────────────────────────────────────
export { PlanningEngine } from "./planning-engine.js";

// ── GhostStack orchestrator compatibility factory (for @nexus/api gs route) ─────
export { createGhostStackOrchestrator } from "./conductor-compat.js";
export type { GhostStackOrchestrator } from "./conductor-compat.js";

// ── Native agent-runtime adapter (tool-calling coding-agent loop) ────────────────
export { AgentRuntimeAdapter } from "./agent-runtime-adapter.js";
export type { AgentRuntimeAdapterOptions, AgentRuntimeTask } from "./agent-runtime-adapter.js";

// ── Spec loader ───────────────────────────────────────────────────────────────
export {
  parseWorkflowSpec,
  specToWorkflowDefinition,
  loadWorkflowSpecFile,
} from "./spec-loader.js";
export type { WorkflowSpecTask, WorkflowSpecFile } from "./spec-loader.js";

// ── Runtime context factory ───────────────────────────────────────────────────
export { createRuntimeContext, startRuntime, stopRuntime } from "./runtime-context.js";
export type { ConductorRuntimeContext } from "./runtime-context.js";

// ── Adapter manifest ──────────────────────────────────────────────────────────
export { ADAPTER_MANIFEST, getManifestEntry } from "./adapters/manifest.js";
export type { AdapterManifestEntry, AdapterIntegrationMode } from "./adapters/manifest.js";

// ── Federation ────────────────────────────────────────────────────────────────
export { runFederationE2e } from "./e2e-federation.js";
export type { FederationE2eResult, FederationE2eOptions } from "./e2e-federation.js";
export { FederationSupervisor } from "./federation-supervisor.js";
export type {
  FederationServiceStatus,
  FederationSupervisorStatus,
} from "./federation-supervisor.js";

// ── Conductor config ─────────────────────────────────────────────────────────
export { loadConductorConfig } from "./conductor-config.js";
export type { ConductorConfig, ConductorFeatures } from "./conductor-config.js";

// ── Conductor server ─────────────────────────────────────────────────────────
export { createConductorServer } from "./conductor-server.js";
export type { ConductorServer } from "./conductor-server.js";

// ── Bootstrap & healthcheck ───────────────────────────────────────────────────
export { bootstrap } from "./bootstrap.js";
export { runHealthcheck } from "./healthcheck.js";

// ── Governance interfaces ─────────────────────────────────────────────────────
export type {
  ITaskSynthesisResult,
  ICognitiveTrace,
  IPlanningEngine,
  IApprovalRecord,
  IApprovalWorkflow,
  IGovernanceEngine,
} from "./interfaces/governance.interface.js";
