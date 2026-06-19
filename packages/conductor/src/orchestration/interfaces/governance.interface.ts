// SPDX-License-Identifier: Apache-2.0
export interface ITaskSynthesisResult {
  taskId: string;
  serverName?: string;
  toolName?: string;
  action: string;
  arguments: any;
  dependencies: string[];
  priority: "low" | "medium" | "high";
  /** Executor adapter type — determines which TaskExecutor adapter handles this task */
  adapterType?: string;
  governanceMetadata?: {
    dangerous?: boolean;
    costEstimate?: number;
    resourceScope?: string;
  };
}

export interface ICognitiveTrace {
  planId: string;
  objective: string;
  synthesisResults: ITaskSynthesisResult[];
  timestamp: Date;
}

export interface IPlanningEngine {
  generatePlan(objective: string, context?: any): Promise<ICognitiveTrace>;
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

export interface IApprovalRecord {
  approvalId: string;
  taskId: string;
  status: "pending" | "approved" | "denied" | "expired";
  requestTimestamp: Date;
  decisionTimestamp?: Date;
  decidedBy?: string;
}

export interface IApprovalWorkflow {
  createRequest(taskId: string): Promise<IApprovalRecord>;
  approve(approvalId: string, user: string): Promise<IApprovalRecord>;
  deny(approvalId: string, user: string): Promise<IApprovalRecord>;
  expire(approvalId: string): Promise<IApprovalRecord>;
  getRecord(approvalId: string): Promise<IApprovalRecord | null>;
  listRecords(): Promise<IApprovalRecord[]>;
}

export interface IRuntimeGuardrail {
  name: string;
  check(tasks: ITaskSynthesisResult[], executionLogs: any[]): { success: boolean; reason?: string };
}

export interface IGovernanceEngine {
  registerConstraint(constraint: IExecutionConstraint): void;
  registerPolicy(policy: IExecutionPolicy): void;
  registerGuardrail(guardrail: IRuntimeGuardrail): void;
  evaluateTask(
    task: ITaskSynthesisResult,
  ): Promise<{ allowed: boolean; requiresApproval: boolean; reason?: string }>;
  evaluatePlan(plan: ICognitiveTrace): Promise<{ allowed: boolean; reason?: string }>;
}
