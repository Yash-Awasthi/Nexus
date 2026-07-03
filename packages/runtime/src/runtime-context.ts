// SPDX-License-Identifier: Apache-2.0

import * as path from "node:path";

import {
  ApprovalWorkflow,
  GovernanceEngine,
  ResourceScopeConstraint,
  CostBudgetConstraint,
  DangerousOperationPolicy,
  WildcardPermissionsPolicy,
  LoopDetectionGuardrail,
  RunawayRetriesGuardrail,
  TaskGraphLimitGuardrail,
} from "@nexus/governance";
import {
  MemoryManager,
  PgVectorStore,
  GroqEmbedder,
  InMemoryStore,
  FixedEmbedder,
} from "@nexus/memory";
import { EnvironmentTelemetry, StructuredLogger } from "@nexus/telemetry";

import { AgentBus, TaskDelegationAgent } from "./agent-bus.js";
import { LocalAgentRegistry } from "./agent-registry.js";
import { BrowserExecutionAdapter } from "./browser-adapter.js";
import { HealthAwareCircuitBreaker, CircuitBreakerAdapterWrapper } from "./circuit-breaker.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { CodeAgentPool } from "./code-agent-pool.js";
import { GHOSTSTACK_MCP_TOOLS } from "./conductor-mcp-bridge.js";
import { YAMLConfigLoader } from "./config-loader.js";
import { loadEnvFromRoot } from "./env-loader.js";
import { LocalEventBus } from "./event-bus.js";
import { FileQueueBackend } from "./file-queue-backend.js";
import { FlociExecutionAdapter } from "./floci-adapter.js";
import { resolveFlociEndpoint } from "./floci-client.js";
import { EXTENDED_FLOCI_ACTIONS } from "./floci-extended.js";
import type { IQueueBackend } from "./interfaces/queue.interface.js";
import { createLanguageModel } from "./language-model.js";
import { LocalInferenceAdapter } from "./local-inference-adapter.js";
import { MemoryStore, TraceIndexer } from "./memory-store.js";
import { MetricsCollector, TraceRecorder, DiagnosticEnricher } from "./observability-manager.js";
import { ConductorOrchestrator } from "./orchestrator.js";
import {
  FileEventStore,
  FileRuntimePersistence,
  backupRuntimePersistence,
} from "./persistence-manager.js";
import { PlanningEngine } from "./planning-engine.js";
import { RuntimeCompactor, LeakDetector, ResourceQuotaManager } from "./runtime-compactor.js";
import { RuntimeGraph } from "./runtime-graph.js";
import { RuntimeInspector } from "./runtime-inspector.js";
import { RuntimeManager } from "./runtime-manager.js";
import type { RuntimeSandboxLayout } from "./runtime-sandbox.js";
import { createRuntimeSandbox } from "./runtime-sandbox.js";
import { ScrapingExecutionAdapter } from "./scraping-adapter.js";
import { LocalServiceDiscovery, HealthMonitor } from "./service-discovery.js";
import { loadWorkflowSpecsFromDir, specToWorkflowDefinition } from "./spec-loader.js";
import { TaskExecutor } from "./task-executor.js";
import { TaskRouter } from "./task-router.js";
import { WebSearchAdapter } from "./web-search-adapter.js";
import {
  WorkflowRegistry,
  WorkflowTelemetry,
  WorkflowEngine,
  BrowserResearchWorkflowTemplate,
  LocalCloudProvisioningTemplate,
  DocumentProcessingTemplate,
  SpecToExecutionTemplate,
  GovernedEtlWorkflowTemplate,
} from "./workflow-engine.js";

