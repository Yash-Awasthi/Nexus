import type { Task } from "../task-router.js";

export interface IWorkflowConstraint {
  name: string;
  evaluate(tasks: Task[]): Promise<{ allowed: boolean; reason?: string }>;
}

export interface IWorkflowApprovalPolicy {
  workflowName: string;
  requiresApproval(tasks: Task[]): Promise<boolean>;
}

export interface IWorkflowDefinition {
  id: string;
  name: string;
  description: string;
  tasks: Task[];
  approvalPolicy?: IWorkflowApprovalPolicy;
  constraints?: IWorkflowConstraint[];
  /**
   * Optional metadata for extensible configuration.
   * Supports S3 event trigger bindings under `s3Triggers`, e.g.:
   *   metadata: {
   *     s3Triggers: [{ bucket: "my-bucket", prefix: "uploads/", workflowId: "..." }]
   *   }
   */
  metadata?: Record<string, unknown>;
}

export interface IWorkflowExecution {
  id: string;
  workflowId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "rejected";
  taskResults: Record<string, any>;
  startedAt: Date;
  completedAt?: Date;
  approved?: boolean;
  error?: string;
  /** Set when result comes from an idempotency cache hit rather than actual execution */
  idempotent?: boolean;
  /** Original execution ID when result is an idempotent replay */
  originalExecutionId?: string;
  /** Set by orderedReplay to indicate state verification passed */
  stateVerified?: boolean;
}

export interface IWorkflowTemplate {
  templateId: string;
  name: string;
  description: string;
  createWorkflow(params: Record<string, any>): IWorkflowDefinition;
}

export interface IWorkflowRegistry {
  registerTemplate(template: IWorkflowTemplate): void;
  getTemplate(templateId: string): IWorkflowTemplate | undefined;
  listTemplates(): IWorkflowTemplate[];
  registerWorkflow(definition: IWorkflowDefinition): void;
  getWorkflow(workflowId: string): IWorkflowDefinition | undefined;
  listWorkflows(): IWorkflowDefinition[];
}

export interface IWorkflowTelemetry {
  recordExecutionStart(executionId: string, workflowId: string): void;
  recordExecutionSuccess(executionId: string, results: Record<string, any>): void;
  recordExecutionFailure(executionId: string, error: string): void;
  recordApprovalDecision(executionId: string, approved: boolean): void;
  getExecutionHistory(): IWorkflowExecution[];
}

export interface IWorkflowReplay {
  replayExecution(executionId: string): Promise<IWorkflowExecution>;
}
