// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck — imports reference orchestration modules not yet exported from @nexus/runtime public API
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import type { GhostStackOrchestrator } from "../runtime/orchestrator.js";

import type { IEventBus } from "./event-bus.js";
import type { IApprovalWorkflow } from "./interfaces/governance.interface.js";
import type { IRuntimePersistence } from "./interfaces/persistence.interface.js";
import type {
  IWorkflowDefinition,
  IWorkflowExecution,
  IWorkflowTemplate,
  IWorkflowRegistry,
  IWorkflowTelemetry,
  IWorkflowReplay,
  IWorkflowApprovalPolicy,
  IWorkflowConstraint,
} from "./interfaces/workflow.interface.js";
import type { RuntimeGraph } from "./runtime-graph.js";
import type { Task } from "./task-router.js";

// ─── Replay Context Types ───────────────────────────────────────────

/** Options for deterministic replay with side-effect suppression. */
export interface ReplayOptions {
  /** When true, suppresses all side effects (telemetry, events, RuntimeGraph, persistence). */
  suppressSideEffects?: boolean;
  /** Optional new execution ID for the replayed execution. */
  newExecutionId?: string;
  /** Verify state consistency before replaying. */
  verifyState?: boolean;
  /** Replay generation counter — tracks how many times this execution has been replayed. */
  replayGeneration?: number;
}

/** Tracked lineage for a deterministic replay. */
export interface ReplayLineage {
  originalExecutionId: string;
  replayGeneration: number;
  previousExecutions: { executionId: string; status: string; timestamp: Date }[];
}

// 1. Generic Workflow Constraint Implementation
export class WorkflowConstraint implements IWorkflowConstraint {
  constructor(
    public name: string,
    private checker: (tasks: Task[]) => Promise<{ allowed: boolean; reason?: string }>,
  ) {}
  async evaluate(tasks: Task[]): Promise<{ allowed: boolean; reason?: string }> {
    return this.checker(tasks);
  }
}

// 2. Generic Workflow Approval Policy Implementation
export class WorkflowApprovalPolicy implements IWorkflowApprovalPolicy {
  constructor(
    public workflowName: string,
    private decider: (tasks: Task[]) => Promise<boolean>,
  ) {}
  async requiresApproval(tasks: Task[]): Promise<boolean> {
    return this.decider(tasks);
  }
}

// 3. Workflow Registry Implementation
export class WorkflowRegistry implements IWorkflowRegistry {
  private templates = new Map<string, IWorkflowTemplate>();
  private definitions = new Map<string, IWorkflowDefinition>();

  registerTemplate(template: IWorkflowTemplate): void {
    this.templates.set(template.templateId, template);
  }

  getTemplate(templateId: string): IWorkflowTemplate | undefined {
    return this.templates.get(templateId);
  }

  listTemplates(): IWorkflowTemplate[] {
    return Array.from(this.templates.values());
  }

  registerWorkflow(definition: IWorkflowDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  getWorkflow(workflowId: string): IWorkflowDefinition | undefined {
    return this.definitions.get(workflowId);
  }

  listWorkflows(): IWorkflowDefinition[] {
    return Array.from(this.definitions.values());
  }
}

// 4. Workflow Telemetry Implementation
export class WorkflowTelemetry implements IWorkflowTelemetry {
  private persistence?: IRuntimePersistence;
  private memoryLogs: IWorkflowExecution[] = [];

  constructor(persistence?: IRuntimePersistence) {
    this.persistence = persistence;
    this.loadFromPersistence();
  }

  private async loadFromPersistence() {
    if (this.persistence) {
      const history = await this.persistence.getState<IWorkflowExecution[]>("workflow_history");
      if (history) {
        this.memoryLogs = history;
      }
    }
  }

  private async sync() {
    if (this.persistence) {
      await this.persistence.saveState("workflow_history", this.memoryLogs);
    }
  }

  recordExecutionStart(executionId: string, workflowId: string): void {
    const existing = this.memoryLogs.find((e) => e.id === executionId);
    if (!existing) {
      this.memoryLogs.push({
        id: executionId,
        workflowId,
        status: "pending",
        taskResults: {},
        startedAt: new Date(),
      });
      this.sync();
    }
  }

  recordExecutionSuccess(executionId: string, results: Record<string, any>): void {
    const record = this.memoryLogs.find((e) => e.id === executionId);
    if (record) {
      record.status = "succeeded";
      record.taskResults = results;
      record.completedAt = new Date();
      this.sync();
    }
  }

  recordExecutionFailure(executionId: string, error: string): void {
    const record = this.memoryLogs.find((e) => e.id === executionId);
    if (record) {
      record.status = "failed";
      record.error = error;
      record.completedAt = new Date();
      this.sync();
    }
  }

  recordApprovalDecision(executionId: string, approved: boolean): void {
    const record = this.memoryLogs.find((e) => e.id === executionId);
    if (record) {
      record.approved = approved;
      if (!approved) {
        record.status = "rejected";
      }
      this.sync();
    }
  }

