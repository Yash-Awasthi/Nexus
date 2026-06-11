import {
  GovernanceEngine,
  ResourceScopeConstraint,
  CostBudgetConstraint,
  DangerousOperationPolicy,
  WildcardPermissionsPolicy,
  LoopDetectionGuardrail,
  RunawayRetriesGuardrail,
  TaskGraphLimitGuardrail
} from "../orchestration/governance-engine";
import { ITaskSynthesisResult } from "../orchestration/interfaces/governance.interface";

describe("Milestone 2: Governance Engine & Execution Policies", () => {
  let engine: GovernanceEngine;

  beforeEach(() => {
    engine = new GovernanceEngine();
    engine.registerConstraint(new ResourceScopeConstraint());
    engine.registerConstraint(new CostBudgetConstraint(0.5));
    engine.registerPolicy(new DangerousOperationPolicy());
    engine.registerPolicy(new WildcardPermissionsPolicy());
    engine.registerGuardrail(new LoopDetectionGuardrail(3));
    engine.registerGuardrail(new RunawayRetriesGuardrail(5));
    engine.registerGuardrail(new TaskGraphLimitGuardrail(5));
  });

  it("should allow safe standard tasks cleanly", async () => {
    const task: ITaskSynthesisResult = {
      taskId: "task-safe-01",
      action: "create_s3_bucket",
      arguments: { bucketName: "news-scraper-archive" },
      dependencies: [],
      priority: "medium",
      governanceMetadata: { dangerous: false, costEstimate: 0.02, resourceScope: "aws:s3" }
    };

    const res = await engine.evaluateTask(task);
    expect(res.allowed).toBe(true);
    expect(res.requiresApproval).toBe(false);
  });

  it("should deny tasks executing on unauthorized resource scopes", async () => {
    const task: ITaskSynthesisResult = {
      taskId: "task-denied-root",
      action: "delete_all_resources",
      arguments: { scope: "*" },
      dependencies: [],
      priority: "high",
      governanceMetadata: { dangerous: true, costEstimate: 0.0, resourceScope: "system:root" }
    };

    const res = await engine.evaluateTask(task);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("ResourceScopeConstraint: Unauthorized resource scope block");
  });

  it("should flag dangerous tasks as requiring supervisor approval", async () => {
    const task: ITaskSynthesisResult = {
      taskId: "task-dangerous-auth",
      action: "create_iam_role",
      arguments: { roleName: "BackupAdmin" },
      dependencies: [],
      priority: "high",
      governanceMetadata: { dangerous: true, costEstimate: 0.05, resourceScope: "aws:iam" }
    };

    const res = await engine.evaluateTask(task);
    expect(res.allowed).toBe(true);
    expect(res.requiresApproval).toBe(true);
  });

  it("should flag tasks with wildcard permissions as requiring supervisor approval", async () => {
    const task: ITaskSynthesisResult = {
      taskId: "task-wildcard",
      action: "configure_role",
      arguments: { permissions: ["read", "*"] },
      dependencies: [],
      priority: "medium"
    };

    const res = await engine.evaluateTask(task);
    expect(res.allowed).toBe(true);
    expect(res.requiresApproval).toBe(true);
  });

  it("should block execution when costs exceed threshold budgets", async () => {
    const task: ITaskSynthesisResult = {
      taskId: "task-expensive",
      action: "provision_expensive_cluster",
      arguments: {},
      dependencies: [],
      priority: "high",
      governanceMetadata: { costEstimate: 1.25 }
    };

    const res = await engine.evaluateTask(task);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("CostBudgetConstraint: Execution cost estimate $1.25 exceeds task budget limit");
  });

  it("should trigger guardrails when infinite loop patterns are detected in runtime execution logs", async () => {
    const logs = [
      { action: "scrape_headlines" },
      { action: "scrape_headlines" },
      { action: "scrape_headlines" },
      { action: "scrape_headlines" } // exceeds limit of 3
    ];

    const tasks: ITaskSynthesisResult[] = [];
    const evaluation = await engine.evaluateRuntimeLogs(tasks, logs);
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reason).toContain("LoopDetectionGuardrail: Orchestration loop protection triggered");
  });
});