export interface ConductorRuntimeContext {
  repoRoot: string;
  sandbox: RuntimeSandboxLayout;
  runtimeDbDir: string;
  logger: StructuredLogger;
  eventBus: LocalEventBus;
  eventStore: FileEventStore;
  persistence: FileRuntimePersistence;
  metrics: MetricsCollector;
  tracer: TraceRecorder;
  queue: IQueueBackend;
  discovery: LocalServiceDiscovery;
  healthMonitor: HealthMonitor;
  approval: ApprovalWorkflow;
  orchestrator: ConductorOrchestrator;
  registry: WorkflowRegistry;
  workflowTelemetry: WorkflowTelemetry;
  workflowEngine: WorkflowEngine;
  inspector: RuntimeInspector;
  browserAdapter: BrowserExecutionAdapter;
  scrapingAdapter: ScrapingExecutionAdapter;
  flociAdapter: FlociExecutionAdapter;
  webSearchAdapter: WebSearchAdapter;
  codeAgentPool: CodeAgentPool;
  localInferenceAdapter: LocalInferenceAdapter;
  configLoader: YAMLConfigLoader;
  memoryStore: MemoryStore;
  agentBus: AgentBus;
  circuitBreaker: CircuitBreaker;
  circuitBreakerWrapper: CircuitBreakerAdapterWrapper;
  traceIndexer: TraceIndexer;
  diagnosticEnricher: DiagnosticEnricher;
  runtimeGraph: RuntimeGraph;
  runtimeCompactor: RuntimeCompactor;
  leakDetector: LeakDetector;
  quotaManager: ResourceQuotaManager;
  planningEngine: PlanningEngine;
  governanceEngine: GovernanceEngine;
  /**
   * Semantic vector memory — production-grade long-term recall backed by
   * Postgres pgvector (PgVectorStore + GroqEmbedder).  Falls back to
   * InMemoryStore + FixedEmbedder when GHOSTSTACK_OFFLINE_MODE is true.
   */
  vectorMemory: MemoryManager;
  /** Cleanup functions for event bus subscriptions and other resources */
  cleanup: (() => void)[];
}

