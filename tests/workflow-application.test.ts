import {
  WorkflowRegistry,
  WorkflowTelemetry,
  WorkflowEngine,
  BrowserResearchWorkflowTemplate,
  LocalCloudProvisioningTemplate,
  DocumentProcessingTemplate,
  SpecToExecutionTemplate
} from "../orchestration/workflow-engine";
import { RuntimeDiagnosticAPI } from "../orchestration/diagnostic-api";
import { RuntimeInspector } from "../orchestration/runtime-inspector";
import { GhostStackOrchestrator } from "../runtime/orchestrator";
import { RuntimeManager } from "../orchestration/runtime-manager";
import { LocalEventBus } from "../orchestration/event-bus";
import { TaskRouter } from "../orchestration/task-router";
import { LocalAgentRegistry } from "../orchestration/agent-registry";
import { FileEventStore, FileRuntimePersistence } from "../orchestration/persistence-manager";
import { StructuredLogger } from "../orchestration/logger";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { TaskExecutor } from "../orchestration/task-executor";
import { MetricsCollector, TraceRecorder } from "../orchestration/observability-manager";
import { LocalServiceDiscovery } from "../orchestration/service-discovery";
import { YAMLConfigLoader } from "../runtime/config-loader";
import { ApprovalWorkflow } from "../orchestration/approval-workflow";
import { BrowserExecutionAdapter } from "../orchestration/browser-adapter";
import { ScrapingExecutionAdapter } from "../orchestration/scraping-adapter";
import { FlociExecutionAdapter } from "../orchestration/floci-adapter";
import { EnvironmentTelemetry } from "../orchestration/environment-telemetry";
import * as path from "path";
import * as fs from "fs";

