// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/conductor — Conductor multi-agent orchestration runtime
 *
 * Re-exports the core API surface for use by @nexus/api routes.
 */

// Core orchestrator
export { ConductorOrchestrator } from "./runtime/orchestrator";

// Planning
export { PlanningEngine } from "./orchestration/planning-engine";

// Governance
export {
  GovernanceEngine,
  ResourceScopeConstraint,
  CostBudgetConstraint,
  DangerousOperationPolicy,
  WildcardPermissionsPolicy,
  LoopDetectionGuardrail,
  RunawayRetriesGuardrail,
  TaskGraphLimitGuardrail,
  TimeoutConstraint,
  HighCostPlanGuardrail,
  DuplicateActionGuardrail,
} from "./orchestration/governance-engine";

// Task routing
export { TaskRouter } from "./orchestration/task-router";
export type { Task } from "./orchestration/task-router";

// Task executor
export { TaskExecutor } from "./orchestration/task-executor";

// Queue backends
export { MemoryQueueBackend } from "./orchestration/queue-backend";
export { FileQueueBackend } from "./orchestration/file-queue-backend";

// Agent registry & event bus
export { LocalAgentRegistry } from "./orchestration/agent-registry";
export { LocalEventBus } from "./orchestration/event-bus";

// Circuit breaker
export { CircuitBreaker } from "./orchestration/circuit-breaker";

// Approval workflow
export { ApprovalWorkflow } from "./orchestration/approval-workflow";

// Runtime manager
export { RuntimeManager } from "./orchestration/runtime-manager";

// Execution adapters
export { WebSearchAdapter } from "./orchestration/web-search-adapter";
export { ScrapingExecutionAdapter } from "./orchestration/scraping-adapter";

// Interfaces
export type { ILanguageModel } from "./orchestration/interfaces/language-model.interface";
export type { IQueueBackend } from "./orchestration/interfaces/queue.interface";
export type {
  IPlanningEngine,
  IGovernanceEngine,
} from "./orchestration/interfaces/governance.interface";