export async function createRuntimeContext(repoRoot: string): Promise<ConductorRuntimeContext> {
  // Load .env file before anything reads process.env — existing vars always win.
  loadEnvFromRoot(repoRoot);

  const sandbox = createRuntimeSandbox(repoRoot);
  const runtimeDbDir = sandbox.dataDir;
  const eventLogPath = path.join(runtimeDbDir, "events.jsonl");
  const cacheDbPath = path.join(runtimeDbDir, "cache.json");

  const loader = new YAMLConfigLoader({
    portsPath: path.join(repoRoot, "runtime", "ports.yaml"),
    servicesPath: path.join(repoRoot, "runtime", "services.yaml"),
    healthchecksPath: path.join(repoRoot, "runtime", "healthchecks.yaml"),
    runtimePath: path.join(repoRoot, "runtime", "conductor.runtime.yaml"),
  });

  const logger = new StructuredLogger();
  const eventBus = new LocalEventBus({ logger });
  const eventStore = new FileEventStore(eventLogPath, logger);
  const persistence = new FileRuntimePersistence(cacheDbPath, logger);
  const runtimeManager = new RuntimeManager(loader);
  const agentRegistry = new LocalAgentRegistry();
  const taskRouter = new TaskRouter(eventBus, eventStore);

  const metrics = new MetricsCollector();
  const tracer = new TraceRecorder();
  const queue = new FileQueueBackend(runtimeDbDir);
  await queue.init();
  const discovery = new LocalServiceDiscovery();
  const healthMonitor = new HealthMonitor(loader, discovery, logger);
  const approval = new ApprovalWorkflow(eventStore, eventBus);

  const offlineMode =
    process.env.GHOSTSTACK_OFFLINE_MODE === "1" ||
    (process.env.GHOSTSTACK_OFFLINE_MODE ?? "").toLowerCase() === "true";

  const browserTelemetry = new EnvironmentTelemetry();
  const scrapingTelemetry = new EnvironmentTelemetry();
  const browserAdapter = new BrowserExecutionAdapter(browserTelemetry, offlineMode);
  const scrapingAdapter = new ScrapingExecutionAdapter(scrapingTelemetry, offlineMode);
  const webSearchAdapter = new WebSearchAdapter();
  const codeAgentPool = new CodeAgentPool();
  const localInferenceAdapter = new LocalInferenceAdapter();
  const flociStrict =
    process.env.GHOSTSTACK_FLOCI_STRICT === "1" ||
    (process.env.GHOSTSTACK_FLOCI_STRICT ?? "").toLowerCase() === "true";
  // ------------------------------------------------------------------
  // Unified Memory & Knowledge Layer
  // ------------------------------------------------------------------
  const memoryStore = new MemoryStore(persistence, logger);
  const agentBus = new AgentBus(eventBus, eventStore, memoryStore, logger);
  new TaskDelegationAgent(agentBus);

  // Register built-in agent capabilities
  agentBus.registerCapability("runtime", [
    "workflow",
    "sandbox",
    "spec",
    "diagnostics",
    ...EXTENDED_FLOCI_ACTIONS,
  ]);

  const flociAdapter = new FlociExecutionAdapter({
    strict: flociStrict,
    persistence,
    onEvent: async (event, payload) => {
      await eventBus.publish(event, payload);
      await eventStore.saveEvent(event, payload);
    },
  });

  // ------------------------------------------------------------------
  // Circuit Breaker for Floci resilience (flociAdapter must be declared first)
  // ------------------------------------------------------------------
  const circuitBreaker = new HealthAwareCircuitBreaker(
    {
      failureThreshold: 3,
      recoveryTimeoutMs: 15000,
      halfOpenMaxRequests: 3,
      halfOpenSuccessRate: 0.5,
      name: "floci",
    },
    async () => {
      const health = await flociAdapter.probeHealth();
      return health.reachable;
    },
    10000,
    eventBus,
    logger,
    metrics,
  );

  // Use proper CircuitBreakerAdapterWrapper instead of fragile monkey-patching
  const circuitBreakerWrapper = new CircuitBreakerAdapterWrapper(circuitBreaker, logger);
  // Create a wrapped proxy that delegates through the circuit breaker
  const wrappedFlociAdapter = circuitBreakerWrapper.wrapAdapter(flociAdapter);

  // ------------------------------------------------------------------
  // Wire TraceIndexer for automatic event-to-memory indexing
  // ------------------------------------------------------------------
  const traceIndexer = new TraceIndexer(eventStore, memoryStore);
  // Subscribe to event bus to auto-index events as memory entries
  const cleanupFns: (() => void)[] = [];
  const wildcardSub = eventBus.subscribe("*", async (_payload: unknown) => {
    // Fire-and-forget index; never block event processing
    traceIndexer.indexRecentEvents().catch(() => {});
  });
  cleanupFns.push(() => wildcardSub.unsubscribe());

  const executor = new TaskExecutor(
    queue,
    eventBus,
    persistence,
    logger,
    [
      browserAdapter,
      scrapingAdapter,
      wrappedFlociAdapter,
      webSearchAdapter,
      codeAgentPool,
      localInferenceAdapter,
    ],
    metrics,
    tracer,
  );

  // ------------------------------------------------------------------
  // Wire governance engine with constraints, policies, and guardrails
  // ------------------------------------------------------------------
  const planningEngine = new PlanningEngine(
    createLanguageModel({ provider: "groq", groqApiKey: process.env.GROQ_API_KEY }),
  );

  // ------------------------------------------------------------------
  // Semantic vector memory (PgVectorStore + GroqEmbedder in production;
  // InMemoryStore + FixedEmbedder in offline / test mode)
  // ------------------------------------------------------------------
  const vectorMemory = new MemoryManager(
    offlineMode || !process.env.DATABASE_URL
      ? { store: new InMemoryStore(), embedder: new FixedEmbedder(768) }
      : {
          store: new PgVectorStore({ databaseUrl: process.env.DATABASE_URL }),
          embedder: new GroqEmbedder({ apiKey: process.env.GROQ_API_KEY }),
        },
  );

  const governanceEngine = new GovernanceEngine();

  governanceEngine.registerConstraint(new ResourceScopeConstraint(["system:root", "admin:direct"]));
  governanceEngine.registerConstraint(new CostBudgetConstraint(0.5));
  governanceEngine.registerPolicy(new DangerousOperationPolicy());
  governanceEngine.registerPolicy(new WildcardPermissionsPolicy());
  governanceEngine.registerGuardrail(new LoopDetectionGuardrail(5));
  governanceEngine.registerGuardrail(new RunawayRetriesGuardrail(5));
  governanceEngine.registerGuardrail(new TaskGraphLimitGuardrail(50));

  const orchestrator = ConductorOrchestrator.create({
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
    approvalWorkflow: approval,
  });

  // ------------------------------------------------------------------
  // Runtime Graph — Unified Topology
  // ------------------------------------------------------------------
  const runtimeGraph = new RuntimeGraph(persistence, eventBus);

  // Auto-register Floci connections as they're discovered
  runtimeGraph.addNode("floci", "mcp_server", "Floci Local AWS Emulator", {
    metadata: { endpoint: resolveFlociEndpoint() },
    status: "pending",
  });
  runtimeGraph.addNode("conductor-runtime", "agent", "Conductor Runtime", {
    metadata: { version: "1.1.0" },
    status: "active",
  });

  // Register MCP bridge as a node
  runtimeGraph.addNode("mcp-bridge", "mcp_server", "Conductor MCP Bridge", {
    metadata: { tools: GHOSTSTACK_MCP_TOOLS.length },
    status: "active",
  });

  // ------------------------------------------------------------------
  // Runtime Compactor — Bounded Growth, Leak Detection, Quota Enforcement
  // ------------------------------------------------------------------
  const leakDetector = new LeakDetector(eventBus);
  const quotaManager = new ResourceQuotaManager(undefined, metrics);
  const runtimeCompactor = new RuntimeCompactor(eventBus, {
    persistence,
    queue,
    leakDetector,
    quotaManager,
    metrics,
    runtimeGraph,
    logger,
    options: {
      autoCompact: false, // Don't auto-start; orchestrated lifecycle
      maxEventAgeMs: 3_600_000, // 1 hour
    },
  });

  const diagnosticEnricher = new DiagnosticEnricher(metrics, tracer);

  // ── Auto-register Floci resources in RuntimeGraph via event bus ──
  const flociActionSub = eventBus.subscribe("floci_action_completed", async (payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const action = p.action as string;
    const status = p.status as string;
    const service = p.service as string;

    let nodeId: string | undefined;
    let nodeType:
      | "floci_s3_bucket"
      | "floci_sqs_queue"
      | "floci_dynamodb_table"
      | "floci_lambda_function"
      | "floci_sns_topic"
      | undefined;
    let nodeName: string | undefined;

    if (action === "create_s3_bucket") {
      nodeId = `s3:${p.bucketName}`;
      nodeType = "floci_s3_bucket";
      nodeName = `Bucket: ${p.bucketName}`;
    } else if (action === "create_sqs_queue") {
      nodeId = `sqs:${p.queueName}`;
      nodeType = "floci_sqs_queue";
      nodeName = `Queue: ${p.queueName}`;
    } else if (action === "create_dynamodb_table") {
      nodeId = `ddb:${p.tableName}`;
      nodeType = "floci_dynamodb_table";
      nodeName = `Table: ${p.tableName}`;
    } else if (action === "create_lambda") {
      nodeId = `lambda:${p.functionName}`;
      nodeType = "floci_lambda_function";
      nodeName = `Lambda: ${p.functionName}`;
    } else if (action === "delete_lambda") {
      await runtimeGraph.updateNodeStatus(`lambda:${p.functionName}`, "removed", {
        reason: "Lambda deleted via Floci",
      });
      return;
    }

    if (nodeId && nodeType && nodeName) {
      const nodeStatus = status === "success" ? "active" : "failed";
      try {
        await runtimeGraph.addNode(nodeId, nodeType, nodeName, {
          status: nodeStatus,
          metadata: { action, service, flociPayload: payload },
          dependencies: ["floci"],
        });
      } catch {
        // Node may already exist; update status instead
        await runtimeGraph.updateNodeStatus(nodeId, nodeStatus);
      }
    }
  });
  cleanupFns.push(() => flociActionSub.unsubscribe());

  // ------------------------------------------------------------------
  // Workflow Engine (declared AFTER runtimeGraph)
  // ------------------------------------------------------------------
  const registry = new WorkflowRegistry();
  const workflowTelemetry = new WorkflowTelemetry(persistence);
  const workflowEngine = new WorkflowEngine(
    registry,
    workflowTelemetry,
    orchestrator,
    approval,
    persistence,
    eventBus,
    runtimeGraph,
  );

  registry.registerTemplate(new BrowserResearchWorkflowTemplate());
  registry.registerTemplate(new LocalCloudProvisioningTemplate());
  registry.registerTemplate(new DocumentProcessingTemplate());
  registry.registerTemplate(new SpecToExecutionTemplate());
  registry.registerTemplate(new GovernedEtlWorkflowTemplate());

  for (const { filePath, spec } of loadWorkflowSpecsFromDir(sandbox.specsDir)) {
    const workflowId = path.basename(path.dirname(filePath));
    registry.registerWorkflow(specToWorkflowDefinition(spec, workflowId));
    logger.info("Loaded workflow spec", { workflowId, templateId: spec.template_id, filePath });
  }

  // ── Floci S3 Event → Workflow Auto-Trigger Pipeline ─────────────────
  // When S3 objects are created under a watched prefix, auto-trigger
  // any registered workflows that declare S3 trigger bindings in their metadata.
  // Configure via workflow definition metadata.s3Triggers, e.g.:
  //   metadata: { s3Triggers: [{ bucket: "my-bucket", prefix: "uploads/" }] }
  const s3TriggerSub = eventBus.subscribe("floci_s3_object_created", async (evt: unknown) => {
    const evtRec = evt as Record<string, Record<string, unknown>>;
    const bucketName = evtRec.payload?.bucketName as string;
    const objectKey = evtRec.payload?.key as string;
    if (!bucketName || !objectKey) return;

    for (const wf of registry.listWorkflows()) {
      const wfMeta = wf.metadata;
      if (!wfMeta) continue;
      const triggerConfig = wfMeta.s3Triggers as { bucket: string; prefix?: string }[] | undefined;
      if (!triggerConfig) continue;

      for (const trigger of triggerConfig) {
        if (trigger.bucket !== bucketName) continue;
        if (trigger.prefix && !objectKey.startsWith(trigger.prefix)) continue;

        const execId = `s3-trigger-${wf.id}-${Date.now()}`;
        workflowEngine.executeWorkflow(wf.id, execId).catch((err) => {
          logger.error("S3 auto-trigger workflow failed", {
            workflowId: wf.id,
            executionId: execId,
            error: err.message,
          });
        });
        logger.info("S3 event auto-triggered workflow", {
          workflowId: wf.id,
          executionId: execId,
          bucket: bucketName,
          key: objectKey,
        });
      }
    }
  });
  cleanupFns.push(() => s3TriggerSub.unsubscribe());

  // Wire workflow events to auto-store in Memory Store and RuntimeGraph
  const wfCleanup = workflowEngine.onAny(async (wfEvent) => {
    // Auto-register workflow executions in RuntimeGraph when they start
    if (wfEvent.type === "workflow:execution_started") {
      await runtimeGraph.addNode(
        `wf-exec:${wfEvent.executionId}`,
        "workflow",
        `Workflow:${wfEvent.workflowId}`,
        {
          metadata: { workflowId: wfEvent.workflowId, executionId: wfEvent.executionId },
          status: "active",
          dependencies: ["conductor-runtime"],
        },
      );
    }
    if (
      wfEvent.type === "workflow:execution_failed" ||
      wfEvent.type === "workflow:execution_cancelled"
    ) {
      await runtimeGraph.updateNodeStatus(`wf-exec:${wfEvent.executionId}`, "failed", {
        error: wfEvent.payload?.error,
      });
    }
    if (wfEvent.type === "workflow:execution_succeeded") {
      await runtimeGraph.updateNodeStatus(`wf-exec:${wfEvent.executionId}`, "active", {
        completed: true,
      });
    }

    await memoryStore.store({
      type:
        wfEvent.type.includes("failed") || wfEvent.type.includes("cancelled")
          ? "error"
          : wfEvent.type.includes("succeeded") || wfEvent.type.includes("completed")
            ? "result"
            : wfEvent.type.includes("approval")
              ? "decision"
              : "observation",
      key: `workflow:${wfEvent.type}:${wfEvent.executionId}`,
      value: { workflowId: wfEvent.workflowId, payload: wfEvent.payload },
      tags: ["workflow", wfEvent.type, `exec:${wfEvent.executionId}`],
      workflowId: wfEvent.workflowId,
      executionId: wfEvent.executionId,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });
    // Record timing gauge for each workflow event
    metrics.increment(`workflow.event.${wfEvent.type.replace(":", ".")}`);
  });
  cleanupFns.push(() => wfCleanup.unsubscribe());

  const inspector = RuntimeInspector.fromContext({
    metrics,
    queue,
    discovery,
    eventStore,
    governanceEngine,
    approval,
    browserTelemetry,
    scrapingTelemetry,
    registry,
    workflowTelemetry,
    workflowEngine,
    memoryStore,
    agentBus,
    circuitBreaker,
    circuitBreakerWrapper,
    traceIndexer,
  });

  if (process.env.GHOSTSTACK_BACKUP_ON_START === "1") {
    const backups = backupRuntimePersistence(eventStore, persistence, sandbox.backupsDir);
    logger.info("Runtime persistence backup created", backups);
  }

  return {
    repoRoot,
    sandbox,
    runtimeDbDir,
    logger,
    eventBus,
    eventStore,
    persistence,
    metrics,
    tracer,
    queue,
    discovery,
    healthMonitor,
    approval,
    orchestrator,
    registry,
    workflowTelemetry,
    workflowEngine,
    inspector,
    browserAdapter,
    scrapingAdapter,
    flociAdapter: wrappedFlociAdapter,
    webSearchAdapter,
    codeAgentPool,
    localInferenceAdapter,
    configLoader: loader,
    memoryStore,
    agentBus,
    circuitBreaker,
    circuitBreakerWrapper,
    traceIndexer,
    diagnosticEnricher,
    runtimeGraph,
    runtimeCompactor,
    leakDetector,
    quotaManager,
    planningEngine,
    governanceEngine,
    vectorMemory,
    cleanup: cleanupFns,
  };
}

