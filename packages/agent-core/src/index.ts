// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-core — Unified agent subsystem for Nexus.
 */

export * as agents from "./agents/index.ts";
export * as engine from "./engine/index.ts";
export * as runtime from "./runtime/index.ts";
export * as kernel from "./kernel/index.ts";
export * as workflow from "./workflow/index.ts";
export * as stm from "./stm/index.ts";
export * as pruner from "./pruner/index.ts";
export * as tierGate from "./tier-gate/index.ts";

export * from "./agents/index.ts";
export * from "./engine/index.ts";
export * from "./runtime/index.ts";
export * from "./kernel/index.ts";
export * from "./workflow/index.ts";
export * from "./stm/index.ts";
export * from "./pruner/index.ts";
export * from "./tier-gate/index.ts";

// Resolve the AgentHooks name shared by the agents and runtime submodules.
export type { AgentHooks } from "./agents/index.ts";
