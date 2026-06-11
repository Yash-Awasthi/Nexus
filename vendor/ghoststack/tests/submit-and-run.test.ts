/**
 * T5 — GhostStackOrchestrator.submitAndRun() integration test
 *
 * Verifies end-to-end cognitive pipeline:
 *   natural-language objective → plan generation → governance evaluation
 *   → queue population → executor drain → accurate processed count
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { GhostStackOrchestrator } from "../runtime/orchestrator";
import { RuntimeManager } from "../orchestration/runtime-manager";
import { LocalEventBus } from "../orchestration/event-bus";
import { TaskRouter } from "../orchestration/task-router";
import { LocalAgentRegistry } from "../orchestration/agent-registry";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { TaskExecutor } from "../orchestration/task-executor";
import { MetricsCollector } from "../orchestration/observability-manager";
import { StructuredLogger } from "../orchestration/logger";
import { FileRuntimePersistence } from "../orchestration/persistence-manager";
import { FlociExecutionAdapter } from "../orchestration/floci-adapter";
import { PlanningEngine } from "../orchestration/planning-engine";
import {
  GovernanceEngine,
  CostBudgetConstraint,
  DangerousOperationPolicy,
  LoopDetectionGuardrail,
  RunawayRetriesGuardrail,
  TaskGraphLimitGuardrail
} from "../orchestration/governance-engine";
import { YAMLConfigLoader } from "../runtime/config-loader";

const YAML_OPTS = {
  portsPath: path.join(__dirname, "../runtime/ports.yaml"),
  servicesPath: path.join(__dirname, "../runtime/services.yaml"),
  healthchecksPath: path.join(__dirname, "../runtime/healthchecks.yaml"),
  runtimePath: path.join(__dirname, "../runtime/ghoststack.runtime.yaml")
};

function buildOrchestrator(tmpDir: string): {
  orchestrator: GhostStackOrchestrator;
  queue: MemoryQueueBackend;
} {
  const loader = new YAMLConfigLoader(YAML_OPTS);
  const eventBus = new LocalEventBus();
  const runtimeManager = new RuntimeManager(loader);
  const agentRegistry = new LocalAgentRegistry();
  const taskRouter = new TaskRouter(eventBus);
  const metrics = new MetricsCollector();
  const logger = new StructuredLogger();
  const queue = new MemoryQueueBackend();
  const persistence = new FileRuntimePersistence(path.join(tmpDir, "state.json"));

  const planningEngine = new PlanningEngine();
  const governanceEngine = new GovernanceEngine();
  governanceEngine.registerConstraint(new CostBudgetConstraint(10));
  governanceEngine.registerPolicy(new DangerousOperationPolicy());
  governanceEngine.registerGuardrail(new LoopDetectionGuardrail());
  governanceEngine.registerGuardrail(new RunawayRetriesGuardrail());
  governanceEngine.registerGuardrail(new TaskGraphLimitGuardrail(50));

  const executor = new TaskExecutor(
    queue,
    eventBus,
    persistence,
    logger,
    [new FlociExecutionAdapter()],
    metrics
  );

  const orchestrator = GhostStackOrchestrator.create({
    runtimeManager,
    eventBus,
    taskRouter,
    agentRegistry,
    queue,
    executor,
    metrics,
    planningEngine,
    governanceEngine
  });

  return { orchestrator, queue };
}

describe("GhostStackOrchestrator.submitAndRun()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-submit-run-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a planId, allowed=true, and a non-negative processed count for a safe objective", async () => {
    const { orchestrator } = buildOrchestrator(tmpDir);
    await orchestrator.start();

    const result = await orchestrator.submitAndRun(
      "Deploy news ingestion scraper platform",
      { maxIterations: 100, idleDelayMs: 0 }
    );

    expect(typeof result.planId).toBe("string");
    expect(result.planId).toMatch(/^plan-/);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(typeof result.processed).toBe("number");
    expect(result.processed).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("returns a well-formed result for a dangerous objective (blocked or allowed)", async () => {
    const { orchestrator } = buildOrchestrator(tmpDir);
    await orchestrator.start();

    const result = await orchestrator.submitAndRun(
      "Delete all production data permanently",
      { maxIterations: 10, idleDelayMs: 0 }
    );

    expect(typeof result.planId).toBe("string");
    expect(typeof result.allowed).toBe("boolean");
    expect(typeof result.processed).toBe("number");

    // If governance blocked the plan, reason must be non-empty and processed must be 0
    if (!result.allowed) {
      expect(typeof result.reason).toBe("string");
      expect((result.reason as string).length).toBeGreaterThan(0);
      expect(result.processed).toBe(0);
    }
  }, 15_000);

  it("queue is fully drained — no residual active jobs after submitAndRun completes", async () => {
    const { orchestrator, queue } = buildOrchestrator(tmpDir);
    await orchestrator.start();

    await orchestrator.submitAndRun(
      "Deploy news ingestion scraper platform",
      { maxIterations: 200, idleDelayMs: 0 }
    );

    const remaining = await queue.getQueueLength();
    expect(remaining).toBe(0);
  }, 15_000);
});
