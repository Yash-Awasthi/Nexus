// SPDX-License-Identifier: Apache-2.0
import type { IAgentBus, AgentMessage, AgentCapability } from "./agent-bus.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { IServiceDiscovery } from "./interfaces/discovery.interface.js";
import type {
  IEnvironmentTelemetry,
  IFilesystemSandbox,
  IExecutionEnvironment,
} from "./interfaces/environment.interface.js";
import type {
  IGovernanceEngine,
  IApprovalWorkflow,
  ICognitiveTrace,
} from "./interfaces/governance.interface.js";
import type { IMCPRuntime, IMCPServerRegistry } from "./interfaces/mcp.interface.js";
import type {
  IRuntimeInspector,
  ITaskSnapshot,
  IQueueSnapshot,
  IEventSnapshot,
  IMetricsCollector,
} from "./interfaces/observability.interface.js";
import type { IEventStore } from "./interfaces/persistence.interface.js";
import type { IQueueBackend } from "./interfaces/queue.interface.js";
import type { IWorkflowRegistry, IWorkflowTelemetry } from "./interfaces/workflow.interface.js";
import type { IMemoryStore } from "./memory-store.js";

// Forward reference to avoid circular dependency — context type is used
// only at construction time via the static factory method.
interface GhostStackContextLike {
  metrics: IMetricsCollector;
  queue: IQueueBackend;
  discovery: IServiceDiscovery;
  eventStore: IEventStore;
  governanceEngine?: IGovernanceEngine;
  approval: IApprovalWorkflow;
  browserTelemetry: IEnvironmentTelemetry;
  scrapingTelemetry: IEnvironmentTelemetry;
  registry: IWorkflowRegistry;
  workflowTelemetry: IWorkflowTelemetry;
  workflowEngine: unknown;
  memoryStore: IMemoryStore;
  agentBus: IAgentBus;
  circuitBreaker: CircuitBreaker;
  circuitBreakerWrapper?: unknown;
  traceIndexer?: unknown;
}

// ── Extended inspector interface — superset of IRuntimeInspector ──────────────
// Captures all extended diagnostic methods on RuntimeInspector so callers
// (e.g. RuntimeDiagnosticAPI) can type-check without casting to any.
export interface IExtendedRuntimeInspector extends IRuntimeInspector {
  getMCPSummary(): Promise<unknown>;
  getMCPServers(): Promise<unknown[]>;
  getMCPTools(): Promise<string[]>;
  getMCPExecutions(): Promise<unknown[]>;
  getGovernanceInfo(): Promise<unknown>;
  getApprovalsList(): Promise<unknown[]>;
  getPlansList(): Promise<ICognitiveTrace[]>;
  getGuardrailsInfo(): Promise<unknown>;
  getBrowserMetrics(): unknown;
  getScrapingMetrics(): unknown;
  getSandboxMetrics(): unknown;
  getEnvironmentsList(): unknown[];
  getWorkflowsList(): unknown[];
  getWorkflowExecution(executionId: string): unknown;
  getWorkflowExecutionHistory(): unknown[];
  getWorkflowReplays(): unknown[];
  getWorkflowTemplates(): unknown[];
  getWorkflowTelemetryStats(): unknown;
  getMemoryStats(): Promise<unknown>;
  getMemoryEntries(query?: {
    types?: string[];
    keyPrefix?: string;
    limit?: number;
  }): Promise<unknown[]>;
  getAgentCapabilities(): Promise<AgentCapability[]>;
  getAgentMessages(options?: { limit?: number }): Promise<AgentMessage[]>;
  getCircuitBreakerState(): unknown;
  recordPlan(plan: ICognitiveTrace): void;
}

export class RuntimeInspector implements IExtendedRuntimeInspector {
  private metrics: IMetricsCollector;
  private queue: IQueueBackend;
  private discovery: IServiceDiscovery;
  private eventStore: IEventStore;
  private mcpRuntime?: IMCPRuntime;
  private mcpRegistry?: IMCPServerRegistry;
  private governanceEngine?: IGovernanceEngine;
  private approvalWorkflow?: IApprovalWorkflow;
  private plansLog: ICognitiveTrace[] = [];
  private bootTime = new Date();

  // Environment Telemetry Context
  private browserTelemetry?: IEnvironmentTelemetry;
  private scrapingTelemetry?: IEnvironmentTelemetry;
  private fsSandbox?: IFilesystemSandbox;
  private envsList?: IExecutionEnvironment[];

