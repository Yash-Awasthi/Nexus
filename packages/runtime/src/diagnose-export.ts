// @ts-nocheck
import * as fs from "fs";
import * as path from "path";

import { ApprovalWorkflow } from "../orchestration/approval-workflow.js";
import { RuntimeDiagnosticAPI } from "../orchestration/diagnostic-api.js";
import { LocalEventBus } from "../orchestration/event-bus.js";
import { MetricsCollector } from "../orchestration/observability-manager.js";
import { FileEventStore, FileRuntimePersistence } from "../orchestration/persistence-manager.js";
import { MemoryQueueBackend } from "../orchestration/queue-backend.js";
import { RuntimeInspector } from "../orchestration/runtime-inspector.js";
import { LocalServiceDiscovery } from "../orchestration/service-discovery.js";
import {
  WorkflowRegistry,
  WorkflowTelemetry,
  BrowserResearchWorkflowTemplate,
  LocalCloudProvisioningTemplate
} from "../orchestration/workflow-engine.js";


async function exportDiagnostics() {
  console.log("[DIAG] Packaging GhostStack v1.1 Operational Diagnostics Snapshot...");

  const testDir = path.join(__dirname, "../data-runtime");
  const eventLogPath = path.join(testDir, "events.jsonl");
  const cacheDbPath = path.join(testDir, "cache.json");

  const eventStore = new FileEventStore(eventLogPath);
  const queue = new MemoryQueueBackend();
  const metrics = new MetricsCollector();
  const discovery = new LocalServiceDiscovery();
  const eventBus = new LocalEventBus();
  const approval = new ApprovalWorkflow(eventStore, eventBus);
  const registry = new WorkflowRegistry();
  const persistence = new FileRuntimePersistence(cacheDbPath);
  const telemetry = new WorkflowTelemetry(persistence);

  // Register templates to have metadata inside diagnostics
  registry.registerTemplate(new BrowserResearchWorkflowTemplate());
  registry.registerTemplate(new LocalCloudProvisioningTemplate());

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

  new RuntimeDiagnosticAPI(inspector);

  const diagnosticsSnapshot = {
    timestamp: new Date().toISOString(),
    engine: {
      platform: "GhostStack",
      version: "1.1-hardened",
      status: "operational"
    },
    queues: {
      activeLength: await queue.getQueueLength(),
      deadLetterLength: (await queue.getDeadLetterQueue()).length
    },
    workflows: {
      registeredTemplates: registry.listTemplates().map((t) => ({ id: t.templateId, name: t.name })),
      telemetryHistory: telemetry.getExecutionHistory()
    },
    services: await discovery.listServices(),
    systemMetrics: {
      telemetryEventsCount: (await eventStore.replayEvents()).length,
      governanceApprovalsCount: (await approval.listRecords()).length
    }
  };

  const logsDir = path.join(__dirname, "../logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const exportPath = path.join(logsDir, "diagnostics-export.json");
  fs.writeFileSync(exportPath, JSON.stringify(diagnosticsSnapshot, null, 2), "utf8");

  console.log(`\x1b[32m[SUCCESS] Operational diagnostics successfully exported to: ${exportPath}\x1b[0m`);
  console.log(`  - Registered templates count: ${diagnosticsSnapshot.workflows.registeredTemplates.length}`);
  console.log(`  - Telemetry events replayed: ${diagnosticsSnapshot.systemMetrics.telemetryEventsCount}`);
  console.log(`  - Governance approval records: ${diagnosticsSnapshot.systemMetrics.governanceApprovalsCount}`);
}

exportDiagnostics().catch((err) => {
  console.error("[CRITICAL] Diagnostics exporter failed:", err);
  process.exit(1);
});
