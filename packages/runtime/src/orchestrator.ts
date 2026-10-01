// SPDX-License-Identifier: Apache-2.0
import type { IAgentRegistry } from "./agent-registry.js";
import { TaskDependencyResolver } from "./dependency-resolver.js";
import type { IEventBus } from "./event-bus.js";
import type { ITaskDependencyResolver } from "./interfaces/execution.interface.js";
import type {
  IPlanningEngine,
  IGovernanceEngine,
  IApprovalWorkflow,
} from "./interfaces/governance.interface.js";
import type { ILogger } from "./interfaces/logger.interface.js";
import type { IMetricsCollector, ITraceRecorder } from "./interfaces/observability.interface.js";
import type { IEventStore } from "./interfaces/persistence.interface.js";
import type { IQueueBackend } from "./interfaces/queue.interface.js";
import { MemoryQueueBackend } from "./queue-backend.js";
import type { IRuntimeManager } from "./runtime-manager.js";
import type { TaskExecutor } from "./task-executor.js";
import { buildQueuePayloadFromTask } from "./task-payload.js";
import type { TaskRouter, Task } from "./task-router.js";

/** Minimal interface for optional diagnostic inspector injection. */
type InspectorLike = { recordPlan?(plan: unknown): void };

export class ConductorOrchestrator {
  private runtimeManager: IRuntimeManager;
  private eventBus: IEventBus;
  private taskRouter: TaskRouter;
  private agentRegistry: IAgentRegistry;
  private eventStore?: IEventStore;
  private logger?: ILogger;

  private resolver: ITaskDependencyResolver;
  private queue: IQueueBackend;
  private executor?: TaskExecutor;
  private metrics?: IMetricsCollector;
  private tracer?: ITraceRecorder;
  private bootTime = new Date();

  // Cognitive Governance Engines
  private planningEngine?: IPlanningEngine;
  private governanceEngine?: IGovernanceEngine;
  private approvalWorkflow?: IApprovalWorkflow;
  private inspector?: InspectorLike;

  constructor(
    runtimeManager: IRuntimeManager,
    eventBus: IEventBus,
    taskRouter: TaskRouter,
    agentRegistry: IAgentRegistry,
    eventStore?: IEventStore,
    logger?: ILogger,
    queue?: IQueueBackend,
    executor?: TaskExecutor,
    metrics?: IMetricsCollector,
    tracer?: ITraceRecorder,
    planningEngine?: IPlanningEngine,
    governanceEngine?: IGovernanceEngine,
    approvalWorkflow?: IApprovalWorkflow,
    inspector?: InspectorLike,
  ) {
    this.runtimeManager = runtimeManager;
    this.eventBus = eventBus;
    this.taskRouter = taskRouter;
    this.agentRegistry = agentRegistry;
    this.eventStore = eventStore;
    this.logger = logger;
    this.metrics = metrics;
    this.tracer = tracer;

    this.resolver = new TaskDependencyResolver();
    this.queue = queue ?? new MemoryQueueBackend();
    this.executor = executor;

    this.planningEngine = planningEngine;
    this.governanceEngine = governanceEngine;
    this.approvalWorkflow = approvalWorkflow;
    this.inspector = inspector;
  }

  /**
   * Options-object factory — preferred for new code.
   * The positional constructor is retained for backward compatibility.
   */
  static create(opts: {
    runtimeManager: IRuntimeManager;
    eventBus: IEventBus;
    taskRouter: TaskRouter;
    agentRegistry: IAgentRegistry;
    eventStore?: IEventStore;
    logger?: ILogger;
    queue?: IQueueBackend;
    executor?: TaskExecutor;
    metrics?: IMetricsCollector;
    tracer?: ITraceRecorder;
    planningEngine?: IPlanningEngine;
    governanceEngine?: IGovernanceEngine;
    approvalWorkflow?: IApprovalWorkflow;
    /** Optional custom dependency resolver — defaults to TaskDependencyResolver. */
    resolver?: ITaskDependencyResolver;
    inspector?: InspectorLike;
  }): ConductorOrchestrator {
    const inst = new ConductorOrchestrator(
      opts.runtimeManager,
      opts.eventBus,
      opts.taskRouter,
      opts.agentRegistry,
      opts.eventStore,
      opts.logger,
      opts.queue,
      opts.executor,
      opts.metrics,
      opts.tracer,
      opts.planningEngine,
      opts.governanceEngine,
      opts.approvalWorkflow,
      opts.inspector,
    );
    if (opts.resolver) inst.resolver = opts.resolver;
    return inst;
  }

  async start(): Promise<string[]> {
    const startTimeMs = Date.now();
    this.logger?.info("Starting Conductor Unified Orchestrator Core...");
    const traceSpan = this.tracer?.startSpan("orchestrator.start");

    if (this.eventStore) {
      this.logger?.info("Replaying historical state events for crash recovery...");
      const replayStart = Date.now();
      const events = await this.eventStore.replayEvents();
      for (const event of events) {
        await this.taskRouter.replayEvent(event);
      }
      const replayDuration = Date.now() - replayStart;
      this.metrics?.recordTiming("replay.duration", replayDuration);
      this.logger?.info(`Replayed ${events.length} events successfully.`);
    }

    const services = await this.runtimeManager.getActiveServices();
    this.logger?.info("Active services boot-checked successfully", { services });

    const bootstrapDuration = Date.now() - startTimeMs;
    this.metrics?.recordTiming("bootstrap.duration", bootstrapDuration);
    this.metrics?.recordGauge("orchestrator.uptime", 1);

    if (traceSpan) {
      this.tracer?.endSpan(traceSpan.spanId, { status: "success", servicesCount: services.length });
    }

    return services;
  }

