// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/governance
 *
 * Runtime governance engine — ported from Ghoststack (Yash-Awasthi/Ghoststack).
 *
 * Provides constraint evaluation, policy enforcement, and guardrail checking
 * for the NEXUS task execution pipeline.
 *
 * Architecture (from ADR-0003, Ghoststack kernel):
 *   Constraints — hard rules that block execution (cost, scope, timeout)
 *   Policies    — soft rules that may require human approval (dangerous ops, wildcard perms)
 *   Guardrails  — runtime checks on plan-level or log-level data (loop detection, cost ceiling)
 */

export { GovernanceViolationError } from "@nexus/shared";

// ── Core types ─────────────────────────────────────────────────────────────────

export interface TaskGovernanceMetadata {
  dangerous?: boolean;
  costEstimate?: number;
  resourceScope?: string;
  maxExecutionMs?: number;
}

export interface ITaskSynthesisResult {
  taskId: string;
  serverName?: string;
  toolName?: string;
  action: string;
  arguments: Record<string, unknown>;
  dependencies: string[];
  priority: "low" | "medium" | "high";
  adapterType?: string;
  governanceMetadata?: TaskGovernanceMetadata;
}

export interface ICognitiveTrace {
  planId: string;
  objective: string;
  synthesisResults: ITaskSynthesisResult[];
  timestamp: Date;
}

export interface IExecutionConstraint {
  name: string;
  validate(task: ITaskSynthesisResult): { success: boolean; reason?: string };
}

export interface IExecutionPolicy {
  name: string;
  requiresApproval(task: ITaskSynthesisResult): boolean;
  validate(task: ITaskSynthesisResult): { success: boolean; reason?: string };
}

export interface IRuntimeGuardrail {
  name: string;
  check(tasks: ITaskSynthesisResult[], executionLogs: unknown[]): { success: boolean; reason?: string };
}

export interface IGovernanceEngine {
  registerConstraint(constraint: IExecutionConstraint): void;
  registerPolicy(policy: IExecutionPolicy): void;
  registerGuardrail(guardrail: IRuntimeGuardrail): void;
  evaluateTask(task: ITaskSynthesisResult): Promise<{ allowed: boolean; requiresApproval: boolean; reason?: string }>;
  evaluatePlan(plan: ICognitiveTrace): Promise<{ allowed: boolean; reason?: string }>;
}

// ── Constraints ────────────────────────────────────────────────────────────────

export class ResourceScopeConstraint implements IExecutionConstraint {
  name = "ResourceScopeConstraint";
  private readonly blockedScopes: string[];

  constructor(blockedScopes = ["system:root", "admin:direct"]) {
    this.blockedScopes = blockedScopes;
  }

  validate(task: ITaskSynthesisResult): { success: boolean; reason?: string } {
    const scope = task.governanceMetadata?.resourceScope ?? "";
    if (this.blockedScopes.includes(scope)) {
      return { success: false, reason: `Unauthorized resource scope: ${scope}` };
    }
    return { success: true };
  }
}

export class CostBudgetConstraint implements IExecutionConstraint {
  name = "CostBudgetConstraint";
  private readonly maxTaskCost: number;

  constructor(maxTaskCost = 0.5) {
    this.maxTaskCost = maxTaskCost;
  }

  validate(task: ITaskSynthesisResult): { success: boolean; reason?: string } {
    const cost = task.governanceMetadata?.costEstimate ?? 0;
    if (cost > this.maxTaskCost) {
      return { success: false, reason: `Cost estimate $${cost} exceeds task budget $${this.maxTaskCost}` };
    }
    return { success: true };
  }
}

export class TimeoutConstraint implements IExecutionConstraint {
  name = "TimeoutConstraint";
  private readonly maxExecutionMs: number;

  constructor(maxExecutionMs = 300_000) {
    this.maxExecutionMs = maxExecutionMs;
  }

