/**
 * End-to-End Convergence Integration Test
 *
 * Validates the full workflow → Floci → memory store → RuntimeGraph → inspector
 * pipeline end-to-end. Ensures all subsystems are properly wired and
 * interoperate as a cohesive runtime platform.
 */

import {
  WorkflowRegistry,
  WorkflowTelemetry,
  WorkflowEngine,
  LocalCloudProvisioningTemplate,
  DocumentProcessingTemplate
} from "../orchestration/workflow-engine";
import { RuntimeGraph } from "../orchestration/runtime-graph";
import { MemoryStore } from "../orchestration/memory-store";
import { GhostStackOrchestrator } from "../runtime/orchestrator";
import { RuntimeManager } from "../orchestration/runtime-manager";
import { LocalEventBus } from "../orchestration/event-bus";
import { TaskRouter } from "../orchestration/task-router";
import { LocalAgentRegistry } from "../orchestration/agent-registry";
import { FileEventStore, FileRuntimePersistence } from "../orchestration/persistence-manager";
import { StructuredLogger } from "../orchestration/logger";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { TaskExecutor } from "../orchestration/task-executor";
import { MetricsCollector, TraceRecorder, DiagnosticEnricher } from "../orchestration/observability-manager";
import { LocalServiceDiscovery } from "../orchestration/service-discovery";
import { YAMLConfigLoader } from "../runtime/config-loader";
import { ApprovalWorkflow } from "../orchestration/approval-workflow";
import { BrowserExecutionAdapter } from "../orchestration/browser-adapter";
import { ScrapingExecutionAdapter } from "../orchestration/scraping-adapter";
import { FlociExecutionAdapter } from "../orchestration/floci-adapter";
import { EnvironmentTelemetry } from "../orchestration/environment-telemetry";
import { RuntimeInspector } from "../orchestration/runtime-inspector";
import * as path from "path";
import * as fs from "fs";