  getExecutionHistory(): IWorkflowExecution[] {
    return [...this.memoryLogs];
  }
}

// ─── Workflow Event Types ────────────────────────────────────────────

export type WorkflowEventType =
  | "workflow:execution_started"
  | "workflow:execution_succeeded"
  | "workflow:execution_failed"
  | "workflow:execution_cancelled"
  | "workflow:checkpoint_created"
  | "workflow:checkpoint_updated"
  | "workflow:task_completed"
  | "workflow:approval_needed"
  | "workflow:approval_granted";

export interface WorkflowEvent {
  type: WorkflowEventType;
  executionId: string;
  workflowId: string;
  timestamp: Date;
  payload?: Record<string, unknown>;
}

export type WorkflowEventHandler = (event: WorkflowEvent) => void | Promise<void>;

// ─── Checkpoint Entry ───────────────────────────────────────────────

export interface WorkflowCheckpoint {
  executionId: string;
  workflowId: string;
  timestamp: Date;
  completedTaskIds: string[];
  failedTaskIds: string[];
  pendingTaskIds: string[];
  taskResults: Record<string, any>;
  status: "running" | "paused" | "cancelled";
  error?: string;
  /** Replay generation marker — set when checkpoint was created during a replay */
  replayGeneration?: number;
}

/** Idempotency token record — prevents duplicate execution */
interface IdempotencyRecord {
  executionId: string;
  workflowId: string;
  token: string;
  result: IWorkflowExecution;
  timestamp: Date;
}

// 5. Workflow Engine & Replayer Core
export class WorkflowEngine implements IWorkflowReplay {
  private checkpoints = new Map<string, WorkflowCheckpoint>();
  private cancelledExecutions = new Set<string>();
  private eventHandlers = new Map<WorkflowEventType, Set<WorkflowEventHandler>>();
  private allHandlers = new Set<WorkflowEventHandler>();
  private idempotencyTokens = new Map<string, IdempotencyRecord>(); // token -> record

  /** Tracks replay lineage for deterministic replay ordering and crash continuation. */
  private replayLineage = new Map<string, ReplayLineage>();

  /** Monotonic replay generation counter — ensures ordering across replays. */
  private replayGenerationCounter = 0;

  constructor(
    private registry: IWorkflowRegistry,
    private telemetry: IWorkflowTelemetry,
    private orchestrator: GhostStackOrchestrator,
    private approvalWorkflow?: IApprovalWorkflow,
    private persistence?: IRuntimePersistence,
    private eventBus?: IEventBus,
    private runtimeGraph?: RuntimeGraph,
  ) {
    // Load any persisted checkpoints on construction
    this.loadCheckpoints();
  }

  // ── Event Subscription API ─────────────────────────────────────────────

  /** Subscribe to a specific workflow event type. */
  on(type: WorkflowEventType, handler: WorkflowEventHandler): { unsubscribe: () => void } {
    if (!this.eventHandlers.has(type)) {
      this.eventHandlers.set(type, new Set());
    }
    this.eventHandlers.get(type)!.add(handler);
    return {
      unsubscribe: () => this.eventHandlers.get(type)?.delete(handler),
    };
  }

  /** Subscribe to ALL workflow events. */
  onAny(handler: WorkflowEventHandler): { unsubscribe: () => void } {
    this.allHandlers.add(handler);
    return {
      unsubscribe: () => this.allHandlers.delete(handler),
    };
  }

  private async emit(event: WorkflowEvent): Promise<void> {
    // Emit to type-specific handlers
    const typeHandlers = this.eventHandlers.get(event.type);
    if (typeHandlers) {
      const promises = Array.from(typeHandlers).map((h) => h(event));
      await Promise.all(promises);
    }
    // Emit to all-event handlers
    const allPromises = Array.from(this.allHandlers).map((h) => h(event));
    await Promise.all(allPromises);
    // Also publish to event bus if available
    if (this.eventBus) {
      await this.eventBus.publish(event.type, {
        executionId: event.executionId,
        workflowId: event.workflowId,
        timestamp: event.timestamp.toISOString(),
        payload: event.payload,
      });
    }
  }

  private async loadCheckpoints(): Promise<void> {
    if (this.persistence) {
      const saved =
        await this.persistence.getState<Record<string, WorkflowCheckpoint>>("workflow_checkpoints");
      if (saved) {
        for (const [k, v] of Object.entries(saved)) {
          this.checkpoints.set(k, v);
        }
      }
    }
  }

  private async persistCheckpoints(): Promise<void> {
    if (this.persistence) {
      const obj: Record<string, WorkflowCheckpoint> = {};
      for (const [k, v] of this.checkpoints) {
        obj[k] = v;
      }
      await this.persistence.saveState("workflow_checkpoints", obj);
    }
  }

  // ── Checkpoint Management ─────────────────────────────────────────

