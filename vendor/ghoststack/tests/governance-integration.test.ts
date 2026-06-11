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
import { RuntimeInspector } from "../orchestration/runtime-inspector";
import { RuntimeDiagnosticAPI } from "../orchestration/diagnostic-api";
import { PlanningEngine } from "../orchestration/planning-engine";
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
import { ApprovalWorkflow } from "../orchestration/approval-workflow";
import { LocalServiceDiscovery } from "../orchestration/service-discovery";
import { FlociExecutionAdapter } from "../orchestration/floci-adapter";
import { YAMLConfigLoader } from "../runtime/config-loader";
import * as path from "path";
import * as fs from "fs";

describe("Milestone 4: End-to-End Orchestrator Governance & Diagnostics", () => {
  const testDir = path.join(__dirname, "../temp-gov-integration-db");
  const eventLogPath = path.join(testDir, "gov_integration_events.jsonl");
  const cacheDbPath = path.join(testDir, "gov_integration_cache.json");

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

  it("should process safe planning objectives immediately, gate dangerous workflows, and expose cognitive diagnostics APIs", async () => {
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

    // Initialize telemetry
    const metrics = new MetricsCollector();
    const tracer = new TraceRecorder();
    const queue = new MemoryQueueBackend();
    const discovery = new LocalServiceDiscovery();

    // Initialize Cognitive Governance Systems
    const planningEngine = new PlanningEngine();
    const governanceEngine = new GovernanceEngine();

    // Register standard governance rules
    governanceEngine.registerConstraint(new ResourceScopeConstraint());
    governanceEngine.registerConstraint(new CostBudgetConstraint(0.5));
    governanceEngine.registerPolicy(new DangerousOperationPolicy());
    governanceEngine.registerPolicy(new WildcardPermissionsPolicy());
    governanceEngine.registerGuardrail(new LoopDetectionGuardrail());
    governanceEngine.registerGuardrail(new RunawayRetriesGuardrail());
    governanceEngine.registerGuardrail(new TaskGraphLimitGuardrail());

    const approvalWorkflow = new ApprovalWorkflow(eventStore, eventBus);

    // Construct Inspector with Full Governance Modules
    const inspector = new RuntimeInspector(
      metrics,
      queue,
      discovery,
      eventStore,
      undefined,
      undefined,
      governanceEngine,
      approvalWorkflow
    );

    const executor = new TaskExecutor(
      queue,
      eventBus,
      persistence,
      logger,
      [new FlociExecutionAdapter()],
      metrics,
      tracer
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
      planningEngine,
      governanceEngine,
      approvalWorkflow,
      inspector
    );

    await orchestrator.start();

    // 1. Submit a completely safe cloud template objective
    const safeRes = await orchestrator.submitCognitiveObjective("Deploy news ingestion scraper platform");
    expect(safeRes.allowed).toBe(true);

    // Since it's completely safe, all tasks pass immediately and execute
    const queueLength = await queue.getQueueLength();
    expect(queueLength).toBe(0); // completely executed by executor driving loop

    // 2. Submit a dangerous database setup objective (requires supervisor role approvals)
    const dangerousRes = await orchestrator.submitCognitiveObjective("Provision secure database backup");
    expect(dangerousRes.allowed).toBe(true);

    // Verify diagnostic APIs reflect active approvals and plans lists
    const api = new RuntimeDiagnosticAPI(inspector);

    // GET /runtime/governance
    const govInfo = await api.handle("GET", "/runtime/governance");
    expect(govInfo.constraints).toContain("ResourceScopeConstraint");

    // GET /runtime/plans
    const plans = await api.handle("GET", "/runtime/plans");
    expect(plans.length).toBe(2); // safe objective + dangerous database objective

    // GET /runtime/approvals
    const approvals = await api.handle("GET", "/runtime/approvals");
    expect(approvals.length).toBe(1); // the iam role task requires supervisor approval!
    expect(approvals[0].status).toBe("pending");

    // Supervisor approves the task
    await approvalWorkflow.approve(approvals[0].approvalId, "operator-supervisor");
    const updatedApprovals = await api.handle("GET", "/runtime/approvals");
    expect(updatedApprovals[0].status).toBe("approved");
  });
});