  async submitAndExecuteTasks(
    tasks: Task[],
    maxIterations = 10_000,
    idleDelayMs = 100,
  ): Promise<number> {
    this.logger?.info(`Submitting ${tasks.length} tasks to dependency validation loop...`);
    const traceSpan = this.tracer?.startSpan("submit.tasks", undefined, { count: tasks.length });

    const sortedTasks = this.resolver.resolveOrder(tasks) as Task[];
    this.logger?.info("Tasks sorted in topological order", {
      sorted: sortedTasks.map((t) => t.id),
    });

    for (const task of sortedTasks) {
      await this.taskRouter.route(task);
      this.metrics?.increment("task.submitted");

      const { type: payloadType, payload: payloadPayload } = buildQueuePayloadFromTask(task);

      await this.queue.push({
        id: task.id,
        payload: {
          type: payloadType,
          payload: payloadPayload,
        },
        priority: (task.priority || "medium") as "low" | "medium" | "high",
        retries: 0,
        maxRetries: 3,
        createdAt: new Date(),
      });

      const length = await this.queue.getQueueLength();
      this.metrics?.recordGauge("queue.size", length);
    }

    let processed = 0;
    if (this.executor) {
      this.logger?.info("Driving executor run loop with exponential backoff support...");
      // Use runLoop — unlike a bare while loop, runLoop honours the retry backoff
      // delays set by executeNext after a failed task, preventing hot-spin retries.
      processed = await this.executor.runLoop(maxIterations, idleDelayMs);
      this.logger?.info("Executor run loop completed.", { processed });
    }

    if (traceSpan) {
      this.tracer?.endSpan(traceSpan.spanId, { status: "success", processed });
    }

    return processed;
  }

  async submitCognitiveObjective(
    objective: string,
    runOptions?: { maxIterations?: number; idleDelayMs?: number },
  ): Promise<{ planId: string; allowed: boolean; reason?: string; processed: number }> {
    if (!this.planningEngine || !this.governanceEngine) {
      throw new Error(
        "Cognitive Planning and Governance systems are not registered in the Orchestrator.",
      );
    }

    const plan = await this.planningEngine.generatePlan(objective);
    if (this.inspector && typeof this.inspector.recordPlan === "function") {
      this.inspector.recordPlan(plan);
    }

    // 1. Evaluate plan through global guardrails
    const planEval = await this.governanceEngine.evaluatePlan(plan);
    if (!planEval.allowed) {
      return { planId: plan.planId, allowed: false, reason: planEval.reason, processed: 0 };
    }

    let hasPendingApprovals = false;
    const tasksToExecute: Task[] = [];

    // 2. Validate individual synthesized tasks
    for (const synth of plan.synthesisResults) {
      const taskEval = await this.governanceEngine.evaluateTask(synth);
      if (!taskEval.allowed) {
        return { planId: plan.planId, allowed: false, reason: taskEval.reason, processed: 0 };
      }

      if (taskEval.requiresApproval) {
        hasPendingApprovals = true;
        if (this.approvalWorkflow) {
          await this.approvalWorkflow.createRequest(synth.taskId);
        }
      }

      tasksToExecute.push({
        id: synth.taskId,
        title: synth.action,
        description: `${synth.action} with ${JSON.stringify(synth.arguments)}`,
        priority: synth.priority,
        status: taskEval.requiresApproval ? "pending_approval" : "pending",
        dependencies: synth.dependencies,
        type: synth.adapterType ?? "floci",
        action: synth.action,
        arguments: synth.arguments,
      });
    }

    // 3. Dispatch execution ONLY if there are no safety approval blocks pending
    let processed = 0;
    if (!hasPendingApprovals) {
      processed = await this.submitAndExecuteTasks(
        tasksToExecute,
        runOptions?.maxIterations,
        runOptions?.idleDelayMs,
      );
    }

    return {
      planId: plan.planId,
      allowed: true,
      processed,
    };
  }

  getQueue(): IQueueBackend {
    return this.queue;
  }

  /**
   * Start the executor's continuous run loop, draining the queue until empty
   * or until `maxIterations` is reached.
   *
   * This is the primary way to run Conductor as a long-lived process:
   *   await orchestrator.start();
   *   await orchestrator.submitCognitiveObjective("deploy ingestion pipeline");
   *   const processed = await orchestrator.run();
   *
   * @param maxIterations  Safety ceiling — default 10 000.
   * @param idleDelayMs    Poll interval when the queue is empty (default 100ms).
   * @returns Number of tasks successfully executed.
   */
  async run(maxIterations = 10_000, idleDelayMs = 100): Promise<number> {
    if (!this.executor) {
      throw new Error(
        "Orchestrator has no TaskExecutor registered. Provide one via the constructor.",
      );
    }
    this.logger?.info("Orchestrator run loop starting", { maxIterations, idleDelayMs });
    const processed = await this.executor.runLoop(maxIterations, idleDelayMs);
    this.logger?.info("Orchestrator run loop completed", { processed });
    return processed;
  }

  /**
   * Submit a cognitive objective and immediately drain the queue.
   * Convenience wrapper for one-shot use cases.
   *
   * The queue is drained exactly once — inside `submitCognitiveObjective` →
   * `submitAndExecuteTasks` → `runLoop`. There is no second drain pass, so
   * the `processed` count is accurate and retry backoff is respected.
   */
  async submitAndRun(
    objective: string,
    runOptions?: { maxIterations?: number; idleDelayMs?: number },
  ): Promise<{ planId: string; allowed: boolean; reason?: string; processed: number }> {
    // Pass runOptions through so the caller can tune the underlying runLoop
    const result = await this.submitCognitiveObjective(objective, runOptions);
    // Queue is already drained by submitCognitiveObjective — no second run() needed
    return result;
  }
}