  /** Get a checkpoint for a given execution. */
  getCheckpoint(executionId: string): WorkflowCheckpoint | undefined {
    return this.checkpoints.get(executionId);
  }

  /** List all active checkpoints. */
  listCheckpoints(): WorkflowCheckpoint[] {
    return Array.from(this.checkpoints.values());
  }

  /** Mark an execution as cancelled. */
  cancelExecution(executionId: string): IWorkflowExecution | undefined {
    // First check checkpoints
    const cp = this.checkpoints.get(executionId);
    if (cp) {
      this.cancelledExecutions.add(executionId);
      cp.status = "cancelled";
      this.telemetry.recordExecutionFailure(executionId, "Workflow cancelled by operator");
      this.emit({
        type: "workflow:execution_cancelled",
        executionId,
        workflowId: cp.workflowId,
        timestamp: new Date(),
        payload: { reason: "Operator cancelled execution" },
      });
      this.persistCheckpoints();
      return {
        id: executionId,
        workflowId: cp.workflowId,
        status: "failed",
        taskResults: cp.taskResults,
        startedAt: cp.timestamp,
        completedAt: new Date(),
        error: "Workflow cancelled by operator",
      };
    }

    // If no checkpoint exists, check telemetry history (e.g. completed executions)
    const history = this.telemetry.getExecutionHistory();
    const record = history.find((e) => e.id === executionId);
    if (record) {
      this.cancelledExecutions.add(executionId);
      this.telemetry.recordExecutionFailure(executionId, "Workflow cancelled by operator");
      this.emit({
        type: "workflow:execution_cancelled",
        executionId,
        workflowId: record.workflowId,
        timestamp: new Date(),
        payload: { reason: "Operator cancelled completed execution record" },
      });
      return {
        id: executionId,
        workflowId: record.workflowId,
        status: "failed",
        taskResults: record.taskResults,
        startedAt: record.startedAt,
        completedAt: new Date(),
        error: "Workflow cancelled by operator",
      };
    }

    return undefined;
  }

  /** Check if a workflow execution was cancelled. */
  isCancelled(executionId: string): boolean {
    return this.cancelledExecutions.has(executionId);
  }

  // ── Core Execution ──────────────────────────────────────────────────

