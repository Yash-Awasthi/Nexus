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
import { EnvironmentTelemetry } from "../orchestration/environment-telemetry";
import { BrowserExecutionAdapter } from "../orchestration/browser-adapter";
import { ScrapingExecutionAdapter } from "../orchestration/scraping-adapter";
import { LocalServiceDiscovery } from "../orchestration/service-discovery";
import { YAMLConfigLoader } from "../runtime/config-loader";
import * as path from "path";
import * as fs from "fs";

describe("Phase 7: Controlled Runtime Environment Integration E2E", () => {
  const testDir = path.join(__dirname, "../temp-env-integration-db");
  const eventLogPath = path.join(testDir, "env_integration_events.jsonl");
  const cacheDbPath = path.join(testDir, "env_integration_cache.json");

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

  it("should process browser and scraping tasks end-to-end and telemetry-inspect outputs", async () => {
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

    // Create telemetry and adapters
    const browserTelemetry = new EnvironmentTelemetry();
    const scrapingTelemetry = new EnvironmentTelemetry();

    const browserAdapter = new BrowserExecutionAdapter(browserTelemetry, true);
    const scrapingAdapter = new ScrapingExecutionAdapter(scrapingTelemetry, true);

    const executor = new TaskExecutor(
      queue,
      eventBus,
      persistence,
      logger,
      [browserAdapter, scrapingAdapter],
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
      undefined,
      browserTelemetry,
      scrapingTelemetry
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
      undefined,
      inspector
    );

    await orchestrator.start();

    // Submit Browser Task and Scraping Task
    await orchestrator.submitAndExecuteTasks([
      {
        id: "task-browser-e2e",
        title: "Launch UI Scraper Test",
        description: "browser test run",
        priority: "high",
        status: "pending",
        dependencies: []
      },
      {
        id: "task-scraping-e2e",
        title: "Gather financial headlines",
        description: "scraping headlines info",
        priority: "medium",
        status: "pending",
        dependencies: ["task-browser-e2e"]
      }
    ]);

    // Verify telemetry tallies matches mock executions
    expect(browserTelemetry.navigationHistory).toContain("https://github.com");
    expect(browserTelemetry.navigationHistory).toContain("https://news.ycombinator.com");
    expect(scrapingTelemetry.totalBytesFetched).toBe(450); // Capped at maxRequests quota (3 * 150)

    // Verify diagnostic APIs expose these metrics cleanly
    const api = new RuntimeDiagnosticAPI(inspector);

    const browserApiRes = await api.handle("GET", "/runtime/browser");
    expect(browserApiRes.navigationHistory).toContain("https://github.com");

    const scrapingApiRes = await api.handle("GET", "/runtime/scraping");
    expect(scrapingApiRes.totalBytesFetched).toBe(450);
  });
});
