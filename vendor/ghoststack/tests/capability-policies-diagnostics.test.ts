import { CapabilityPolicy, ExecutionEnvironment } from "../orchestration/capability-policy";
import { EnvironmentTelemetry } from "../orchestration/environment-telemetry";
import { FilesystemSandbox, SandboxConstraint } from "../orchestration/filesystem-sandbox";
import { RuntimeInspector } from "../orchestration/runtime-inspector";
import { RuntimeDiagnosticAPI } from "../orchestration/diagnostic-api";
import { MetricsCollector } from "../orchestration/observability-manager";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { LocalServiceDiscovery } from "../orchestration/service-discovery";
import { FileEventStore } from "../orchestration/persistence-manager";
import * as path from "path";
import * as fs from "fs";

describe("Milestone 4: Capability Policies & Diagnostics API Mappings", () => {
  const rootDir = path.resolve(path.join(__dirname, "../temp-inspector-test"));
  const eventLogPath = path.join(rootDir, "events_inspect.jsonl");

  beforeEach(() => {
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("should enforce capability isolation policies", async () => {
    const policy = new CapabilityPolicy();
    const telemetry = new EnvironmentTelemetry();

    // 1. Environment with ONLY local sandbox access (filesystem write)
    const localEnv = new ExecutionEnvironment("local-sandbox", ["FILESYSTEM_WRITE"], telemetry);

    const safeRes = await policy.evaluateCapability("sandbox", localEnv);
    expect(safeRes.allowed).toBe(true);

    const blockedRes = await policy.evaluateCapability("browser", localEnv);
    expect(blockedRes.allowed).toBe(false);
    expect(blockedRes.reason).toContain("Task requires BROWSER_INTERACT");

    // 2. Full environment with network and browser capability
    const cloudEnv = new ExecutionEnvironment("cloud-context", ["BROWSER_INTERACT", "NETWORK_ACCESS"], telemetry);
    const cloudRes = await policy.evaluateCapability("browser", cloudEnv);
    expect(cloudRes.allowed).toBe(true);
  });

  it("should expose all environment telemetry metrics through diagnostic routes", async () => {
    const metrics = new MetricsCollector();
    const queue = new MemoryQueueBackend();
    const discovery = new LocalServiceDiscovery();
    const eventStore = new FileEventStore(eventLogPath);

    const browserTelemetry = new EnvironmentTelemetry();
    const scrapingTelemetry = new EnvironmentTelemetry();
    const constraint = new SandboxConstraint(100, rootDir);
    const sandbox = new FilesystemSandbox(rootDir, constraint);

    const testEnv = new ExecutionEnvironment("test-env", ["FILESYSTEM_WRITE"], browserTelemetry);

    // Simulate telemetry activity
    browserTelemetry.browserSessionsActive = 3;
    browserTelemetry.recordNavigation("https://news.ycombinator.com");
    scrapingTelemetry.recordFetch(1200);
    await sandbox.writeFile(path.join(rootDir, "inspect.txt"), "inspect test");

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
      scrapingTelemetry,
      sandbox,
      [testEnv]
    );

    const api = new RuntimeDiagnosticAPI(inspector);

    // GET /runtime/browser
    const browserRes = await api.handle("GET", "/runtime/browser");
    expect(browserRes.activeSessions).toBe(3);
    expect(browserRes.navigationHistory).toContain("https://news.ycombinator.com");

    // GET /runtime/scraping
    const scrapingRes = await api.handle("GET", "/runtime/scraping");
    expect(scrapingRes.totalBytesFetched).toBe(1200);

    // GET /runtime/sandbox
    const sandboxRes = await api.handle("GET", "/runtime/sandbox");
    expect(sandboxRes.writeLog.length).toBe(1);
    expect(sandboxRes.writeLog[0].bytes).toBe(12);

    // GET /runtime/environments
    const envsRes = await api.handle("GET", "/runtime/environments");
    expect(envsRes.length).toBe(1);
    expect(envsRes[0].name).toBe("test-env");
    expect(envsRes[0].capabilities).toContain("FILESYSTEM_WRITE");
  });
});
