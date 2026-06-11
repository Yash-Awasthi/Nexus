import { PlanningEngine } from "../orchestration/planning-engine";

describe("Milestone 1: Planning Engine & Bounded Synthesis", () => {
  it("should decompose complex news ingestion objectives into high-fidelity typed dependency graphs", async () => {
    const engine = new PlanningEngine();
    const plan = await engine.generatePlan("Deploy news ingestion scraper platform");

    expect(plan.objective).toBe("Deploy news ingestion scraper platform");
    expect(plan.planId).toContain("plan-");
    expect(plan.synthesisResults.length).toBe(3);

    const s3 = plan.synthesisResults.find((x) => x.action === "create_s3_bucket");
    const sqs = plan.synthesisResults.find((x) => x.action === "create_sqs_queue");
    const ddb = plan.synthesisResults.find((x) => x.action === "create_dynamodb_table");

    expect(s3).toBeDefined();
    expect(sqs).toBeDefined();
    expect(ddb).toBeDefined();

    // Verify correct topological dependencies
    expect(sqs?.dependencies).toContain(s3?.taskId);
    expect(ddb?.dependencies).toContain(sqs?.taskId);

    // Verify priorities and cost allocations
    expect(s3?.priority).toBe("high");
    expect(s3?.governanceMetadata?.costEstimate).toBe(0.02);
  });

  it("should flag dangerous administrative operations with elevated scopes", async () => {
    const engine = new PlanningEngine();
    const plan = await engine.generatePlan("Provision secure database backup");

    const iam = plan.synthesisResults.find((x) => x.action === "create_iam_role");
    expect(iam?.governanceMetadata?.dangerous).toBe(true);
    expect(iam?.governanceMetadata?.resourceScope).toBe("aws:iam");
  });
});