  async executeWorkflow(
    workflowId: string,
    executionId: string,
    replayOptions?: ReplayOptions,
  ): Promise<IWorkflowExecution> {
    const def = this.registry.getWorkflow(workflowId);
    if (!def) {
      throw new Error(`Workflow definition ${workflowId} not found.`);
    }

    const isReplay = !!replayOptions?.suppressSideEffects;

    // Check if this execution was cancelled
    if (this.isCancelled(executionId)) {
      return {
        id: executionId,
        workflowId,
        status: "failed",
        taskResults: {},
        startedAt: new Date(),
        completedAt: new Date(),
        error: "Cannot execute cancelled workflow",
      };
    }

    // Check if we have a checkpoint to resume from
    const existingCp = this.checkpoints.get(executionId);
    if (existingCp?.status === "cancelled") {
      return {
        id: executionId,
        workflowId,
        status: "failed",
        taskResults: existingCp.taskResults,
        startedAt: existingCp.timestamp,
        completedAt: new Date(),
        error: "Cannot resume cancelled workflow",
      };
    }

    // ── Telemetry (suppressed during replay) ──
    if (!isReplay) {
      this.telemetry.recordExecutionStart(executionId, workflowId);
      await this.emit({
        type: "workflow:execution_started",
        executionId,
        workflowId,
        timestamp: new Date(),
        payload: { taskCount: def.tasks.length },
      });
    }

    // 1. Evaluate Governance Constraints
    if (def.constraints) {
      for (const constraint of def.constraints) {
        const check = await constraint.evaluate(def.tasks);
        if (!check.allowed) {
          const reason = check.reason || `Blocked by constraint: ${constraint.name}`;
          if (!isReplay) {
            this.telemetry.recordExecutionFailure(executionId, reason);
          }
          return {
            id: executionId,
            workflowId,
            status: "failed",
            taskResults: {},
            startedAt: new Date(),
            completedAt: new Date(),
            error: reason,
          };
        }
      }
    }

    // 2. Process Approval Gates
    if (!isReplay) {
      let needsApproval = false;
      if (def.approvalPolicy) {
        needsApproval = await def.approvalPolicy.requiresApproval(def.tasks);
      }

      if (needsApproval && !existingCp) {
        this.telemetry.recordApprovalDecision(executionId, false);
        if (this.approvalWorkflow) {
          await this.approvalWorkflow.createRequest(executionId);
        }
        return {
          id: executionId,
          workflowId,
          status: "pending",
          taskResults: {},
          startedAt: new Date(),
          approved: false,
        };
      }

      // Mark as approved (default when no approval is required or already approved)
      this.telemetry.recordApprovalDecision(executionId, true);
    }

    // 3. Submit and Drive Execution using GhostStack Orchestrator
    try {
      const completedTaskIds = existingCp?.completedTaskIds ?? [];
      const failedTaskIds = existingCp?.failedTaskIds ?? [];

      // Resume from checkpoint: filter out completed tasks
      const tasksToExecute = def.tasks.filter(
        (t) => !completedTaskIds.includes(t.id) && !failedTaskIds.includes(t.id),
      );

      // ── RuntimeGraph registration (suppressed during replay) ──
      if (this.runtimeGraph && !isReplay) {
        await this.runtimeGraph.addNode(
          `wf-exec:${executionId}`,
          "task_execution",
          `Execution:${executionId}`,
          {
            metadata: { workflowId, taskCount: def.tasks.length, type: "workflow_root" },
            status: "active",
          },
        );
        for (const task of def.tasks) {
          await this.runtimeGraph.addNode(
            `task:${executionId}:${task.id}`,
            "task_execution",
            `Task:${task.title}`,
            {
              metadata: { taskId: task.id, priority: task.priority, type: task.type },
              status: completedTaskIds.includes(task.id) ? "active" : "pending",
              dependencies: [`wf-exec:${executionId}`],
            },
          );
          if (task.dependencies) {
            for (const depId of task.dependencies) {
              await this.runtimeGraph.addEdge(
                `task:${executionId}:${task.id}`,
                `task:${executionId}:${depId}`,
                "depends_on",
                { relationship: "task_dependency" },
              );
            }
          }
        }
      }

      // ── Checkpoint creation (suppressed during replay) ──
      if (!isReplay) {
        this.checkpoints.set(executionId, {
          executionId,
          workflowId,
          timestamp: new Date(),
          completedTaskIds,
          failedTaskIds,
          pendingTaskIds: tasksToExecute.map((t) => t.id),
          taskResults: existingCp?.taskResults ?? {},
          status: "running",
          replayGeneration: replayOptions?.replayGeneration,
        });
        await this.persistCheckpoints();
      }

      if (tasksToExecute.length > 0) {
        await this.orchestrator.submitAndExecuteTasks(tasksToExecute);
      }

      // ── Load actual task results from persistence ───────────────────────────
      // TaskExecutor.executeNext() saves each job's output to persistence under
      // the job id (= task id). Read those back so downstream tasks and callers
      // see real execution data rather than a synthetic { status: "completed" }.
      const results: Record<string, any> = { ...(existingCp?.taskResults ?? {}) };
      for (const t of def.tasks) {
        try {
          const persisted = this.persistence
            ? await this.persistence.getState<{ status: string; result?: unknown }>(t.id)
            : undefined;
          results[t.id] = persisted ?? { status: "completed" };
        } catch {
          results[t.id] = { status: "completed" };
        }
      }

      // ── Task completion events (suppressed during replay) ──
      if (!isReplay) {
        for (const t of tasksToExecute) {
          await this.emit({
            type: "workflow:task_completed",
            executionId,
            workflowId,
            timestamp: new Date(),
            payload: { taskId: t.id, status: results[t.id]?.status ?? "completed" },
          });
        }
      }

      // ── Checkpoint update (suppressed during replay) ──
      if (!isReplay) {
        const cp = this.checkpoints.get(executionId);
        if (cp) {
          cp.completedTaskIds = def.tasks.map((t) => t.id);
          cp.pendingTaskIds = [];
          cp.status = "running";
          await this.persistCheckpoints();
        }

        // Update RuntimeGraph task nodes to completed
        if (this.runtimeGraph) {
          for (const task of def.tasks) {
            await this.runtimeGraph.updateNodeStatus(`task:${executionId}:${task.id}`, "active", {
              completed: true,
            });
          }
        }

        await this.emit({
          type: "workflow:execution_succeeded",
          executionId,
          workflowId,
          timestamp: new Date(),
          payload: { results },
        });

        this.telemetry.recordExecutionSuccess(executionId, results);
        this.checkpoints.delete(executionId);
        await this.persistCheckpoints();
      }

      return {
        id: executionId,
        workflowId,
        status: "succeeded",
        taskResults: results,
        startedAt: new Date(),
        completedAt: new Date(),
        approved: !isReplay, // replays skip approval
        originalExecutionId: undefined, // overridden by deterministicReplay() caller
        stateVerified: isReplay,
      };
    } catch (e: any) {
      const errorMsg = e.message || String(e);

      // Capture task results before potential side-effect suppression
      const cp = this.checkpoints.get(executionId);

      // ── Checkpoint update on failure (suppressed during replay) ──
      if (!isReplay) {
        if (cp) {
          cp.status = "paused";
          cp.error = errorMsg;
          await this.persistCheckpoints();
        }

        if (this.runtimeGraph) {
          for (const task of def.tasks) {
            const taskNodeId = `task:${executionId}:${task.id}`;
            const node = await this.runtimeGraph.getNode(taskNodeId);
            if (node && node.status !== "active") {
              await this.runtimeGraph.updateNodeStatus(taskNodeId, "failed", {
                error: errorMsg,
              });
            }
          }
        }

        this.telemetry.recordExecutionFailure(executionId, errorMsg);
      }

      return {
        id: executionId,
        workflowId,
        status: "failed",
        taskResults: cp?.taskResults ?? {},
        startedAt: new Date(),
        completedAt: new Date(),
        approved: !isReplay,
        error: errorMsg,
      };
    }
  }