  validate(task: ITaskSynthesisResult): { success: boolean; reason?: string } {
    const declared = task.governanceMetadata?.maxExecutionMs;
    if (typeof declared === "number" && declared > this.maxExecutionMs) {
      return { success: false, reason: `Declared maxExecutionMs ${declared}ms exceeds ceiling ${this.maxExecutionMs}ms` };
    }
    return { success: true };
  }
}

// ── Policies ───────────────────────────────────────────────────────────────────

export class DangerousOperationPolicy implements IExecutionPolicy {
  name = "DangerousOperationPolicy";

  requiresApproval(task: ITaskSynthesisResult): boolean {
    return task.governanceMetadata?.dangerous === true;
  }

  validate(_task: ITaskSynthesisResult): { success: boolean; reason?: string } {
    return { success: true };
  }
}

export class WildcardPermissionsPolicy implements IExecutionPolicy {
  name = "WildcardPermissionsPolicy";

  requiresApproval(task: ITaskSynthesisResult): boolean {
    const perms = task.arguments.permissions;
    return Array.isArray(perms) && perms.includes("*");
  }

  validate(_task: ITaskSynthesisResult): { success: boolean; reason?: string } {
    return { success: true };
  }
}

// ── Guardrails ─────────────────────────────────────────────────────────────────

export class LoopDetectionGuardrail implements IRuntimeGuardrail {
  name = "LoopDetectionGuardrail";
  private readonly maxCount: number;

  constructor(maxCount = 5) {
    this.maxCount = maxCount;
  }

  check(_tasks: ITaskSynthesisResult[], executionLogs: unknown[]): { success: boolean; reason?: string } {
    const counts = new Map<string, number>();
    for (const log of executionLogs) {
      const entry = log as Record<string, unknown>;
      const action = String(entry.action ?? entry.event ?? "");
      const n = (counts.get(action) ?? 0) + 1;
      counts.set(action, n);
      if (n > this.maxCount) {
        return { success: false, reason: `Loop detected: action '${action}' invoked ${n} times (max ${this.maxCount})` };
      }
    }
    return { success: true };
  }
}

export class RunawayRetriesGuardrail implements IRuntimeGuardrail {
  name = "RunawayRetriesGuardrail";
  private readonly maxRetries: number;

  constructor(maxRetries = 5) {
    this.maxRetries = maxRetries;
  }

  check(_tasks: ITaskSynthesisResult[], executionLogs: unknown[]): { success: boolean; reason?: string } {
    for (const log of executionLogs) {
      const entry = log as Record<string, unknown>;
      if (typeof entry.retries === "number" && entry.retries > this.maxRetries) {
        return { success: false, reason: `Runaway retries: ${entry.retries} exceeds max ${this.maxRetries}` };
      }
    }
    return { success: true };
  }
}

export class TaskGraphLimitGuardrail implements IRuntimeGuardrail {
  name = "TaskGraphLimitGuardrail";
  private readonly maxTasks: number;

  constructor(maxTasks = 10) {
    this.maxTasks = maxTasks;
  }

  check(tasks: ITaskSynthesisResult[], _logs: unknown[]): { success: boolean; reason?: string } {
    if (tasks.length > this.maxTasks) {
      return { success: false, reason: `Task graph has ${tasks.length} tasks; ceiling is ${this.maxTasks}` };
    }
    return { success: true };
  }
}

export class HighCostPlanGuardrail implements IRuntimeGuardrail {
  name = "HighCostPlanGuardrail";
  private readonly maxPlanCost: number;

  constructor(maxPlanCost = 5.0) {
    this.maxPlanCost = maxPlanCost;
  }

  check(tasks: ITaskSynthesisResult[], _logs: unknown[]): { success: boolean; reason?: string } {
    const total = tasks.reduce((s, t) => s + (t.governanceMetadata?.costEstimate ?? 0), 0);
    if (total > this.maxPlanCost) {
      return { success: false, reason: `Plan cost $${total.toFixed(2)} exceeds ceiling $${this.maxPlanCost}` };
    }
    return { success: true };
  }
}

