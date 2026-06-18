import { IRuntimeInspector, ITaskSnapshot, IQueueSnapshot, IEventSnapshot } from "./interfaces/observability.interface";
import { IMetricsCollector } from "./interfaces/observability.interface";
import { IQueueBackend } from "./interfaces/queue.interface";
import { IServiceDiscovery } from "./interfaces/discovery.interface";
import { IEventStore } from "./interfaces/persistence.interface";
import { IMCPRuntime, IMCPServerRegistry } from "./interfaces/mcp.interface";
import { IGovernanceEngine, IApprovalWorkflow, ICognitiveTrace } from "./interfaces/governance.interface";
import { IEnvironmentTelemetry, IFilesystemSandbox, IExecutionEnvironment } from "./interfaces/environment.interface";
import { IWorkflowRegistry, IWorkflowTelemetry } from "./interfaces/workflow.interface";

import type { IMemoryStore } from "./memory-store";
import type { IAgentBus, AgentMessage, AgentCapability } from "./agent-bus";
import type { CircuitBreaker } from "./circuit-breaker";

// Forward reference to avoid circular dependency — context type is used
// only at construction time via the static factory method.
export interface ConductorContextLike {
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
  workflowEngine: any;
  memoryStore: IMemoryStore;
  agentBus: IAgentBus;
  circuitBreaker: CircuitBreaker;
  circuitBreakerWrapper?: any;
  traceIndexer?: any;
}

export class RuntimeInspector implements IRuntimeInspector {
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
  private workflowEngine?: any;

  // New Layer: Unified Memory & Knowledge
  private memoryStore?: IMemoryStore;
  private agentBus?: IAgentBus;
  private circuitBreaker?: CircuitBreaker;