  // Phase 8 Workflow Core Abstractions Context
  private workflowRegistry?: IWorkflowRegistry;
  private workflowTelemetry?: IWorkflowTelemetry;
  private workflowEngine?: unknown;

  // New Layer: Unified Memory & Knowledge
  private memoryStore?: IMemoryStore;
  private agentBus?: IAgentBus;
  private circuitBreaker?: CircuitBreaker;

  /**
   * Static factory: construct from a context-like object instead of 20 positional params.
   * Usage: `RuntimeInspector.fromContext(ctx)` where ctx satisfies GhostStackContextLike.
   */
  static fromContext(ctx: GhostStackContextLike): RuntimeInspector {
    return new RuntimeInspector(
      ctx.metrics,
      ctx.queue,
      ctx.discovery,
      ctx.eventStore,
      undefined,
      undefined,
      ctx.governanceEngine,
      ctx.approval,
      ctx.browserTelemetry,
      ctx.scrapingTelemetry,
      undefined,
      undefined,
      ctx.registry,
      ctx.workflowTelemetry,
      ctx.workflowEngine,
      ctx.memoryStore,
      ctx.agentBus,
      ctx.circuitBreaker,
      ctx.circuitBreakerWrapper,
      ctx.traceIndexer,
    );
  }

  constructor(
    metrics: IMetricsCollector,
    queue: IQueueBackend,
    discovery: IServiceDiscovery,
    eventStore: IEventStore,
    mcpRuntime?: IMCPRuntime,
    mcpRegistry?: IMCPServerRegistry,
    governanceEngine?: IGovernanceEngine,
    approvalWorkflow?: IApprovalWorkflow,
    browserTelemetry?: IEnvironmentTelemetry,
    scrapingTelemetry?: IEnvironmentTelemetry,
    fsSandbox?: IFilesystemSandbox,
    envsList?: IExecutionEnvironment[],
    workflowRegistry?: IWorkflowRegistry,
    workflowTelemetry?: IWorkflowTelemetry,
    workflowEngine?: unknown,
    memoryStore?: IMemoryStore,
    agentBus?: IAgentBus,
    circuitBreaker?: CircuitBreaker,
    _circuitBreakerWrapper?: unknown,
    _traceIndexer?: unknown,
  ) {
    this.metrics = metrics;
    this.queue = queue;
    this.discovery = discovery;
    this.eventStore = eventStore;
    this.mcpRuntime = mcpRuntime;
    this.mcpRegistry = mcpRegistry;
    this.governanceEngine = governanceEngine;
    this.approvalWorkflow = approvalWorkflow;

    this.browserTelemetry = browserTelemetry;
    this.scrapingTelemetry = scrapingTelemetry;
    this.fsSandbox = fsSandbox;
    this.envsList = envsList;

    this.workflowRegistry = workflowRegistry;
    this.workflowTelemetry = workflowTelemetry;
    this.workflowEngine = workflowEngine;

    this.memoryStore = memoryStore;
    this.agentBus = agentBus;
    this.circuitBreaker = circuitBreaker;
  }

  async getHealth(): Promise<unknown> {
    const services = await this.discovery.listServices();
    const anyUnhealthy = services.some((s) => s.status !== "healthy");
    return {
      status: anyUnhealthy && services.length > 0 ? "degraded" : "healthy",
      uptimeSeconds: Math.floor((Date.now() - this.bootTime.getTime()) / 1000),
      servicesCount: services.length,
    };
  }

  async getMetrics(): Promise<unknown> {
    return this.metrics.getMetrics();
  }

  async getTasks(): Promise<ITaskSnapshot[]> {
    const events = await this.eventStore.replayEvents();
    const taskMap = new Map<string, ITaskSnapshot>();

    for (const event of events) {
      // Event payloads come from a dynamic JSON log — cast to a loose record for access
      const p = event.payload as Record<string, unknown>;
      if (event.event === "task_routed" || event.event === "task_queued") {
        taskMap.set(String(p.id ?? ""), {
          id: String(p.id ?? ""),
          status: String(p.status ?? "queued"),
          priority: String(p.priority ?? "medium"),
          dependencies: Array.isArray(p.dependencies) ? p.dependencies.map(String) : [],
          retries: Number(p.retries ?? 0),
        });
      } else if (event.event === "execution_succeeded") {
        const existing = taskMap.get(String(p.taskId ?? ""));
        if (existing) {
          existing.status = "succeeded";
          existing.executionTimeMs = typeof p.durationMs === "number" ? p.durationMs : undefined;
        }
      } else if (event.event === "execution_failed") {
        const existing = taskMap.get(String(p.taskId ?? ""));
        if (existing) {
          existing.status = "failed";
          existing.retries = Number(p.attempts ?? existing.retries);
        }
      }
    }
    return Array.from(taskMap.values());
  }