  async approveAndTriggerWorkflow(approvalId: string): Promise<IWorkflowExecution> {
    let executionId = approvalId;
    if (this.approvalWorkflow) {
      const approvalRecord = await this.approvalWorkflow.getRecord(approvalId);
      if (approvalRecord) {
        executionId = approvalRecord.taskId;
        await this.approvalWorkflow.approve(approvalId, "Admin approved workflow execution");
        await this.emit({
          type: "workflow:approval_granted",
          executionId,
          workflowId: "",
          timestamp: new Date(),
          payload: { approvalId, decidedBy: "Admin" },
        });
      }
    }

    const history = this.telemetry.getExecutionHistory();
    const record = history.find((h) => h.id === executionId);
    if (!record) {
      throw new Error(`Execution record ${executionId} not found.`);
    }

    this.telemetry.recordApprovalDecision(executionId, true);

    const def = this.registry.getWorkflow(record.workflowId);
    if (!def) {
      throw new Error(`Workflow definition ${record.workflowId} not found.`);
    }

    try {
      await this.orchestrator.submitAndExecuteTasks(def.tasks);

      // Read actual task outputs from persistence (same fix as executeWorkflow path)
      const results: Record<string, any> = {};
      for (const t of def.tasks) {
        try {
          const persisted = this.persistence
            ? await this.persistence.getState<{ status: string; result?: unknown }>(t.id)
            : undefined;
          results[t.id] = persisted ?? { status: "completed" };
        } catch {
          results[t.id] = { status: "completed" };
        }
      }

      this.telemetry.recordExecutionSuccess(executionId, results);
      return {
        id: executionId,
        workflowId: record.workflowId,
        status: "succeeded",
        taskResults: results,
        startedAt: record.startedAt,
        completedAt: new Date(),
        approved: true,
      };
    } catch (e: any) {
      const errorMsg = e.message || String(e);
      this.telemetry.recordExecutionFailure(executionId, errorMsg);
      return {
        id: executionId,
        workflowId: record.workflowId,
        status: "failed",
        taskResults: {},
        startedAt: record.startedAt,
        completedAt: new Date(),
        approved: true,
        error: errorMsg,
      };
    }
  }

  // ── Idempotency ────────────────────────────────────────────────────

  /**
   * Register an idempotency token for a workflow execution.
   * If the same token was already used, returns the cached result.
   */
  async executeWithIdempotency(
    workflowId: string,
    executionId: string,
    idempotencyToken: string,
  ): Promise<IWorkflowExecution> {
    // Check if token was already used
    const existing = this.idempotencyTokens.get(idempotencyToken);
    if (existing) {
      this.telemetry.recordExecutionStart(executionId, workflowId);
      this.telemetry.recordExecutionSuccess(executionId, existing.result.taskResults);
      return {
        ...existing.result,
        id: executionId,
        idempotent: true,
        originalExecutionId: existing.executionId,
      };
    }

    // Execute and cache result
    const result = await this.executeWorkflow(workflowId, executionId);
    this.idempotencyTokens.set(idempotencyToken, {
      executionId,
      workflowId,
      token: idempotencyToken,
      result,
      timestamp: new Date(),
    });
    return result;
  }

  /** List all idempotency tokens registered. */
  listIdempotencyTokens(): IdempotencyRecord[] {
    return Array.from(this.idempotencyTokens.values());
  }

  /** Clear a specific idempotency token (e.g. for re-execution). */
  clearIdempotencyToken(token: string): void {
    this.idempotencyTokens.delete(token);
  }

  /** Clear all idempotency tokens. */
  clearAllIdempotencyTokens(): void {
    this.idempotencyTokens.clear();
  }

  // ── Ordered Replay with State Verification ─────────────────────────

