import {
  IGovernanceEngine,
  IExecutionConstraint,
  IExecutionPolicy,
  IRuntimeGuardrail,
  ITaskSynthesisResult,
  ICognitiveTrace
} from "./interfaces/governance.interface.js";

// 1. Core Constraints implementations
export class ResourceScopeConstraint implements IExecutionConstraint {
  name = "ResourceScopeConstraint";
  private blockedScopes: string[];

  constructor(blockedScopes = ["system:root", "admin:direct"]) {
    this.blockedScopes = blockedScopes;
  }

  validate(task: ITaskSynthesisResult): { success: boolean; reason?: string } {
    const scope = task.governanceMetadata?.resourceScope || "";
    if (this.blockedScopes.includes(scope)) {
      return { success: false, reason: `Unauthorized resource scope block: ${scope}` };
    }
    return { success: true };
  }
}

export class CostBudgetConstraint implements IExecutionConstraint {
  name = "CostBudgetConstraint";
  private maxTaskCost: number;

  constructor(maxTaskCost = 0.5) {
    this.maxTaskCost = maxTaskCost;
  }

  validate(task: ITaskSynthesisResult): { success: boolean; reason?: string } {
    const cost = task.governanceMetadata?.costEstimate || 0;
    if (cost > this.maxTaskCost) {
      return {
        success: false,
        reason: `Execution cost estimate $${cost} exceeds task budget limit of $${this.maxTaskCost}`
      };
    }
    return { success: true };
  }
}

// 2. Core Policies implementations
export class DangerousOperationPolicy implements IExecutionPolicy {
  name = "DangerousOperationPolicy";

  requiresApproval(task: ITaskSynthesisResult): boolean {
    return task.governanceMetadata?.dangerous === true;
  }

  validate(_task: ITaskSynthesisResult): { success: boolean; reason?: string } {
    // Allows dangerous tasks ONLY if they are routed through approval workflows
    return { success: true };
  }
}

export class WildcardPermissionsPolicy implements IExecutionPolicy {
  name = "WildcardPermissionsPolicy";

  requiresApproval(task: ITaskSynthesisResult): boolean {
    const args = task.arguments || {};
    if (Array.isArray(args.permissions) && args.permissions.includes("*")) {
      return true;
    }
    return false;
  }

  validate(_task: ITaskSynthesisResult): { success: boolean; reason?: string } {
    return { success: true };
  }
}

// 3. Core Guardrails implementations
export class LoopDetectionGuardrail implements IRuntimeGuardrail {
  name = "LoopDetectionGuardrail";
  private actionMaxCount: number;

  constructor(actionMaxCount = 5) {
    this.actionMaxCount = actionMaxCount;
  }

  check(tasks: ITaskSynthesisResult[], executionLogs: any[]): { success: boolean; reason?: string } {
    const actionCounts = new Map<string, number>();
    for (const log of executionLogs) {
      const action = log.action || log.event || "";
      actionCounts.set(action, (actionCounts.get(action) || 0) + 1);
      if ((actionCounts.get(action) || 0) > this.actionMaxCount) {
        return {
          success: false,
          reason: `Orchestration loop protection triggered: action '${action}' invoked ${actionCounts.get(action)} times`
        };
      }
    }
    return { success: true };
  }
}

export class RunawayRetriesGuardrail implements IRuntimeGuardrail {
  name = "RunawayRetriesGuardrail";
  private maxRetries: number;

  constructor(maxRetries = 5) {
    this.maxRetries = maxRetries;
  }

  check(tasks: ITaskSynthesisResult[], executionLogs: any[]): { success: boolean; reason?: string } {
    for (const log of executionLogs) {
      if (log.retries && log.retries > this.maxRetries) {
        return {
          success: false,
          reason: `Runaway retry guardrail triggered: retries count ${log.retries} exceeds limit ${this.maxRetries}`
        };
      }
    }
    return { success: true };
  }
}

export class TaskGraphLimitGuardrail implements IRuntimeGuardrail {
  name = "TaskGraphLimitGuardrail";
  private maxTasksCount: number;

  constructor(maxTasksCount = 10) {
    this.maxTasksCount = maxTasksCount;
  }

  check(tasks: ITaskSynthesisResult[], _executionLogs: any[]): { success: boolean; reason?: string } {
    if (tasks.length > this.maxTasksCount) {
      return {
        success: false,
        reason: `Task graph complexity ceiling exceeded: synthesized ${tasks.length} tasks (max ${this.maxTasksCount})`
      };
    }
    return { success: true };
  }
}