describe("Phase 8: Workflow Application Layer E2E & Unit Tests", () => {
  const testDir = path.join(__dirname, "../temp-workflow-db");
  const eventLogPath = path.join(testDir, "workflow_events.jsonl");
  const cacheDbPath = path.join(testDir, "workflow_cache.json");

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

  function setupOrchestrator(telemetry: WorkflowTelemetry, registry: WorkflowRegistry) {
    const loader = new YAMLConfigLoader({
      portsPath: path.join(__dirname, "../runtime/ports.yaml"),
      servicesPath: path.join(__dirname, "../runtime/services.yaml"),
      healthchecksPath: path.join(__dirname, "../runtime/healthchecks.yaml"),
      runtimePath: path.join(__dirname, "../runtime/ghoststack.runtime.yaml")
    });

    const logger = new StructuredLogger();
    const eventBus = new LocalEventBus();
    const eventStore = new FileEventStore(eventLogPath);
    const persistence = new FileRuntimePersistence(cacheDbPath);
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
      queue,
      eventBus,
      persistence,
      logger,
      [browserAdapter, scrapingAdapter, flociAdapter],
      metrics,
      tracer
    );

    const inspector = new RuntimeInspector(
      metrics,
      queue,
      discovery,
      eventStore,
      undefined,
      undefined,
      undefined,
      approval,
      undefined,
      undefined,
      undefined,
      [],
      registry,
      telemetry
    );

    const orchestrator = new GhostStackOrchestrator(
      runtimeManager,
      eventBus,
      taskRouter,
      agentRegistry,
      eventStore,
      logger,
      queue,
      executor,
      metrics,
      tracer,
      undefined,
      undefined,
      approval,
      inspector
    );

    const engine = new WorkflowEngine(registry, telemetry, orchestrator, approval);

    return { orchestrator, engine, inspector, approval };
  }

  it("should register templates and create workflow definitions in the registry", async () => {
    const registry = new WorkflowRegistry();
    registry.registerTemplate(new BrowserResearchWorkflowTemplate());
    registry.registerTemplate(new LocalCloudProvisioningTemplate());

    const templates = registry.listTemplates();
    expect(templates.length).toBe(2);
    expect(templates.map((t) => t.templateId)).toContain("browser-research-template");

    const browserWf = registry.getTemplate("browser-research-template")!.createWorkflow({ id: "custom-research" });
    expect(browserWf.id).toBe("custom-research");
    expect(browserWf.tasks.length).toBe(2);
  });

  it("should evaluate governance constraints and reject unsafe workflows", async () => {
    const registry = new WorkflowRegistry();
    const persistence = new FileRuntimePersistence(cacheDbPath);
    const telemetry = new WorkflowTelemetry(persistence);

    const { engine } = setupOrchestrator(telemetry, registry);

    const browserTemplate = new BrowserResearchWorkflowTemplate();
    const badWf = browserTemplate.createWorkflow({ id: "illegal-research-wf" });
    // Add path traversal to trigger constraints evaluation
    badWf.tasks[0].id = "task-passwd";
    badWf.tasks[0].description = "Read system file file:///etc/passwd";

    registry.registerWorkflow(badWf);

    const exec = await engine.executeWorkflow("illegal-research-wf", "exec-unsafe-01");
    expect(exec.status).toBe("failed");
    expect(exec.error).toContain("Illegal system file path protocol blocked");
  });

  it("should handle approval policies and hold workflow execution under governance approval gates", async () => {
    const registry = new WorkflowRegistry();
    const persistence = new FileRuntimePersistence(cacheDbPath);
    const telemetry = new WorkflowTelemetry(persistence);

    const { engine, approval } = setupOrchestrator(telemetry, registry);

    const specTemplate = new SpecToExecutionTemplate();
    const specWf = specTemplate.createWorkflow({ id: "spec-wf-approval" });
    registry.registerWorkflow(specWf);

    // Initial Execution -> Blocks under approval policy decider
    const exec = await engine.executeWorkflow("spec-wf-approval", "exec-approval-01");
    expect(exec.status).toBe("pending");
    expect(exec.approved).toBe(false);

    // Query active approvals request logs
    const pendingReqs = await approval.listRecords();
    // The taskId mapped in createRequest matches the executionId under the approval policy
    expect(pendingReqs.some((r) => r.taskId === "exec-approval-01")).toBe(true);

    const matchingReq = pendingReqs.find((r) => r.taskId === "exec-approval-01")!;

    // Approve the pending execution gate using matchingReq.approvalId
    const finalizedExec = await engine.approveAndTriggerWorkflow(matchingReq.approvalId);
    expect(finalizedExec.status).toBe("succeeded");
    expect(finalizedExec.approved).toBe(true);
  });

  it("should process telemetry records, workflow replays, and diagnostics route telemetry logs", async () => {
    const registry = new WorkflowRegistry();
    const persistence = new FileRuntimePersistence(cacheDbPath);
    const telemetry = new WorkflowTelemetry(persistence);

    const { engine, inspector } = setupOrchestrator(telemetry, registry);

    const cloudTemplate = new LocalCloudProvisioningTemplate();
    const cloudWf = cloudTemplate.createWorkflow({ id: "cloud-wf-telemetry" });
    registry.registerWorkflow(cloudWf);

    // Initial Run
    const exec = await engine.executeWorkflow("cloud-wf-telemetry", "exec-tel-01");
    expect(exec.status).toBe("succeeded");

    // Teleplay Execution Replay
    const replayExec = await engine.replayExecution("exec-tel-01");
    expect(replayExec.status).toBe("succeeded");
    expect(replayExec.id).toContain("exec-tel-01-replay-");

    // Inspect HTTP GET Routes
    const api = new RuntimeDiagnosticAPI(inspector);

    const telemetryStats = await api.handle("GET", "/runtime/workflows/telemetry");
    expect(telemetryStats.totalExecutions).toBe(2);
    expect(telemetryStats.succeededCount).toBe(2);

    const listTemplates = await api.handle("GET", "/runtime/workflows/templates");
    expect(listTemplates.length).toBe(0); // None registered globally in inspector registry

    const details = await api.handle("GET", "/runtime/workflows/exec-tel-01");
    expect(details.status).toBe("succeeded");
  });

  it("should execute all operational vertical slice workflows end-to-end successfully", async () => {
    const registry = new WorkflowRegistry();
    const persistence = new FileRuntimePersistence(cacheDbPath);
    const telemetry = new WorkflowTelemetry(persistence);

    const { orchestrator, engine } = setupOrchestrator(telemetry, registry);
    await orchestrator.start();

    // 1. Local Cloud Provisioning Workflow
    const cloudTemplate = new LocalCloudProvisioningTemplate();
    const cloudWf = cloudTemplate.createWorkflow({ id: "cloud-prov-wf" });
    registry.registerWorkflow(cloudWf);
    const cloudExec = await engine.executeWorkflow("cloud-prov-wf", "exec-cloud-e2e");
    expect(cloudExec.status).toBe("succeeded");

    // 2. Document Processing Workflow
    const docTemplate = new DocumentProcessingTemplate();
    const docWf = docTemplate.createWorkflow({ id: "doc-proc-wf", limitBytes: 25000 });
    registry.registerWorkflow(docWf);
    const docExec = await engine.executeWorkflow("doc-proc-wf", "exec-doc-e2e");
    expect(docExec.status).toBe("succeeded");
  });
});