  async getEvents(): Promise<IEventSnapshot[]> {
    const replayed = await this.eventStore.replayEvents();
    return replayed.map((r) => ({
      event: r.event,
      timestamp: r.timestamp || new Date(),
      payload: r.payload,
    }));
  }

  async getQueues(): Promise<IQueueSnapshot> {
    const dlq = await this.queue.getDeadLetterQueue();
    const activeCount = await this.queue.getQueueLength();
    const activeJobs = await this.queue.getActiveJobs();

    return {
      activeJobsCount: activeCount,
      deadLetterJobsCount: dlq.length,
      jobs: activeJobs.map((j) => ({
        id: j.id,
        priority: j.priority,
        retries: j.retries,
      })),
    };
  }

  async getServices(): Promise<unknown[]> {
    const list = await this.discovery.listServices();
    return list.map((s) => ({
      name: s.name,
      status: s.status,
      lastCheck: s.lastCheck,
      port: (s.details as Record<string, unknown>)?.port,
      type: (s.details as Record<string, unknown>)?.type,
    }));
  }

  async getMCPSummary(): Promise<unknown> {
    const metrics = this.mcpRuntime ? await this.mcpRuntime.getMetrics() : null;
    const list = this.mcpRegistry ? await this.mcpRegistry.listServers() : [];
    const logs = this.mcpRuntime ? await this.mcpRuntime.getExecutionsLog() : [];

    return {
      metrics,
      serversCount: list.length,
      executionsCount: logs.length,
    };
  }

  async getMCPServers(): Promise<unknown[]> {
    return this.mcpRegistry ? await this.mcpRegistry.listServers() : [];
  }

  async getMCPTools(): Promise<string[]> {
    if (!this.mcpRegistry) return [];
    const servers = await this.mcpRegistry.listServers();
    const tools: string[] = [];
    for (const s of servers) {
      tools.push(...s.tools.map((t) => `${s.name}:${t}`));
    }
    return tools;
  }

  async getMCPExecutions(): Promise<unknown[]> {
    return this.mcpRuntime ? await this.mcpRuntime.getExecutionsLog() : [];
  }

  // Cognitive Governance Endpoints
  async getGovernanceInfo(): Promise<unknown> {
    if (!this.governanceEngine) return {};
    type ExtEngine = IGovernanceEngine & {
      getConstraints?(): { name: string }[];
      getPolicies?(): { name: string }[];
      getGuardrails?(): { name: string }[];
    };
    const engine = this.governanceEngine as ExtEngine;
    return {
      constraints: engine.getConstraints ? engine.getConstraints().map((c) => c.name) : [],
      policies: engine.getPolicies ? engine.getPolicies().map((p) => p.name) : [],
      guardrails: engine.getGuardrails ? engine.getGuardrails().map((g) => g.name) : [],
    };
  }

  async getApprovalsList(): Promise<unknown[]> {
    return this.approvalWorkflow ? await this.approvalWorkflow.listRecords() : [];
  }

  async getPlansList(): Promise<ICognitiveTrace[]> {
    return [...this.plansLog];
  }

  async getGuardrailsInfo(): Promise<unknown> {
    if (!this.governanceEngine) return {};
    type ExtEngine = IGovernanceEngine & { getGuardrails?(): { name: string }[] };
    const engine = this.governanceEngine as ExtEngine;
    const guardrails = engine.getGuardrails ? engine.getGuardrails() : [];
    return {
      activeGuardrailsCount: guardrails.length,
      stormThreshold: 5,
    };
  }

  // Phase 7 Environment Inspection APIs
  getBrowserMetrics(): unknown {
    if (!this.browserTelemetry) return {};
    return {
      activeSessions: this.browserTelemetry.browserSessionsActive,
      navigationHistory: this.browserTelemetry.navigationHistory,
      totalBytesWritten: this.browserTelemetry.totalBytesWritten,
    };
  }

  getScrapingMetrics(): unknown {
    if (!this.scrapingTelemetry) return {};
    return {
      totalBytesFetched: this.scrapingTelemetry.totalBytesFetched,
      navigationHistory: this.scrapingTelemetry.navigationHistory,
    };
  }

