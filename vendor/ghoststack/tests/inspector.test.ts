import { RuntimeInspector } from "../orchestration/runtime-inspector";
import { MetricsCollector } from "../orchestration/observability-manager";
import { MemoryQueueBackend } from "../orchestration/queue-backend";
import { LocalServiceDiscovery } from "../orchestration/service-discovery";
import { FileEventStore } from "../orchestration/persistence-manager";
import * as path from "path";
import * as fs from "fs";

describe("Milestone 2: System Diagnostic Inspector & Snapshots", () => {
  const testDir = path.join(__dirname, "../temp-inspector-db");
  const eventLogPath = path.join(testDir, "inspector_events.jsonl");

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

  it("should assemble queue snapshots, metrics listings, service tables, and export runtime snapshot bundles", async () => {
    const metrics = new MetricsCollector();
    const queue = new MemoryQueueBackend();
    const discovery = new LocalServiceDiscovery();
    const eventStore = new FileEventStore(eventLogPath);

    // Seed state
    metrics.increment("task.completed");
    await discovery.registerService("floci", 4566, { status: "healthy" });
    await eventStore.saveEvent("task_routed", { id: "test-task" });

    await queue.push({
      id: "queued-task-01",
      payload: { action: "create_s3" },
      priority: "medium",
      retries: 0,
      maxRetries: 3,
      createdAt: new Date()
    });

    const inspector = new RuntimeInspector(metrics, queue, discovery, eventStore);

    // 1. Health Endpoint API Inspection
    const health = await inspector.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);

    // 2. Metrics Endpoint API Inspection
    const currentMetrics = await inspector.getMetrics();
    expect(currentMetrics["task.completed"]).toBe(1);

    // 3. Queue Endpoint API Inspection
    const queues = await inspector.getQueues();
    expect(queues.activeJobsCount).toBe(1);
    expect(queues.jobs[0].id).toBe("queued-task-01");

    // 4. Services Endpoint API Inspection
    const services = await inspector.getServices();
    expect(services.length).toBe(1);
    expect(services[0].name).toBe("floci");
    expect(services[0].status).toBe("healthy");

    // 5. Events Endpoint API Inspection
    const events = await inspector.getEvents();
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("task_routed");

    // 6. Complete Snapshot Export Bundle Generation
    const snapshot = await inspector.getSnapshots();
    expect(snapshot.health.status).toBe("healthy");
    expect(snapshot.queues.activeJobsCount).toBe(1);
    expect(snapshot.metrics["task.completed"]).toBe(1);
  });
});
