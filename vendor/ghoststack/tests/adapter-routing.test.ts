/**
 * T7 — New adapter routing via cognitive objective
 *
 * Verifies that submitting a natural-language objective routes tasks to the
 * correct adapter (WebSearchAdapter, CodeAgentPool, LocalInferenceAdapter)
 * end-to-end through:
 *   PlanningEngine → ICognitiveTrace → GhostStackOrchestrator
 *   → TaskExecutor → adapterType matching → adapter.execute()
 *
 * All adapter execute() methods are spied on — no live HTTP / bridge calls.
 */

import * as path from "path";
import * as fs from "fs";
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
import { PlanningEngine } from "../orchestration/planning-engine";
import {
  GovernanceEngine,
  CostBudgetConstraint,
  DangerousOperationPolicy,
  LoopDetectionGuardrail,
  RunawayRetriesGuardrail,
  TaskGraphLimitGuardrail
} from "../orchestration/governance-engine";
import { WebSearchAdapter } from "../orchestration/web-search-adapter";
import { CodeAgentPool } from "../orchestration/code-agent-pool";
import { LocalInferenceAdapter } from "../orchestration/local-inference-adapter";
import { YAMLConfigLoader } from "../runtime/config-loader";

const YAML_OPTS = {
  portsPath: path.join(__dirname, "../runtime/ports.yaml"),
  servicesPath: path.join(__dirname, "../runtime/services.yaml"),
  healthchecksPath: path.join(__dirname, "../runtime/healthchecks.yaml"),
  runtimePath: path.join(__dirname, "../runtime/ghoststack.runtime.yaml")
};

function buildOrchestrator(tmpDir: string, adapters: any[]) {
  const loader = new YAMLConfigLoader(YAML_OPTS);
  const eventBus = new LocalEventBus();
  const runtimeManager = new RuntimeManager(loader);
  const agentRegistry = new LocalAgentRegistry();
  const taskRouter = new TaskRouter(eventBus);
  const metrics = new MetricsCollector();
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
    new StructuredLogger(),
    adapters,
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

  return { orchestrator };
}

// ── canExecute type matching ──────────────────────────────────────────────────

describe("Adapter canExecute type matching", () => {
  it("WebSearchAdapter accepts search / answer / web_search task types", () => {
    const a = new WebSearchAdapter();
    expect(a.canExecute("search")).toBe(true);
    expect(a.canExecute("answer")).toBe(true);
    expect(a.canExecute("web_search")).toBe(true);
    expect(a.canExecute("code")).toBe(false);
    expect(a.canExecute("floci")).toBe(false);
  });

  it("CodeAgentPool accepts code / code_edit / code_explore / code_review / research / reason types", () => {
    const a = new CodeAgentPool();
    expect(a.canExecute("code")).toBe(true);
    expect(a.canExecute("code_edit")).toBe(true);
    expect(a.canExecute("code_explore")).toBe(true);
    expect(a.canExecute("code_review")).toBe(true);
    expect(a.canExecute("research")).toBe(true);
    expect(a.canExecute("reason")).toBe(true);
    expect(a.canExecute("search")).toBe(false);
    expect(a.canExecute("floci")).toBe(false);
  });

  it("LocalInferenceAdapter accepts inference / local_llm / generate task types", () => {
    const a = new LocalInferenceAdapter();
    expect(a.canExecute("inference")).toBe(true);
    expect(a.canExecute("local_llm")).toBe(true);
    expect(a.canExecute("generate")).toBe(true);
    expect(a.canExecute("search")).toBe(false);
    expect(a.canExecute("floci")).toBe(false);
  });
});

// ── Planning engine blueprint → adapterType threading ────────────────────────

describe("Planning engine adapterType threading", () => {
  it("search objective generates tasks with adapterType=search", async () => {
    const engine = new PlanningEngine();
    const plan = await engine.generatePlan("search for the latest news on quantum computing");
    expect(plan.synthesisResults.length).toBeGreaterThan(0);
    expect(plan.synthesisResults[0].adapterType).toBe("search");
  });

  it("code objective generates tasks with adapterType=code", async () => {
    const engine = new PlanningEngine();
    const plan = await engine.generatePlan("write code to parse and transform JSON data");
    expect(plan.synthesisResults.length).toBeGreaterThan(0);
    expect(plan.synthesisResults[0].adapterType).toBe("code");
  });

  it("inference objective generates tasks with adapterType=inference", async () => {
    const engine = new PlanningEngine();
    const plan = await engine.generatePlan("run local inference on the uploaded document");
    expect(plan.synthesisResults.length).toBeGreaterThan(0);
    expect(plan.synthesisResults[0].adapterType).toBe("inference");
  });

  it("floci/ingestion objective generates tasks with adapterType=floci", async () => {
    const engine = new PlanningEngine();
    const plan = await engine.generatePlan("deploy news ingestion scraper platform");
    expect(plan.synthesisResults.every((r) => r.adapterType === "floci")).toBe(true);
  });
});

// ── End-to-end routing: objective → adapter.execute() ────────────────────────