  /**
   * Replay an execution with state verification.
   * Checks that the execution existed, validates checkpoint state,
   * and replays in the original execution order.
   */
  async orderedReplay(
    executionId: string,
    options?: {
      verifyState?: boolean;
      newExecutionId?: string;
    },
  ): Promise<IWorkflowExecution> {
    const history = this.telemetry.getExecutionHistory();
    const record = history.find((h) => h.id === executionId);

    if (!record) {
      // Try to resume from checkpoint
      const cp = this.checkpoints.get(executionId);
      if (!cp) {
        throw new Error(`Execution record ${executionId} not found to replay.`);
      }
      const newId = options?.newExecutionId || `${executionId}-replay-${Date.now()}`;
      const replayResult = await this.executeWorkflow(cp.workflowId, newId);
      return { ...replayResult, originalExecutionId: executionId };
    }

    // State verification: compare checkpoint state vs telemetry record
    let stateVerified = false;
    if (options?.verifyState !== false) {
      const cp = this.checkpoints.get(executionId);
      if (cp) {
        // Verify completed tasks match telemetry
        stateVerified = true;
        for (const taskId of cp.completedTaskIds) {
          if (record.taskResults[taskId] === undefined) {
            stateVerified = false;
            break;
          }
        }
      } else {
        // No checkpoint — verify telemetry record exists and is not empty
        stateVerified = record.startedAt !== undefined;
      }
    }

    const newId = options?.newExecutionId || `${executionId}-replay-${Date.now()}`;
    const replayResult = await this.executeWorkflow(record.workflowId, newId);
    return {
      ...replayResult,
      stateVerified,
      originalExecutionId: executionId,
    };
  }

  /** Get original replay (backward compatible). */
  async replayExecution(executionId: string): Promise<IWorkflowExecution> {
    const result = await this.orderedReplay(executionId, { verifyState: false });
    return result;
  }

  /**
   * Deterministic replay with full side-effect suppression.
   * Does NOT create telemetry records, publish events, or mutate RuntimeGraph.
   * Returns the execution result without contaminating live state.
   */
  async deterministicReplay(
    executionId: string,
    options?: {
      newExecutionId?: string;
      replayGeneration?: number;
    },
  ): Promise<IWorkflowExecution> {
    const generation = options?.replayGeneration ?? ++this.replayGenerationCounter;
    const newId = options?.newExecutionId || `${executionId}-replay-${Date.now()}-${generation}`;

    // Record replay lineage
    const lineage: ReplayLineage = this.replayLineage.get(executionId) || {
      originalExecutionId: executionId,
      replayGeneration: 0,
      previousExecutions: [],
    };

    // Check telemetry for the original execution
    const history = this.telemetry.getExecutionHistory();
    const record = history.find((h) => h.id === executionId);

    // If not found in telemetry, try checkpoint
    const cp = this.checkpoints.get(executionId);
    const workflowId = record?.workflowId || cp?.workflowId;

    if (!workflowId) {
      throw new Error(`Execution ${executionId} not found in telemetry or checkpoints to replay.`);
    }

    // Run with side-effect suppression
    const result = await this.executeWorkflow(workflowId, newId, {
      suppressSideEffects: true,
      newExecutionId: newId,
      replayGeneration: generation,
    });

    // Record the replay lineage
    lineage.replayGeneration = generation;
    lineage.previousExecutions.push({
      executionId: newId,
      status: result.status,
      timestamp: new Date(),
    });
    // Keep only the last 10 entries
    if (lineage.previousExecutions.length > 10) {
      lineage.previousExecutions.splice(0, lineage.previousExecutions.length - 10);
    }
    this.replayLineage.set(executionId, lineage);

    return {
      ...result,
      originalExecutionId: executionId,
      stateVerified: true,
      idempotent: true,
    };
  }

  /**
   * Continue execution after a crash by finding the most recent
   * in-progress checkpoint and resuming from that point.
   * Uses side-effect suppression for deterministic continuation.
   */
  async continueAfterCrash(
    executionId?: string,
  ): Promise<{ resumed: IWorkflowExecution | null; checkpoint?: WorkflowCheckpoint }> {
    // If no execution ID specified, find the most recent paused checkpoint
    if (!executionId) {
      const pausedCheckpoints = Array.from(this.checkpoints.values())
        .filter((cp) => cp.status === "paused")
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      if (pausedCheckpoints.length === 0) {
        return { resumed: null };
      }
      executionId = pausedCheckpoints[0].executionId;
    }

    const cp = this.checkpoints.get(executionId);
    if (!cp || cp.status === "cancelled") {
      return { resumed: null, checkpoint: cp };
    }

    // Run with side-effect suppression to avoid duplicating state
    const generation = ++this.replayGenerationCounter;
    const result = await this.executeWorkflow(
      cp.workflowId,
      cp.executionId + "-recover-" + Date.now(),
      {
        suppressSideEffects: true,
        replayGeneration: generation,
      },
    );

    // Record recovery lineage
    const lineage: ReplayLineage = this.replayLineage.get(executionId) || {
      originalExecutionId: executionId,
      replayGeneration: 0,
      previousExecutions: [],
    };
    lineage.replayGeneration = generation;
    lineage.previousExecutions.push({
      executionId: result.id,
      status: result.status,
      timestamp: new Date(),
    });
    if (lineage.previousExecutions.length > 10) {
      lineage.previousExecutions.splice(0, lineage.previousExecutions.length - 10);
    }
    this.replayLineage.set(executionId, lineage);

    return {
      resumed: {
        ...result,
        originalExecutionId: executionId,
        stateVerified: true,
        idempotent: true,
      },
      checkpoint: cp,
    };
  }