  getSandboxMetrics(): unknown {
    if (!this.fsSandbox) return {};
    return {
      writeLog: this.fsSandbox.getWriteLog(),
    };
  }

  getEnvironmentsList(): unknown[] {
    if (!this.envsList) return [];
    return this.envsList.map((e) => ({
      name: e.name,
      capabilities: e.capabilities,
    }));
  }

  // Phase 8 Workflow Diagnostics Observability APIs
  getWorkflowsList(): unknown[] {
    if (!this.workflowRegistry) return [];
    return this.workflowRegistry.listWorkflows().map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      tasksCount: w.tasks.length,
    }));
  }

  getWorkflowExecution(executionId: string): unknown {
    if (!this.workflowTelemetry) return null;
    const history = this.workflowTelemetry.getExecutionHistory();
    return history.find((e) => e.id === executionId) || null;
  }

  getWorkflowExecutionHistory(): unknown[] {
    if (!this.workflowTelemetry) return [];
    return this.workflowTelemetry.getExecutionHistory();
  }

  getWorkflowReplays(): unknown[] {
    if (!this.workflowTelemetry) return [];
    // Filter executions that have replay patterns
    return this.workflowTelemetry.getExecutionHistory().filter((e) => e.id.includes("replay"));
  }

  getWorkflowTemplates(): unknown[] {
    if (!this.workflowRegistry) return [];
    return this.workflowRegistry.listTemplates().map((t) => ({
      templateId: t.templateId,
      name: t.name,
      description: t.description,
    }));
  }

  getWorkflowTelemetryStats(): unknown {
    if (!this.workflowTelemetry) return {};
    const history = this.workflowTelemetry.getExecutionHistory();
    return {
      totalExecutions: history.length,
      succeededCount: history.filter((h) => h.status === "succeeded").length,
      failedCount: history.filter((h) => h.status === "failed").length,
      rejectedCount: history.filter((h) => h.status === "rejected").length,
      pendingCount: history.filter((h) => h.status === "pending").length,
    };
  }

  recordPlan(plan: ICognitiveTrace): void {
    this.plansLog.push(plan);
  }

  // ── Memory Store ────────────────────────────────────────────────

  async getMemoryStats(): Promise<unknown> {
    if (!this.memoryStore) return { available: false };
    const stats = await this.memoryStore.getStats();
    return {
      available: true,
      ...stats,
      oldest: stats.oldest?.toISOString(),
      newest: stats.newest?.toISOString(),
    };
  }

  async getMemoryEntries(query?: {
    types?: string[];
    keyPrefix?: string;
    limit?: number;
  }): Promise<unknown[]> {
    if (!this.memoryStore) return [];
    const result = await this.memoryStore.query({
      types: query?.types as
        | ("error" | "observation" | "decision" | "result" | "state" | "knowledge")[]
        | undefined,
      keyPrefix: query?.keyPrefix,
      limit: query?.limit || 20,
    });
    return result.entries.map((e) => ({
      id: e.id,
      type: e.type,
      key: e.key,
      agentId: e.agentId,
      workflowId: e.workflowId,
      tags: e.tags,
      timestamp: e.timestamp.toISOString(),
    }));
  }

  // ── Agent Bus ────────────────────────────────────────────────────

  async getAgentCapabilities(): Promise<AgentCapability[]> {
    if (!this.agentBus) return [];
    return this.agentBus.getCapabilities();
  }

  async getAgentMessages(options?: { limit?: number }): Promise<AgentMessage[]> {
    if (!this.agentBus) return [];
    return this.agentBus.getMessages({ limit: options?.limit || 20 });
  }

  // ── Circuit Breaker ────────────────────────────────────────────────

  getCircuitBreakerState(): unknown {
    if (!this.circuitBreaker) return { available: false };
    return {
      available: true,
      ...this.circuitBreaker.getMetrics(),
    };
  }

  // ── Snapshots ─────────────────────────────────────────────────────

  async getSnapshots(): Promise<unknown> {
    return {
      timestamp: new Date(),
      health: await this.getHealth(),
      metrics: await this.getMetrics(),
      queues: await this.getQueues(),
      services: await this.getServices(),
      events: await this.getEvents(),
      tasks: await this.getTasks(),
      mcp: await this.getMCPSummary(),
      governance: await this.getGovernanceInfo(),
      memory: await this.getMemoryStats(),
      circuitBreaker: this.getCircuitBreakerState(),
    };
  }
}
