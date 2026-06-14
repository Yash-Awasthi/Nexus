// SPDX-License-Identifier: Apache-2.0
export interface ITaskSynthesisResult {
  taskId: string;
  action: string;
  arguments: Record<string, unknown>;
  dependencies: string[];
  priority: "low" | "medium" | "high";
  adapterType?: string;
  governanceMetadata?: { dangerous?: boolean; costEstimate?: number; resourceScope?: string };
}

export interface ICognitiveTrace {
  planId: string;
  objective: string;
  synthesisResults: ITaskSynthesisResult[];
  timestamp: Date;
}

export interface IPlanningEngine {
  generatePlan(objective: string, context?: unknown): Promise<ICognitiveTrace>;
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
  getRecord(approvalId: string): Promise<IApprovalRecord | null>;
  listRecords(): Promise<IApprovalRecord[]>;
  approve(approvalId: string, user: string): Promise<IApprovalRecord>;
  deny(approvalId: string, user: string): Promise<IApprovalRecord>;
}

export interface IGovernanceEngine {
  evaluateTask(
    task: ITaskSynthesisResult,
  ): Promise<{ allowed: boolean; requiresApproval: boolean; reason?: string }>;
  evaluatePlan(plan: ICognitiveTrace): Promise<{ allowed: boolean; reason?: string }>;
}
