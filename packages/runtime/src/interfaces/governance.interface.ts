// SPDX-License-Identifier: Apache-2.0
export interface ITaskSynthesisResult {
  taskId: string | undefined;
  action: string;
  arguments: Record<string, unknown>;
  dependencies: string[];
  priority: string;
  adapterType: string;
  governanceMetadata: { dangerous?: boolean; costEstimate?: number; resourceScope?: string };
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

export interface IApprovalWorkflow {
  listRecords(): Promise<{ taskId: string; approvalId: string; [key: string]: unknown }[]>;
  requestApproval(request: { id: string; description: string; requester: string }): Promise<{ approved: boolean; reason?: string }>;
  getStatus(requestId: string): Promise<{ status: "pending" | "approved" | "rejected" }>;
}

export interface IGovernanceEngine {
  evaluatePolicy(action: string, context: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string }>;
  recordDecision(decision: { action: string; outcome: string; context: Record<string, unknown> }): Promise<void>;
}