  /**
   * Static factory: construct from a context-like object instead of 20 positional params.
   * Usage: `RuntimeInspector.fromContext(ctx)` where ctx satisfies ConductorContextLike.
   */
  static fromContext(ctx: ConductorContextLike): RuntimeInspector {
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
      ctx.traceIndexer
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
    workflowEngine?: any,
    memoryStore?: IMemoryStore,
    agentBus?: IAgentBus,
    circuitBreaker?: CircuitBreaker,
    _circuitBreakerWrapper?: any,
    _traceIndexer?: any
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

  async getHealth(): Promise<any> {
    const services = await this.discovery.listServices();
    const anyUnhealthy = services.some((s) => s.status !== "healthy");
    return {
      status: anyUnhealthy && services.length > 0 ? "degraded" : "healthy",
      uptimeSeconds: Math.floor((Date.now() - this.bootTime.getTime()) / 1000),
      servicesCount: services.length
    };
  }

  async getMetrics(): Promise<any> {
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
          retries: Number(p.retries ?? 0)
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
      payload: r.payload
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
        retries: j.retries
      }))
    };
  }

  async getServices(): Promise<any[]> {
    const list = await this.discovery.listServices();
    return list.map((s) => ({
      name: s.name,
      status: s.status,
      lastCheck: s.lastCheck,
      port: s.details?.port,
      type: s.details?.type
    }));
  }

  async getMCPSummary(): Promise<any> {
    const metrics = this.mcpRuntime ? await this.mcpRuntime.getMetrics() : null;
    const list = this.mcpRegistry ? await this.mcpRegistry.listServers() : [];
    const logs = this.mcpRuntime ? await this.mcpRuntime.getExecutionsLog() : [];

    return {
      metrics,
      serversCount: list.length,
      executionsCount: logs.length
    };
  }

  async getMCPServers(): Promise<any[]> {
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

  async getMCPExecutions(): Promise<any[]> {
    return this.mcpRuntime ? await this.mcpRuntime.getExecutionsLog() : [];
  }

  // Cognitive Governance Endpoints
  async getGovernanceInfo(): Promise<any> {
    if (!this.governanceEngine) return {};
    const engine = this.governanceEngine as any;
    return {
      constraints: engine.getConstraints ? engine.getConstraints().map((c: any) => c.name) : [],
      policies: engine.getPolicies ? engine.getPolicies().map((p: any) => p.name) : [],
      guardrails: engine.getGuardrails ? engine.getGuardrails().map((g: any) => g.name) : []
    };
  }

  async getApprovalsList(): Promise<any[]> {
    return this.approvalWorkflow ? await this.approvalWorkflow.listRecords() : [];
  }

  async getPlansList(): Promise<ICognitiveTrace[]> {
    return [...this.plansLog];
  }

  async getGuardrailsInfo(): Promise<any> {
    if (!this.governanceEngine) return {};
    const engine = this.governanceEngine as any;
    const guardrails = engine.getGuardrails ? engine.getGuardrails() : [];
    return {
      activeGuardrailsCount: guardrails.length,
      stormThreshold: 5
    };
  }

  // Phase 7 Environment Inspection APIs
  getBrowserMetrics(): any {
    if (!this.browserTelemetry) return {};
    return {
      activeSessions: this.browserTelemetry.browserSessionsActive,
      navigationHistory: this.browserTelemetry.navigationHistory,
      totalBytesWritten: this.browserTelemetry.totalBytesWritten
    };
  }

  getScrapingMetrics(): any {
    if (!this.scrapingTelemetry) return {};
    return {
      totalBytesFetched: this.scrapingTelemetry.totalBytesFetched,
      navigationHistory: this.scrapingTelemetry.navigationHistory
    };
  }

  getSandboxMetrics(): any {
    if (!this.fsSandbox) return {};
    return {
      writeLog: this.fsSandbox.getWriteLog()
    };
  }

  getEnvironmentsList(): any[] {
    if (!this.envsList) return [];
    return this.envsList.map((e) => ({
      name: e.name,
      capabilities: e.capabilities
    }));
  }

  // Phase 8 Workflow Diagnostics Observability APIs
  getWorkflowsList(): any[] {
    if (!this.workflowRegistry) return [];
    return this.workflowRegistry.listWorkflows().map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      tasksCount: w.tasks.length
    }));
  }

  getWorkflowExecution(executionId: string): any {
    if (!this.workflowTelemetry) return null;
    const history = this.workflowTelemetry.getExecutionHistory();
    return history.find((e) => e.id === executionId) || null;
  }

  getWorkflowExecutionHistory(): any[] {
    if (!this.workflowTelemetry) return [];
    return this.workflowTelemetry.getExecutionHistory();
  }

  getWorkflowReplays(): any[] {
    if (!this.workflowTelemetry) return [];
    // Filter executions that have replay patterns
    return this.workflowTelemetry.getExecutionHistory().filter((e) => e.id.includes("replay"));
  }

  getWorkflowTemplates(): any[] {
    if (!this.workflowRegistry) return [];
    return this.workflowRegistry.listTemplates().map((t) => ({
      templateId: t.templateId,
      name: t.name,
      description: t.description
    }));
  }

  getWorkflowTelemetryStats(): any {
    if (!this.workflowTelemetry) return {};
    const history = this.workflowTelemetry.getExecutionHistory();
    return {
      totalExecutions: history.length,
      succeededCount: history.filter((h) => h.status === "succeeded").length,
      failedCount: history.filter((h) => h.status === "failed").length,
      rejectedCount: history.filter((h) => h.status === "rejected").length,
      pendingCount: history.filter((h) => h.status === "pending").length
    };
  }

  recordPlan(plan: ICognitiveTrace): void {
    this.plansLog.push(plan);
  }

  // ── Memory Store ────────────────────────────────────────────────

  async getMemoryStats(): Promise<any> {
    if (!this.memoryStore) return { available: false };
    const stats = await this.memoryStore.getStats();
    return {
      available: true,
      ...stats,
      oldest: stats.oldest?.toISOString(),
      newest: stats.newest?.toISOString()
    };
  }

  async getMemoryEntries(query?: {
    types?: string[];
    keyPrefix?: string;
    limit?: number;
  }): Promise<any[]> {
    if (!this.memoryStore) return [];
    const result = await this.memoryStore.query({
      types: query?.types as any,
      keyPrefix: query?.keyPrefix,
      limit: query?.limit || 20
    });
    return result.entries.map((e) => ({
      id: e.id,
      type: e.type,
      key: e.key,
      agentId: e.agentId,
      workflowId: e.workflowId,
      tags: e.tags,
      timestamp: e.timestamp.toISOString()
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

  getCircuitBreakerState(): any {
    if (!this.circuitBreaker) return { available: false };
    return {
      available: true,
      ...this.circuitBreaker.getMetrics()
    };
  }

  // ── Snapshots ─────────────────────────────────────────────────────

  async getSnapshots(): Promise<any> {
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
      circuitBreaker: this.getCircuitBreakerState()
    };
  }
}