/** Boot orchestrator replay + federation health probes + compaction scheduling. */
export async function startRuntime(ctx: ConductorRuntimeContext): Promise<string[]> {
  const services = await ctx.orchestrator.start();
  await ctx.healthMonitor.startMonitoring();
  const flociHealth = await ctx.flociAdapter.probeHealth();
  ctx.metrics.recordTiming("floci.health_probe_ms", flociHealth.latencyMs);
  ctx.metrics.recordGauge("floci.reachable", flociHealth.reachable ? 1 : 0);
  ctx.logger.info("Floci health probe complete", {
    reachable: flociHealth.reachable,
    endpoint: flociHealth.endpoint,
    healthPath: flociHealth.healthPath,
  });
  // Start periodic compaction (every 5 minutes) with adaptive heuristics
  ctx.runtimeCompactor.start(5 * 60 * 1000);
  ctx.logger.info("Runtime compaction scheduler started (interval: 5 min)");
  // Start MemoryStore proactive TTL eviction (every 2 minutes)
  ctx.memoryStore.startAutoPrune(2 * 60 * 1000);
  ctx.logger.info("MemoryStore auto-prune started (interval: 2 min)");
  return services;
}

/**
 * Gracefully stop all runtime services.
 *
 * Each cleanup step is individually caught so a failure in one step
 * (e.g. health monitor disconnect) does not prevent subsequent steps
 * from running (e.g. persisting final state, cleaning subscriptions).
 */
