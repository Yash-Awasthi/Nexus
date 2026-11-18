// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/runtime — public API
 *
 * Execution kernel: queue backends, council bridge, crash recovery,
 * OTel tracing, runtime wiring factory, and all supporting interfaces.
 */

// ── Queue backends ────────────────────────────────────────────────────────────

export type { RedisQueueBackendOptions } from "./redis-queue-backend.ts";

// ── Interfaces ────────────────────────────────────────────────────────────────
export type { IQueueBackend, QueueJob, RetryPolicy } from "./interfaces/queue.interface.ts";
export type {
  IMetricsCollector,
  ITraceRecorder,
  ITraceSpan,
  ITaskSnapshot,
  IQueueSnapshot,
  IEventSnapshot,
  ITelemetrySink,
  IRuntimeInspector,
} from "./interfaces/observability.interface.ts";
export type { IRuntimePersistence } from "./interfaces/persistence.interface.ts";

// ── Event bus ─────────────────────────────────────────────────────────────────

export type { IEventBus, EventSubscription } from "./event-bus.ts";

// ── Circuit breaker ───────────────────────────────────────────────────────────

// ── Council bridge ────────────────────────────────────────────────────────────

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
} from "./council-bridge.ts";

// ── Crash recovery ────────────────────────────────────────────────────────────

export type {
  TaskRecord,
  IRecoveryStore,
  RecoveryResult,
  CrashRecoveryConfig,
} from "./crash-recovery.ts";

// ── OTel tracing ──────────────────────────────────────────────────────────────

export type {
  NexusSpan,
  TraceContext,
  PropagationHeaders,
  OtelTracerConfig,
} from "./tracing/otel-tracer.ts";

// ── Execution interfaces ───────────────────────────────────────────────────────
export type {
  IExecutionContext,
  IRuntimeEvent,
  IExecutionAdapter,
  ITaskDependencyResolver,
  ITaskExecutor,
} from "./interfaces/execution.interface.ts";

// ── Diagnostic API ────────────────────────────────────────────────────────────
export { RuntimeDiagnosticAPI } from "./diagnostic-api.ts";

// ── MCP bridge ────────────────────────────────────────────────────────────────
export { registerConductorMcpBridge } from "./conductor-mcp-bridge.ts";

// ── Planning engine ───────────────────────────────────────────────────────────
export { PlanningEngine } from "./planning-engine.ts";

// ── Spec loader ───────────────────────────────────────────────────────────────
export { specToWorkflowDefinition } from "./spec-loader.ts";
export type { WorkflowSpecTask, WorkflowSpecFile } from "./spec-loader.ts";

// ── Runtime context factory ───────────────────────────────────────────────────
export { createRuntimeContext, startRuntime, stopRuntime } from "./runtime-context.ts";
export type { ConductorRuntimeContext } from "./runtime-context.ts";

// ── Adapter manifest ──────────────────────────────────────────────────────────
export { ADAPTER_MANIFEST } from "./adapters/manifest.ts";
export type { AdapterManifestEntry, AdapterIntegrationMode } from "./adapters/manifest.ts";

// ── Federation ────────────────────────────────────────────────────────────────
export { runFederationE2e } from "./e2e-federation.ts";
export type { FederationE2eResult, FederationE2eOptions } from "./e2e-federation.ts";
export { FederationSupervisor } from "./federation-supervisor.ts";
export type {
  FederationServiceStatus,
  FederationSupervisorStatus,
} from "./federation-supervisor.ts";

// ── Conductor config ─────────────────────────────────────────────────────────
export { loadConductorConfig } from "./conductor-config.ts";
export type { ConductorConfig, ConductorFeatures } from "./conductor-config.ts";

// ── Conductor server ─────────────────────────────────────────────────────────
export { createConductorServer } from "./conductor-server.ts";
export type { ConductorServer } from "./conductor-server.ts";

// ── Bootstrap & healthcheck ───────────────────────────────────────────────────
export { bootstrap } from "./bootstrap.ts";
export { runHealthcheck } from "./healthcheck.ts";

// ── Browser execution ─────────────────────────────────────────────────────────

export type {
  BrowserAction,
  BrowserActionType,
  IBrowserTask,
  IBrowserExecutionAdapter,
  IScrapingTask,
  IScrapingExecutionAdapter,
} from "./interfaces/environment.interface.ts";

// ── SSRF / outbound-URL safety ────────────────────────────────────────────────
export { isSafeUrl, makeSafeLookup } from "./security-utils.ts";
export type { ResolvedAddress, AllAddressResolver, SafeLookup } from "./security-utils.ts";
export { createPinnedFetch, pinnedFetch } from "./pinned-fetch.ts";

// ── Governance interfaces ─────────────────────────────────────────────────────
export type {
  ITaskSynthesisResult,
  ICognitiveTrace,
  IPlanningEngine,
  IApprovalRecord,
  IApprovalWorkflow,
  IGovernanceEngine,
} from "./interfaces/governance.interface.ts";
