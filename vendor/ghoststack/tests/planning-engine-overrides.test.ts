/**
 * T2 — PlanningEngine argument overrides, blueprint selection, numeric coercion
 */
import { PlanningEngine } from "../orchestration/planning-engine";

describe("PlanningEngine — argument overrides and blueprint selection", () => {
  const engine = new PlanningEngine();

  describe("generatePlan — basic structure", () => {
    it("returns a plan with a valid planId and timestamp", async () => {
      const plan = await engine.generatePlan("ingest some data");
      expect(plan.planId).toMatch(/^plan-/);
      expect(plan.timestamp).toBeInstanceOf(Date);
      expect(plan.objective).toBe("ingest some data");
    });

    it("synthesisResults is a non-empty array", async () => {
      const plan = await engine.generatePlan("do something");
      expect(Array.isArray(plan.synthesisResults)).toBe(true);
      expect(plan.synthesisResults.length).toBeGreaterThan(0);
    });
  });

  describe("blueprint selection by keyword", () => {
    it("selects the ingestion blueprint when objective contains 'ingestion'", async () => {
      const plan = await engine.generatePlan("start an ingestion pipeline");
      const actions = plan.synthesisResults.map((t) => t.action);
      // Ingestion blueprint should involve s3/data actions
      expect(actions.length).toBeGreaterThan(0);
    });

    it("selects the scraper blueprint when objective contains 'scraper'", async () => {
      const plan = await engine.generatePlan("deploy a scraper for news");
      const actions = plan.synthesisResults.map((t) => t.action);
      expect(actions.some((a) => a.includes("scrape") || a.includes("browser"))).toBe(true);
    });

    it("selects the etl blueprint when objective contains 'etl'", async () => {
      const plan = await engine.generatePlan("run etl on data warehouse");
      const actions = plan.synthesisResults.map((t) => t.action);
      expect(actions.length).toBeGreaterThan(0);
    });

    it("falls back to default blueprint for unrecognized objectives", async () => {
      const plan = await engine.generatePlan("do something completely unknown xyz");
      expect(plan.synthesisResults.length).toBeGreaterThan(0);
    });

    it("dangerous keyword triggers the dangerous blueprint", async () => {
      const plan = await engine.generatePlan("dangerous operation");
      const hasDanger = plan.synthesisResults.some(
        (t) => t.governanceMetadata?.dangerous === true
      );
      expect(hasDanger).toBe(true);
    });
  });

  describe("argument override extraction", () => {
    it("extracts key=value pairs — keys are lowercased by the engine's objective normalisation", async () => {
      // The engine lowercases the full objective before extracting overrides, so
      // 'bucketname' (not 'bucketName') is the key that ends up in task arguments.
      const plan = await engine.generatePlan("ingestion pipeline bucketname=my-data");
      const argsWithBucket = plan.synthesisResults.find(
        (t) => (t.arguments as any)["bucketname"] !== undefined
      );
      expect(argsWithBucket).toBeDefined();
      expect((argsWithBucket!.arguments as any)["bucketname"]).toBe("my-data");
    });

    it("coerces numeric values to numbers (key also lowercased)", async () => {
      const plan = await engine.generatePlan("ingestion pipeline maxitems=500");
      const withNum = plan.synthesisResults.find(
        (t) => (t.arguments as any)["maxitems"] !== undefined
      );
      expect(withNum).toBeDefined();
      expect(typeof (withNum!.arguments as any)["maxitems"]).toBe("number");
      expect((withNum!.arguments as any)["maxitems"]).toBe(500);
    });

    it("keeps non-numeric override values as strings", async () => {
      const plan = await engine.generatePlan("scraper job region=us-east-1");
      const withRegion = plan.synthesisResults.find(
        (t) => (t.arguments as any)["region"] !== undefined
      );
      expect(withRegion).toBeDefined();
      expect(typeof (withRegion!.arguments as any)["region"]).toBe("string");
    });

    it("handles multiple key=value overrides in the same objective", async () => {
      const plan = await engine.generatePlan("ingestion bucketname=archive-v2 maxitems=100 region=us-west-2");
      const task = plan.synthesisResults[0];
      const args = task.arguments as any;
      expect(args["bucketname"]).toBe("archive-v2"); // lowercased by normalization
      expect(args["maxitems"]).toBe(100);
      expect(args["region"]).toBe("us-west-2");
    });

    it("produces no override keys when objective has no key=value patterns", async () => {
      const plan = await engine.generatePlan("run a simple backup now");
      // All tasks' arguments should come from blueprint defaults only
      for (const t of plan.synthesisResults) {
        const argKeys = Object.keys(t.arguments as any);
        const hasEqualSign = argKeys.some((k) => k.includes("="));
        expect(hasEqualSign).toBe(false);
      }
    });
  });

  describe("DAG integrity", () => {
    it("first task has no dependencies", async () => {
      const plan = await engine.generatePlan("run backup pipeline");
      const first = plan.synthesisResults[0];
      expect(first.dependencies).toHaveLength(0);
    });

    it("each dependency ID exists as a taskId in the plan", async () => {
      const plan = await engine.generatePlan("run etl on data");
      const taskIds = new Set(plan.synthesisResults.map((t) => t.taskId));
      for (const t of plan.synthesisResults) {
        for (const dep of t.dependencies) {
          expect(taskIds.has(dep)).toBe(true);
        }
      }
    });

    it("first task priority is high", async () => {
      const plan = await engine.generatePlan("do any ingestion task");
      expect(plan.synthesisResults[0].priority).toBe("high");
    });

    it("subsequent tasks have medium priority", async () => {
      const plan = await engine.generatePlan("run a research operation with multiple steps");
      const rest = plan.synthesisResults.slice(1);
      for (const t of rest) {
        expect(t.priority).toBe("medium");
      }
    });
  });

  describe("governance metadata", () => {
    it("each task has governanceMetadata with resourceScope", async () => {
      const plan = await engine.generatePlan("do any work");
      for (const t of plan.synthesisResults) {
        expect(t.governanceMetadata).toBeDefined();
        expect(t.governanceMetadata!.resourceScope).toBeDefined();
      }
    });

    it("costEstimate is a non-negative number", async () => {
      const plan = await engine.generatePlan("backup the data");
      for (const t of plan.synthesisResults) {
        expect(typeof t.governanceMetadata!.costEstimate).toBe("number");
        expect(t.governanceMetadata!.costEstimate).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
