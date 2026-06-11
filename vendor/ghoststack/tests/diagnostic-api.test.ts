import { RuntimeDiagnosticAPI } from "../orchestration/diagnostic-api";
import { RuntimeInspector } from "../orchestration/runtime-inspector";
import { MetricsCollector } from "../orchestration/observability-manager";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { LocalServiceDiscovery } from "../orchestration/service-discovery";
import { FileEventStore } from "../orchestration/persistence-manager";
import * as path from "path";
import * as fs from "fs";

describe("Milestone 4: Diagnostic API Endpoints", () => {
  const testDir = path.join(__dirname, "../temp-api-db");
  const eventLogPath = path.join(testDir, "api_events.jsonl");

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

  it("should return deterministic, typed JSON states for all standard endpoints", async () => {
    const metrics = new MetricsCollector();
    const queue = new MemoryQueueBackend();
    const discovery = new LocalServiceDiscovery();
    const eventStore = new FileEventStore(eventLogPath);

    const inspector = new RuntimeInspector(metrics, queue, discovery, eventStore);
    const api = new RuntimeDiagnosticAPI(inspector);

    // Seed some telemetry metrics
    metrics.increment("task.submitted", 2);

    // 1. GET /health
    const healthRes = await api.handle("GET", "/health");
    expect(healthRes.status).toBe("healthy");

    // 2. GET /metrics
    const metricsRes = await api.handle("GET", "/metrics");
    expect(metricsRes["task.submitted"]).toBe(2);

    // 3. GET /runtime/state
    const stateRes = await api.handle("GET", "/runtime/state");
    expect(stateRes.health.status).toBe("healthy");

    // 4. GET /runtime/tasks
    const tasksRes = await api.handle("GET", "/runtime/tasks");
    expect(Array.isArray(tasksRes)).toBe(true);

    // 5. GET /runtime/events
    const eventsRes = await api.handle("GET", "/runtime/events");
    expect(Array.isArray(eventsRes)).toBe(true);

    // 6. GET /runtime/queues
    const queuesRes = await api.handle("GET", "/runtime/queues");
    expect(queuesRes.activeJobsCount).toBe(0);

    // 7. GET /runtime/services
    const servicesRes = await api.handle("GET", "/runtime/services");
    expect(Array.isArray(servicesRes)).toBe(true);

    // 8. GET /runtime/snapshots
    const snapshotsRes = await api.handle("GET", "/runtime/snapshots");
    expect(snapshotsRes.health).toBeDefined();

    // 9. Error handling for unsupported routes
    await expect(api.handle("GET", "/invalid-route")).rejects.toThrow("Not Found");
  });
});