export class DuplicateActionGuardrail implements IRuntimeGuardrail {
  name = "DuplicateActionGuardrail";
  private readonly maxDuplicates: number;

  constructor(maxDuplicates = 1) {
    this.maxDuplicates = maxDuplicates;
  }

  check(tasks: ITaskSynthesisResult[], _logs: unknown[]): { success: boolean; reason?: string } {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const n = (counts.get(task.action) ?? 0) + 1;
      counts.set(task.action, n);
      if (n > this.maxDuplicates) {
        return { success: false, reason: `Duplicate action '${task.action}' appears ${n} times (max ${this.maxDuplicates})` };
      }
    }
    return { success: true };
  }
}

// ── GovernanceEngine ───────────────────────────────────────────────────────────

export class GovernanceEngine implements IGovernanceEngine {
  private readonly constraints: IExecutionConstraint[] = [];
  private readonly policies: IExecutionPolicy[] = [];
  private readonly guardrails: IRuntimeGuardrail[] = [];

  registerConstraint(constraint: IExecutionConstraint): this {
    this.constraints.push(constraint);
    return this;
  }

  registerPolicy(policy: IExecutionPolicy): this {
    this.policies.push(policy);
    return this;
  }

  registerGuardrail(guardrail: IRuntimeGuardrail): this {
    this.guardrails.push(guardrail);
    return this;
  }

  async evaluateTask(task: ITaskSynthesisResult): Promise<{ allowed: boolean; requiresApproval: boolean; reason?: string }> {
    for (const constraint of this.constraints) {
      const res = constraint.validate(task);
      if (!res.success) {
        return { allowed: false, requiresApproval: false, reason: `${constraint.name}: ${res.reason}` };
      }
    }

    let requiresApproval = false;
    for (const policy of this.policies) {
      const res = policy.validate(task);
      if (!res.success) {
        return { allowed: false, requiresApproval: false, reason: `${policy.name}: ${res.reason}` };
      }
      if (policy.requiresApproval(task)) requiresApproval = true;
    }

    return { allowed: true, requiresApproval };
  }

  async evaluatePlan(plan: ICognitiveTrace): Promise<{ allowed: boolean; reason?: string }> {
    for (const guardrail of this.guardrails) {
      const res = guardrail.check(plan.synthesisResults, []);
      if (!res.success) {
        return { allowed: false, reason: `${guardrail.name}: ${res.reason}` };
      }
    }
    return { allowed: true };
  }

  async evaluateRuntimeLogs(
    tasks: ITaskSynthesisResult[],
    logs: unknown[],
  ): Promise<{ allowed: boolean; reason?: string }> {
    for (const guardrail of this.guardrails) {
      const res = guardrail.check(tasks, logs);
      if (!res.success) {
        return { allowed: false, reason: `${guardrail.name}: ${res.reason}` };
      }
    }
    return { allowed: true };
  }

  /** Create a pre-configured engine with all default constraints, policies, and guardrails. */
  static withDefaults(options?: {
    maxTaskCost?: number;
    maxPlanCost?: number;
    maxTasks?: number;
    maxRetries?: number;
    blockedScopes?: string[];
  }): GovernanceEngine {
    return new GovernanceEngine()
      .registerConstraint(new ResourceScopeConstraint(options?.blockedScopes))
      .registerConstraint(new CostBudgetConstraint(options?.maxTaskCost))
      .registerConstraint(new TimeoutConstraint())
      .registerPolicy(new DangerousOperationPolicy())
      .registerPolicy(new WildcardPermissionsPolicy())
      .registerGuardrail(new LoopDetectionGuardrail())
      .registerGuardrail(new RunawayRetriesGuardrail(options?.maxRetries))
      .registerGuardrail(new TaskGraphLimitGuardrail(options?.maxTasks))
      .registerGuardrail(new HighCostPlanGuardrail(options?.maxPlanCost))
      .registerGuardrail(new DuplicateActionGuardrail());
  }
}