export async function stopRuntime(ctx: ConductorRuntimeContext): Promise<void> {
  const errors: string[] = [];

  // 1. Stop health monitoring
  try {
    await ctx.healthMonitor.stopMonitoring();
  } catch (err) {
    errors.push(`healthMonitor: ${(err as Error).message}`);
  }

  // 2. Destroy circuit breaker health probes
  try {
    if (ctx.circuitBreaker && "destroy" in ctx.circuitBreaker) {
      (ctx.circuitBreaker as unknown as { destroy(): void }).destroy();
    }
  } catch (err) {
    errors.push(`circuitBreaker: ${(err as Error).message}`);
  }

  // 3. Stop memory store auto-prune timer
  try {
    ctx.memoryStore.stopAutoPrune();
  } catch (err) {
    errors.push(`memoryStore.stopAutoPrune: ${(err as Error).message}`);
  }

  // 4. Run final compaction cycle before stopping timer
  try {
    await ctx.runtimeCompactor.compact();
  } catch (err) {
    errors.push(`runtimeCompactor.compact: ${(err as Error).message}`);
  }

  // 5. Stop runtime compactor timer
  try {
    ctx.runtimeCompactor.stop();
  } catch (err) {
    errors.push(`runtimeCompactor.stop: ${(err as Error).message}`);
  }

  // 6. Clean up event bus subscriptions and workflow engine listeners
  for (const fn of ctx.cleanup) {
    try {
      fn();
    } catch (err) {
      errors.push(`cleanup fn: ${(err as Error).message}`);
    }
  }

  if (errors.length > 0) {
    ctx.logger.warn(`[stopRuntime] ${errors.length} cleanup step(s) encountered errors:`, {
      errors,
    });
  }
}