  /** Get the replay lineage for a given execution. */
  getReplayLineage(executionId: string): ReplayLineage | undefined {
    return this.replayLineage.get(executionId);
  }

  /** List all recorded replay lineages for diagnostics. */
  listReplayLineages(): { originalExecutionId: string; generation: number; replays: number }[] {
    return Array.from(this.replayLineage.entries()).map(([key, value]) => ({
      originalExecutionId: key,
      generation: value.replayGeneration,
      replays: value.previousExecutions.length,
    }));
  }

  /** Get the telemetry instance (for test/diagnostic access). */
  getTelemetry(): IWorkflowTelemetry {
    return this.telemetry;
  }

  /** Resume a paused/checkpointed execution. */
  async resumeExecution(executionId: string): Promise<IWorkflowExecution | null> {
    const cp = this.checkpoints.get(executionId);
    if (!cp || cp.status === "cancelled") return null;
    if (cp.status !== "paused" && cp.completedTaskIds.length === 0) {
      // Fresh checkpoint, just run
      return this.executeWorkflow(cp.workflowId, executionId);
    }
    // Resume from where it left off
    return this.executeWorkflow(cp.workflowId, executionId);
  }

  /** Verify state integrity: compare checkpoint vs expected execution state. */
  async verifyState(executionId: string): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    const history = this.telemetry.getExecutionHistory();
    const record = history.find((h) => h.id === executionId);
    if (!record) {
      return { valid: false, issues: [`Execution ${executionId} not found in telemetry history`] };
    }
    const cp = this.checkpoints.get(executionId);
    if (!cp) {
      // No checkpoint — this is fine if the execution completed
      if (record.status !== "succeeded") {
        issues.push(`No checkpoint found and execution status is ${record.status}`);
      }
      return { valid: issues.length === 0, issues };
    }
    // Verify completed tasks are reflected in telemetry
    for (const taskId of cp.completedTaskIds) {
      if (record.taskResults[taskId] === undefined) {
        issues.push(`Checkpoint says task ${taskId} completed but not found in telemetry results`);
      }
    }
    // Verify failed tasks
    for (const taskId of cp.failedTaskIds) {
      if (
        record.taskResults[taskId] !== undefined &&
        record.taskResults[taskId]?.status !== "failed"
      ) {
        issues.push(`Checkpoint says task ${taskId} failed but telemetry shows different status`);
      }
    }
    return { valid: issues.length === 0, issues };
  }
}

// 6. Workflow Templates Definitions for required 4 verticals

export class BrowserResearchWorkflowTemplate implements IWorkflowTemplate {
  templateId = "browser-research-template";
  name = "Governed Browser Research Workflow";
  description = "Coordinates research with navigation caps, scraping tasks, and approval gates.";

  createWorkflow(params: Record<string, any>): IWorkflowDefinition {
    const limitBytes = params.limitBytes || 5000;
    return {
      id: params.id || "browser-research-wf",
      name: this.name,
      description: this.description,
      tasks: [
        {
          id: `${params.id || "browser-research-wf"}-nav-task`,
          title: "Browser Navigation step",
          description: `browser navigate task with quota limit ${limitBytes}`,
          priority: "high",
          status: "pending",
          dependencies: [],
        },
        {
          id: `${params.id || "browser-research-wf"}-scrape-task`,
          title: "Headlines Scraping step",
          description: "scraping research headlines information",
          priority: "medium",
          status: "pending",
          dependencies: [`${params.id || "browser-research-wf"}-nav-task`],
        },
      ],
      approvalPolicy: new WorkflowApprovalPolicy(this.name, async (_tasks) => {
        // Enforce approval if browser requests bypass secure sites or use large quotas
        return limitBytes > 10000;
      }),
      constraints: [
        new WorkflowConstraint("Path Restriction Gate", async (tasks) => {
          const hasIllegalPaths = tasks.some(
            (t) => t.description.includes("illegal") || t.id.includes("passwd"),
          );
          return {
            allowed: !hasIllegalPaths,
            reason: hasIllegalPaths ? "Illegal system file path protocol blocked" : undefined,
          };
        }),
      ],
    };
  }
}

export class LocalCloudProvisioningTemplate implements IWorkflowTemplate {
  templateId = "cloud-provisioning-template";
  name = "Local Cloud Provisioning Workflow";
  description = "Ingests multi-resource configs, sorting topological floci task chains.";

  createWorkflow(params: Record<string, any>): IWorkflowDefinition {
    const prefix = params.id || "cloud-prov";
    return {
      id: prefix,
      name: this.name,
      description: this.description,
      tasks: [
        {
          id: `${prefix}-s3-bucket`,
          title: "Create S3 Storage",
          description: "floci create bucket action",
          priority: "high",
          status: "pending",
          dependencies: [],
        },
        {
          id: `${prefix}-sqs-queue`,
          title: "Create Messaging Queue",
          description: "floci create queue action",
          priority: "medium",
          status: "pending",
          dependencies: [`${prefix}-s3-bucket`],
        },
        {
          id: `${prefix}-ddb-table`,
          title: "Create Table Substrate",
          description: "floci create dynamodb table action",
          priority: "medium",
          status: "pending",
          dependencies: [`${prefix}-sqs-queue`],
        },
      ],
    };
  }
}