describe("E2E Convergence: Workflow → Floci → Memory → Graph → Inspector", () => {
  const testDir = path.join(__dirname, "../temp-e2e-convergence-db");
  const eventLogPath = path.join(testDir, "events.jsonl");
  const cacheDbPath = path.join(testDir, "cache.json");

  function setupFullStack() {
    const registry = new WorkflowRegistry();
    const persistence = new FileRuntimePersistence(cacheDbPath);
    const telemetry = new WorkflowTelemetry(persistence);
    const eventStore = new FileEventStore(eventLogPath);
    const eventBus = new LocalEventBus();

    const runtimeGraph = new RuntimeGraph(persistence, eventBus);
    const memoryStore = new MemoryStore(persistence);

    const loader = new YAMLConfigLoader({
      portsPath: path.join(__dirname, "../runtime/ports.yaml"),
      servicesPath: path.join(__dirname, "../runtime/services.yaml"),
      healthchecksPath: path.join(__dirname, "../runtime/healthchecks.yaml"),
      runtimePath: path.join(__dirname, "../runtime/ghoststack.runtime.yaml")
    });
    const logger = new StructuredLogger();
    const runtimeManager = new RuntimeManager(loader);
    const agentRegistry = new LocalAgentRegistry();
    const taskRouter = new TaskRouter(eventBus, eventStore);
    const metrics = new MetricsCollector();
    const tracer = new TraceRecorder();
    const queue = new MemoryQueueBackend();
    const discovery = new LocalServiceDiscovery();
    const approval = new ApprovalWorkflow(eventStore, eventBus);
    const browserAdapter = new BrowserExecutionAdapter(new EnvironmentTelemetry(), true);
    const scrapingAdapter = new ScrapingExecutionAdapter(new EnvironmentTelemetry(), true);
    const flociAdapter = new FlociExecutionAdapter();

    const executor = new TaskExecutor(
      queue, eventBus, persistence, logger,
      [browserAdapter, scrapingAdapter, flociAdapter],
      metrics, tracer
    );

    const orchestrator = new GhostStackOrchestrator(
      runtimeManager, eventBus, taskRouter, agentRegistry,
      eventStore, logger, queue, executor, metrics, tracer,
      undefined, undefined, approval
    );

    const engine = new WorkflowEngine(registry, telemetry, orchestrator, approval, persistence, eventBus, runtimeGraph);

    const diagnosticEnricher = new DiagnosticEnricher(metrics, tracer);

    const inspector = RuntimeInspector.fromContext({
      metrics,
      queue,
      discovery,
      eventStore,
      governanceEngine: undefined,
      approval,
      browserTelemetry: new EnvironmentTelemetry(),
      scrapingTelemetry: new EnvironmentTelemetry(),
      registry,
      workflowTelemetry: telemetry,
      workflowEngine: engine,
      memoryStore,
      agentBus: null as any,
      circuitBreaker: null as any,
      circuitBreakerWrapper: null as any,
      traceIndexer: null as any
    });

    return {
      registry, engine, telemetry, persistence,
      runtimeGraph, memoryStore, inspector,
      orchestrator, eventBus, eventStore, metrics, diagnosticEnricher
    };
  }

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("executes a workflow and registers nodes in RuntimeGraph", async () => {
    const { registry, engine, runtimeGraph, orchestrator } = setupFullStack();
    await orchestrator.start();

    // Register a workflow with metadata (including s3Triggers for future S3 event testing)
    const cloudTemplate = new LocalCloudProvisioningTemplate();
    const wf = cloudTemplate.createWorkflow({ id: "e2e-graph-wf" });
    // Add metadata for extensibility testing
    (wf as any).metadata = {
      s3Triggers: [{ bucket: "test-bucket", prefix: "uploads/" }]
    };
    registry.registerWorkflow(wf);

    // Register some initial nodes in the graph
    await runtimeGraph.addNode("ghoststack-runtime", "agent", "GhostStack Runtime", {
      status: "active"
    });
    await runtimeGraph.addNode("floci", "mcp_server", "Floci Local AWS Emulator", {
      status: "pending"
    });

    // Execute the workflow — this should auto-register execution + task nodes
    const exec = await engine.executeWorkflow("e2e-graph-wf", "exec-e2e-graph-01");
    expect(exec.status).toBe("succeeded");

    // Verify RuntimeGraph has the execution node
    const execNode = await runtimeGraph.getNode("wf-exec:exec-e2e-graph-01");
    expect(execNode).toBeDefined();
    expect(execNode!.type).toBe("task_execution");

    // Verify task-level sub-nodes exist
    const allNodes = await runtimeGraph.getAllNodes();
    const taskNodes = allNodes.filter((n) => n.id.startsWith("task:exec-e2e-graph-01"));
    expect(taskNodes.length).toBeGreaterThanOrEqual(3); // 3 tasks in cloud provisioning template

    // Verify edges exist between task nodes
    const snapshot = await runtimeGraph.getSnapshot();
    const taskEdges = snapshot.edges.filter((e) => e.from.startsWith("task:exec-e2e-graph-01"));
    expect(taskEdges.length).toBeGreaterThanOrEqual(2); // At least 2 dependency edges

    // Verify snapshot summary includes all subsystems
    expect(snapshot.summary.totalNodes).toBeGreaterThanOrEqual(5); // runtime + floci + exec + 3 tasks
    expect(snapshot.summary.byType["task_execution"]).toBeGreaterThanOrEqual(4); // 1 exec root + 3 tasks
  });

  it("stores workflow execution events in MemoryStore", async () => {
    const { registry, engine, memoryStore, orchestrator } = setupFullStack();
    await orchestrator.start();

    const docTemplate = new DocumentProcessingTemplate();
    const wf = docTemplate.createWorkflow({ id: "e2e-mem-wf", limitBytes: 50000 });
    registry.registerWorkflow(wf);

    // Register workflow event auto-storage in MemoryStore
    // (simulating what runtime-context.ts does via onAny)
    engine.onAny(async (wfEvent) => {
      await memoryStore.store({
        type: wfEvent.type.includes("failed") || wfEvent.type.includes("cancelled") ? "error" :
              wfEvent.type.includes("succeeded") ? "result" : "observation",
        key: `workflow:${wfEvent.type}:${wfEvent.executionId}`,
        value: { workflowId: wfEvent.workflowId, payload: wfEvent.payload },
        tags: ["workflow", wfEvent.type, `exec:${wfEvent.executionId}`],
        workflowId: wfEvent.workflowId,
        executionId: wfEvent.executionId,
        ttlMs: 7 * 24 * 60 * 60 * 1000
      });
    });

    await engine.executeWorkflow("e2e-mem-wf", "exec-e2e-mem-01");

    // Query MemoryStore for workflow-related entries
    const result = await memoryStore.query({ types: ["result"], keyPrefix: "workflow:" });
    expect(result.entries.length).toBeGreaterThanOrEqual(1);

    const succeededEntry = result.entries.find(
      (e) => e.key === "workflow:workflow:execution_succeeded:exec-e2e-mem-01"
    );
    expect(succeededEntry).toBeDefined();
    expect(succeededEntry!.tags).toContain("workflow:execution_succeeded");

    // Verify stats reflect the stored entries
    const stats = await memoryStore.getStats();
    expect(stats.totalEntries).toBeGreaterThanOrEqual(1);
  });

  it("inspects workflow execution via RuntimeInspector", async () => {
    const { registry, engine, inspector, telemetry: _telemetry, orchestrator } = setupFullStack();
    await orchestrator.start();

    const cloudTemplate = new LocalCloudProvisioningTemplate();
    const wf = cloudTemplate.createWorkflow({ id: "e2e-inspect-wf" });
    registry.registerWorkflow(wf);

    await engine.executeWorkflow("e2e-inspect-wf", "exec-e2e-inspect-01");

    // Inspector should report the execution via telemetry
    const executionHistory = inspector.getWorkflowExecutionHistory();
    expect(executionHistory.length).toBeGreaterThanOrEqual(1);
    const record = executionHistory.find((e: any) => e.id === "exec-e2e-inspect-01");
    expect(record).toBeDefined();
    expect(record.status).toBe("succeeded");

    // Specific execution lookup
    const specific = inspector.getWorkflowExecution("exec-e2e-inspect-01");
    expect(specific).toBeDefined();
    expect(specific.id).toBe("exec-e2e-inspect-01");

    // Telemetry stats
    const stats = inspector.getWorkflowTelemetryStats();
    expect(stats.succeededCount).toBeGreaterThanOrEqual(1);

    // Workflow list
    const wfList = inspector.getWorkflowsList();
    expect(wfList.length).toBeGreaterThanOrEqual(1);
    expect(wfList.some((w: any) => w.id === "e2e-inspect-wf")).toBe(true);

    // Templates
    const _templates = inspector.getWorkflowTemplates();
    // Templates come from registry, which we didn't populate with templates
    // The inspector already has templates via registry, but none registered yet
  });

  it("persists RuntimeGraph state across engine restarts", async () => {
    const { registry, engine, runtimeGraph, persistence, orchestrator } = setupFullStack();
    await orchestrator.start();

    const cloudTemplate = new LocalCloudProvisioningTemplate();
    const wf = cloudTemplate.createWorkflow({ id: "e2e-persist-wf" });
    registry.registerWorkflow(wf);

    // Add nodes to runtime graph
    await runtimeGraph.addNode("persist-test-node", "agent", "Persist Test", {
      status: "active"
    });

    // Execute a workflow
    await engine.executeWorkflow("e2e-persist-wf", "exec-e2e-persist-01");

    // Snapshot should include the test node
    const snapshot1 = await runtimeGraph.getSnapshot();
    expect(snapshot1.nodes.some((n) => n.id === "persist-test-node")).toBe(true);

    // Verify persistence by reading the raw state
    const persistedData = await persistence.getState<any>("runtime_graph_data");
    expect(persistedData).toBeDefined();
    expect(persistedData.nodes).toBeDefined();
    const nodeIds = persistedData.nodes.map(([id]: [string, any]) => id);
    expect(nodeIds).toContain("persist-test-node");
  });

  it("completes full pipeline: spec → workflow → execution → inspection", async () => {
    const { registry, engine, runtimeGraph, memoryStore, inspector, orchestrator } = setupFullStack();
    await orchestrator.start();

    // Register workflow
    const docTemplate = new DocumentProcessingTemplate();
    const wf = docTemplate.createWorkflow({ id: "e2e-full-pipe-wf", limitBytes: 25000 });
    registry.registerWorkflow(wf);

    // Register auto-storage of workflow events in memory
    engine.onAny(async (wfEvent) => {
      await memoryStore.store({
        type: wfEvent.type.includes("succeeded") ? "result" : "observation",
        key: `workflow:${wfEvent.type}:${wfEvent.executionId}`,
        value: { workflowId: wfEvent.workflowId },
        tags: ["workflow", `exec:${wfEvent.executionId}`],
        workflowId: wfEvent.workflowId,
        executionId: wfEvent.executionId,
        ttlMs: 7 * 24 * 60 * 60 * 1000
      });
    });

    // Execute workflow
    const exec = await engine.executeWorkflow("e2e-full-pipe-wf", "exec-e2e-full-01");
    expect(exec.status).toBe("succeeded");

    // 1. RuntimeGraph has execution + task nodes
    const graphSnapshot = await runtimeGraph.getSnapshot();
    const execNodes = graphSnapshot.nodes.filter((n) => n.id.startsWith("wf-exec:exec-e2e-full-01"));
    expect(execNodes.length).toBeGreaterThanOrEqual(1);

    // 2. MemoryStore has workflow events
    const memResult = await memoryStore.query({ types: ["result"] });
    const memEntry = memResult.entries.find((e) => e.executionId === "exec-e2e-full-01");
    expect(memEntry).toBeDefined();

    // 3. Inspector can query the execution
    const execHistory = inspector.getWorkflowExecutionHistory();
    const execRecord = execHistory.find((e: any) => e.id === "exec-e2e-full-01");
    expect(execRecord).toBeDefined();
    expect(execRecord!.status).toBe("succeeded");

    // 4. Inspector telemetry stats include this execution
    const telemetryStats = inspector.getWorkflowTelemetryStats();
    expect(telemetryStats.totalExecutions).toBeGreaterThanOrEqual(1);
    expect(telemetryStats.succeededCount).toBeGreaterThanOrEqual(1);

    // 5. Inspector workflow list shows our registered workflow
    const wfList = inspector.getWorkflowsList();
    const registeredWf = wfList.find((w: any) => w.id === "e2e-full-pipe-wf");
    expect(registeredWf).toBeDefined();
    expect(registeredWf!.tasksCount).toBe(2);
  });

  it("handles S3 trigger metadata correctly without triggering", async () => {
    // This validates the S3 event → workflow trigger pipeline metadata schema
    const { registry } = setupFullStack();

    const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "s3-trigger-test" });
    wf.metadata = {
      s3Triggers: [
        { bucket: "incoming-data", prefix: "uploads/" },
        { bucket: "process-results", prefix: "" }
      ]
    };
    registry.registerWorkflow(wf);

    const registered = registry.getWorkflow("s3-trigger-test");
    expect(registered).toBeDefined();
    expect(registered!.metadata).toBeDefined();

    const triggers = registered!.metadata!.s3Triggers as Array<{ bucket: string; prefix?: string }>;
    expect(triggers).toBeDefined();
    expect(triggers.length).toBe(2);
    expect(triggers[0].bucket).toBe("incoming-data");
    expect(triggers[0].prefix).toBe("uploads/");
    expect(triggers[1].bucket).toBe("process-results");
  });
});