describe("T7 — Cognitive objective routes to correct adapter execute()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-adapter-routing-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("search objective invokes WebSearchAdapter.execute", async () => {
    const searchAdapter = new WebSearchAdapter();
    const spy = jest.spyOn(searchAdapter, "execute").mockResolvedValue({ success: true, results: [] });

    const { orchestrator } = buildOrchestrator(tmpDir, [searchAdapter]);
    await orchestrator.start();

    const result = await orchestrator.submitAndRun(
      "search for the latest news on quantum computing",
      { maxIterations: 50, idleDelayMs: 0 }
    );

    expect(result.allowed).toBe(true);
    expect(spy).toHaveBeenCalled();

    const callArg = spy.mock.calls[0][0] as any;
    const taskType = callArg?.payload?.type ?? callArg?.type ?? "";
    expect(taskType).toBe("search");
  }, 15_000);

  it("code objective invokes CodeAgentPool.execute", async () => {
    const codePool = new CodeAgentPool();
    const spy = jest.spyOn(codePool, "execute").mockResolvedValue({ success: true, output: "" });

    const { orchestrator } = buildOrchestrator(tmpDir, [codePool]);
    await orchestrator.start();

    const result = await orchestrator.submitAndRun(
      "write code to parse and transform JSON data",
      { maxIterations: 50, idleDelayMs: 0 }
    );

    expect(result.allowed).toBe(true);
    expect(spy).toHaveBeenCalled();

    const callArg = spy.mock.calls[0][0] as any;
    const taskType = callArg?.payload?.type ?? callArg?.type ?? "";
    expect(taskType).toBe("code");
  }, 15_000);

  it("inference objective invokes LocalInferenceAdapter.execute", async () => {
    const inferenceAdapter = new LocalInferenceAdapter();
    const spy = jest.spyOn(inferenceAdapter, "execute").mockResolvedValue({ success: true, text: "" });

    const { orchestrator } = buildOrchestrator(tmpDir, [inferenceAdapter]);
    await orchestrator.start();

    const result = await orchestrator.submitAndRun(
      "run local inference on the uploaded document",
      { maxIterations: 50, idleDelayMs: 0 }
    );

    expect(result.allowed).toBe(true);
    expect(spy).toHaveBeenCalled();

    const callArg = spy.mock.calls[0][0] as any;
    const taskType = callArg?.payload?.type ?? callArg?.type ?? "";
    expect(taskType).toBe("inference");
  }, 15_000);

  it("all three adapters coexist in the same executor — each routes correctly", async () => {
    const searchAdapter = new WebSearchAdapter();
    const codePool = new CodeAgentPool();
    const inferenceAdapter = new LocalInferenceAdapter();

    const searchSpy = jest.spyOn(searchAdapter, "execute").mockResolvedValue({ success: true });
    const codeSpy = jest.spyOn(codePool, "execute").mockResolvedValue({ success: true });
    const inferenceSpy = jest.spyOn(inferenceAdapter, "execute").mockResolvedValue({ success: true });

    // Run a search objective — only the search adapter should fire
    const { orchestrator } = buildOrchestrator(tmpDir, [searchAdapter, codePool, inferenceAdapter]);
    await orchestrator.start();

    await orchestrator.submitAndRun(
      "search for recent breakthroughs in quantum computing",
      { maxIterations: 50, idleDelayMs: 0 }
    );

    expect(searchSpy).toHaveBeenCalled();
    expect(codeSpy).not.toHaveBeenCalled();
    expect(inferenceSpy).not.toHaveBeenCalled();
  }, 15_000);
});

// ── LLM-backed PlanningEngine falls back gracefully ──────────────────────────

describe("PlanningEngine with LLM fallback", () => {
  it("falls back to keyword matching when LLM throws", async () => {
    const brokenLLM = {
      modelId: "broken",
      generateText: jest.fn().mockRejectedValue(new Error("model offline")),
      streamText: jest.fn(),
      generateObject: jest.fn().mockRejectedValue(new Error("model offline"))
    } as any;

    const engine = new PlanningEngine(brokenLLM);
    // Should not throw — falls back to keyword matching
    const plan = await engine.generatePlan("search for latest AI papers");
    expect(plan.synthesisResults[0].adapterType).toBe("search");
  });

  it("uses LLM blueprint key when model returns a valid key", async () => {
    const mockLLM = {
      modelId: "mock",
      generateText: jest.fn(),
      streamText: jest.fn(),
      generateObject: jest.fn().mockResolvedValue({ blueprintKey: "code" })
    } as any;

    const engine = new PlanningEngine(mockLLM);
    const plan = await engine.generatePlan("some ambiguous objective");
    expect(plan.synthesisResults[0].adapterType).toBe("code");
    expect(mockLLM.generateObject).toHaveBeenCalledTimes(1);
  });

  it("falls back to keyword matching when LLM returns unrecognised key", async () => {
    const mockLLM = {
      modelId: "mock",
      generateText: jest.fn(),
      streamText: jest.fn(),
      generateObject: jest.fn().mockResolvedValue({ blueprintKey: "nonexistent_blueprint" })
    } as any;

    const engine = new PlanningEngine(mockLLM);
    const plan = await engine.generatePlan("run local inference job");
    // Keyword fallback: "inference" keyword → inference blueprint
    expect(plan.synthesisResults[0].adapterType).toBe("inference");
  });
});
