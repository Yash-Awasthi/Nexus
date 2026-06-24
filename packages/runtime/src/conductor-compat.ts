// SPDX-License-Identifier: Apache-2.0
/**
 * conductor-compat.ts — GhostStack orchestrator compatibility factory.
 *
 * The @nexus/api conductor route (/api/v1/gs/*) historically obtained its
 * orchestrator from the standalone @nexus/conductor CJS package via
 * `createRequire(...)("@nexus/conductor")`. That package is a near-duplicate
 * "twin" of @nexus/runtime and is being retired (see
 * .claude/CONDUCTOR_RUNTIME_CONSOLIDATION.md).
 *
 * This factory reconstructs the orchestrator the route used — wired entirely
 * from @nexus/runtime's own classes — so the route can drop the CJS require and
 * import @nexus/runtime statically.
 *
 * Unlike the route's original (broken) wiring, the orchestrator here is fully
 * formed: it registers an offline PlanningEngine (deterministic keyword/
 * blueprint planning — no LLM key required), a GovernanceEngine, and a
 * TaskExecutor. `submitAndRun()` therefore plans + governs + dispatches an
 * objective instead of throwing "Cognitive Planning and Governance systems are
 * not registered in the Orchestrator." The executor is configured with no
 * execution adapters, so task types that need an adapter simply complete as
 * unhandled — the HTTP contract (planId / allowed / processed) is honoured.
 * See apps/api/tests/routes/conductor-route.test.ts (the oracle).
 */

import { GovernanceEngine } from "@nexus/governance";

import { LocalAgentRegistry } from "./agent-registry.js";
import type {
  IConfigLoader,
  PortsConfig,
  ServicesConfig,
  HealthchecksConfig,
  RuntimeConfig,
} from "./config-loader.js";
import { LocalEventBus } from "./event-bus.js";
import type { IExecutionAdapter } from "./interfaces/execution.interface.js";
import type { ILogger } from "./interfaces/logger.interface.js";
import type { IRuntimePersistence } from "./interfaces/persistence.interface.js";
import { ConductorOrchestrator } from "./orchestrator.js";
import { PlanningEngine } from "./planning-engine.js";
import { MemoryQueueBackend } from "./queue-backend.js";
import { RuntimeManager } from "./runtime-manager.js";
import { TaskExecutor } from "./task-executor.js";
import { TaskRouter } from "./task-router.js";

/**
 * In-memory runtime persistence — the GhostStack route keeps no durable state
 * across process restarts, so task-executor checkpoints live in a plain Map.
 */
class InMemoryPersistence implements IRuntimePersistence {
  private store = new Map<string, unknown>();
  async saveState(key: string, state: unknown): Promise<void> {
    this.store.set(key, state);
  }
  async getState<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }
  async clearState(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** No-op logger — keeps orchestrator/executor output off the API server logs. */
const silentLogger: ILogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * Minimal in-memory config loader. The GhostStack route declares no managed
 * services, so every loader method resolves to an empty configuration.
 * `RuntimeManager.getActiveServices()` only consults `loadServices()` and
 * tolerates an empty result.
 */
class EmptyConfigLoader implements IConfigLoader {
  async loadPorts(): Promise<PortsConfig> {
    return { floci: 0, fcc: 0, mcp: 0, ollama: 0 };
  }
  async loadServices(): Promise<ServicesConfig> {
    return { services: {} };
  }
  async loadHealthchecks(): Promise<HealthchecksConfig> {
    return { healthchecks: {} };
  }
  async loadRuntime(): Promise<RuntimeConfig> {
    return {
      version: "0.0.0",
      environment: "runtime",
      primary_llm: "",
      local_backup: "",
      storage: { mode: "memory", interval_sec: 0 },
    };
  }
}

/** The orchestrator surface the conductor route depends on. */
export interface GhostStackOrchestrator {
  start(): Promise<string[]>;
  submitAndRun(
    objective: string,
    opts?: { maxIterations?: number; idleDelayMs?: number },
  ): Promise<{ planId: string; allowed: boolean; reason?: string; processed: number }>;
  getQueue(): {
    getQueueLength(): Promise<number>;
    getActiveJobs(): Promise<unknown[]>;
    getDeadLetterQueue(): Promise<unknown[]>;
    clearDeadLetterQueue(): Promise<void>;
  };
}

/**
 * Build a GhostStack-compatible orchestrator backed by @nexus/runtime.
 *
 * Wiring mirrors the route's previous construction:
 *   LocalAgentRegistry + LocalEventBus + RuntimeManager + TaskRouter +
 *   MemoryQueueBackend → ConductorOrchestrator.create(...).
 *
 * @returns the orchestrator plus the shared in-memory queue, so callers can
 *   surface live queue/dead-letter state on their status endpoints.
 */
export function createGhostStackOrchestrator(opts?: {
  /**
   * Execution adapters for the task executor. Defaults to none (the offline
   * GhostStack path). Callers with a configured LLM (e.g. the worker) can pass
   * an AgentRuntimeAdapter here to dispatch agentic coding tasks.
   */
  adapters?: IExecutionAdapter[];
}): {
  orchestrator: GhostStackOrchestrator;
  queue: MemoryQueueBackend;
} {
  const agentRegistry = new LocalAgentRegistry();
  const eventBus = new LocalEventBus();
  const runtimeManager = new RuntimeManager(new EmptyConfigLoader());
  const taskRouter = new TaskRouter(eventBus);
  // Share one queue instance so status / dead-letter endpoints reflect live state.
  const queue = new MemoryQueueBackend();

  // Cognitive engines + executor — without these submitAndRun() throws.
  // PlanningEngine() with no language model uses deterministic keyword/blueprint
  // planning, so the route works offline (no Groq/LLM key required).
  const planningEngine = new PlanningEngine();
  const governanceEngine = new GovernanceEngine();
  const executor = new TaskExecutor(
    queue,
    eventBus,
    new InMemoryPersistence(),
    silentLogger,
    opts?.adapters ?? [],
  );

  const orchestrator = ConductorOrchestrator.create({
    runtimeManager,
    eventBus,
    taskRouter,
    agentRegistry,
    queue,
    logger: silentLogger,
    executor,
    planningEngine,
    governanceEngine,
  }) as unknown as GhostStackOrchestrator;

  return { orchestrator, queue };
}