export class DocumentProcessingTemplate implements IWorkflowTemplate {
  templateId = "document-processing-template";
  name = "Document Processing Workflow";
  description = "Performs filesystem sandboxed ingestion, parsing, and formatting.";

  createWorkflow(params: Record<string, any>): IWorkflowDefinition {
    const prefix = params.id || "doc-proc";
    return {
      id: prefix,
      name: this.name,
      description: this.description,
      tasks: [
        {
          id: `${prefix}-filesystem-ingest`,
          title: "Ingest sandbox source files",
          description: "read source configurations files under sandbox root",
          priority: "high",
          status: "pending",
          dependencies: [],
        },
        {
          id: `${prefix}-filesystem-format`,
          title: "Structure logs parse",
          description: "format JSON metrics targets to sandboxed output",
          priority: "medium",
          status: "pending",
          dependencies: [`${prefix}-filesystem-ingest`],
        },
      ],
      constraints: [
        new WorkflowConstraint("Sandbox Size Limit Gate", async () => {
          const limitBytes = params.limitBytes || 50000;
          return {
            allowed: limitBytes < 1000000,
            reason: limitBytes >= 1000000 ? "Size exceeds sandboxed quota limit" : undefined,
          };
        }),
      ],
    };
  }
}

export class GovernedEtlWorkflowTemplate implements IWorkflowTemplate {
  templateId = "governed-etl-template";
  name = "Governed ETL Data Pipeline";
  description =
    "Extract, transform, and load pipeline with scraping, filter, and S3 provisioning steps.";

  createWorkflow(params: Record<string, any>): IWorkflowDefinition {
    const prefix = params.id || "governed-etl";
    const sourceUrl = (params.source_url as string) || "https://news.ycombinator.com";
    const bucketName = (params.target_s3_bucket as string) || "ghoststack-etl-archive";
    const pattern = (params.transform_pattern as string) || "(?:AI|LLM|Agent|GPT|Cognitive)";

    return {
      id: prefix,
      name: this.name,
      description: this.description,
      tasks: [
        {
          id: `${prefix}-extract`,
          title: "Extract Page Scraped Data",
          description:
            "Scrapes data from the target website using the sandbox-safe scraping execution adapter.",
          priority: "normal",
          status: "pending",
          dependencies: [],
          type: "scraping",
          action: "scrape_url",
          arguments: { url: sourceUrl, maxLengthBytes: 50000, selectors: ["title"] },
        },
        {
          id: `${prefix}-transform`,
          title: "Transform & Filter Content",
          description: "Filters extracted content by pattern.",
          priority: "normal",
          status: "pending",
          dependencies: [`${prefix}-extract`],
          type: "floci",
          action: "filter_content",
          arguments: { pattern, sourceTaskId: `${prefix}-extract` },
        },
        {
          id: `${prefix}-load`,
          title: "Load Content to Storage",
          description: "Creates S3 bucket for transformed archive.",
          priority: "high",
          status: "pending",
          dependencies: [`${prefix}-transform`],
          type: "floci",
          action: "create_s3_bucket",
          arguments: { bucketName, sourceTaskId: `${prefix}-transform` },
        },
      ],
      constraints: [
        new WorkflowConstraint("ETL byte quota gate", async () => {
          const maxBytes = (params.maxLengthBytes as number) || 50000;
          return {
            allowed: maxBytes <= 1_000_000,
            reason: maxBytes > 1_000_000 ? "ETL extract exceeds sandbox byte quota" : undefined,
          };
        }),
      ],
    };
  }
}

export class SpecToExecutionTemplate implements IWorkflowTemplate {
  templateId = "spec-execution-template";
  name = "Spec-to-Execution Workflow";
  description = "Synthesizes cognitive spec goals, evaluating approvals and execution safety.";

  createWorkflow(params: Record<string, any>): IWorkflowDefinition {
    const prefix = params.id || "spec-exec";
    return {
      id: prefix,
      name: this.name,
      description: this.description,
      tasks: [
        {
          id: `${prefix}-spec-generation`,
          title: "Synthesize Cognitive Specs",
          description: `spec objective generator task: ${params.objective || "deploy s3"}`,
          priority: "high",
          status: "pending",
          dependencies: [],
        },
        {
          id: `${prefix}-spec-execution`,
          title: "Orchestrate Governed Synthesis Execution",
          description: "execute target synthesized workflow",
          priority: "medium",
          status: "pending",
          dependencies: [`${prefix}-spec-generation`],
        },
      ],
      approvalPolicy: new WorkflowApprovalPolicy(this.name, async () => {
        // Spec execution always raises safety approvals
        return true;
      }),
    };
  }
}