export class TimeoutConstraint implements IExecutionConstraint {
  name = "TimeoutConstraint";
  private maxExecutionMs: number;

  constructor(maxExecutionMs = 300_000 /* 5 min */) {
    this.maxExecutionMs = maxExecutionMs;
  }

  validate(task: ITaskSynthesisResult): { success: boolean; reason?: string } {
    const declared = (task.governanceMetadata as any)?.maxExecutionMs;
    if (typeof declared === "number" && declared > this.maxExecutionMs) {
      return {
        success: false,
        reason: `Declared maxExecutionMs ${declared}ms exceeds ceiling ${this.maxExecutionMs}ms for task ${task.taskId}`
      };
    }
    return { success: true };
  }
}

export class HighCostPlanGuardrail implements IRuntimeGuardrail {
  name = "HighCostPlanGuardrail";
  private maxPlanCost: number;

  constructor(maxPlanCost = 5.0) {
    this.maxPlanCost = maxPlanCost;
  }

  check(tasks: ITaskSynthesisResult[], _executionLogs: any[]): { success: boolean; reason?: string } {
    const totalCost = tasks.reduce((sum, t) => sum + (t.governanceMetadata?.costEstimate ?? 0), 0);
    if (totalCost > this.maxPlanCost) {
      return {
        success: false,
        reason: `Plan total cost estimate $${totalCost.toFixed(2)} exceeds plan budget ceiling $${this.maxPlanCost}`
      };
    }
    return { success: true };
  }
}

export class DuplicateActionGuardrail implements IRuntimeGuardrail {
  name = "DuplicateActionGuardrail";
  private maxDuplicates: number;

  constructor(maxDuplicates = 1) {
    this.maxDuplicates = maxDuplicates;
  }

  check(tasks: ITaskSynthesisResult[], _executionLogs: any[]): { success: boolean; reason?: string } {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const count = (counts.get(task.action) ?? 0) + 1;
      counts.set(task.action, count);
      if (count > this.maxDuplicates) {
        return {
          success: false,
          reason: `Duplicate action guardrail: action '${task.action}' appears ${count} times in plan (max ${this.maxDuplicates})`
        };
      }
    }
    return { success: true };
  }
}

// 4. Governance Engine Core
export class GovernanceEngine implements IGovernanceEngine {
  private constraints: IExecutionConstraint[] = [];
  private policies: IExecutionPolicy[] = [];
  private guardrails: IRuntimeGuardrail[] = [];

  registerConstraint(constraint: IExecutionConstraint): void {
    this.constraints.push(constraint);
  }

  registerPolicy(policy: IExecutionPolicy): void {
    this.policies.push(policy);
  }

  registerGuardrail(guardrail: IRuntimeGuardrail): void {
    this.guardrails.push(guardrail);
  }

  getConstraints(): IExecutionConstraint[] {
    return [...this.constraints];
  }

  getPolicies(): IExecutionPolicy[] {
    return [...this.policies];
  }

  getGuardrails(): IRuntimeGuardrail[] {
    return [...this.guardrails];
  }

  async evaluateTask(
    task: ITaskSynthesisResult
  ): Promise<{ allowed: boolean; requiresApproval: boolean; reason?: string }> {
    // 1. Evaluate hard constraints
    for (const constraint of this.constraints) {
      const res = constraint.validate(task);
      if (!res.success) {
        return { allowed: false, requiresApproval: false, reason: `${constraint.name}: ${res.reason}` };
      }
    }

    // 2. Evaluate execution policies to verify approval requirements
    let requiresApproval = false;
    for (const policy of this.policies) {
      const validRes = policy.validate(task);
      if (!validRes.success) {
        return { allowed: false, requiresApproval: false, reason: `${policy.name}: ${validRes.reason}` };
      }
      if (policy.requiresApproval(task)) {
        requiresApproval = true;
      }
    }

    return { allowed: true, requiresApproval };
  }

  async evaluatePlan(plan: ICognitiveTrace): Promise<{ allowed: boolean; reason?: string }> {
    // Verify guardrails against synthesized task array
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
    executionLogs: any[]
  ): Promise<{ allowed: boolean; reason?: string }> {
    for (const guardrail of this.guardrails) {
      const res = guardrail.check(tasks, executionLogs);
      if (!res.success) {
        return { allowed: false, reason: `${guardrail.name}: ${res.reason}` };
      }
    }
    return { allowed: true };
  }
}
