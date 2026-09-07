/**
 * @nexus/intelligence-hub — Barrel export for all intelligence modules.
 *
 * Re-exports every new intelligence package so consumers can import
 * them from a single entry point.
 *
 * Usage:
 *   import { AdmissionControl } from "@nexus/intelligence-hub";
 *   import { BudgetManager } from "@nexus/intelligence-hub";
 */

export { AdmissionControl } from "@nexus/admission-control";
export { ApiKeyRotation } from "@nexus/api-key-rotation";
export { BudgetManager } from "@nexus/budget-manager";
export { ComplexityRouter } from "@nexus/complexity-router";
export { ContextPruning } from "@nexus/context-pruning";
export { DisagreementEngine } from "@nexus/disagreement-engine";
export { DriftDetection } from "@nexus/drift-detection";
export { HeuristicClassifier } from "@nexus/heuristic-classifier";
export { MixtureOfAgents } from "@nexus/mixture-of-agents";
export { AgentCheckpoint } from "@nexus/agent-checkpoint";

/**
 * Version info for the intelligence hub.
 */
export const INTELLIGENCE_HUB_VERSION = "1.0.0";

/**
 * List of all available intelligence modules.
 */
export const INTELLIGENCE_MODULES = [
  { name: "admission-control", description: "Queue-based request admission with capacity management" },
  { name: "api-key-rotation", description: "Intelligent API key pool with health tracking" },
  { name: "budget-manager", description: "Time-based per-user budget tracking" },
  { name: "complexity-router", description: "Complexity-based prompt routing for cost optimization" },
  { name: "context-pruning", description: "Dynamic conversation context management" },
  { name: "disagreement-engine", description: "3-model structured disagreement with minority reports" },
  { name: "drift-detection", description: "LLM evaluation metric monitoring for degradation" },
  { name: "heuristic-classifier", description: "14-dimension weighted scoring classifier" },
  { name: "mixture-of-agents", description: "Layered proposer/aggregator multi-agent synthesis" },
  { name: "agent-checkpoint", description: "Agent state persistence with delta snapshots" },
] as const;
