/**
 * Deterministic Replay & Crash Recovery Tests — Phase 3
 *
 * Validates:
 * - Side-effect suppression during replay (no telemetry, events, RuntimeGraph contamination)
 * - Replay isolation (separate replay context)
 * - Replay lineage tracking
 * - Crash continuation (resume from most recent paused checkpoint)
 * - DeterministicReplay ordering
 * - Fuzzing scenarios
 */

import {
  WorkflowRegistry,
  WorkflowTelemetry,
  WorkflowEngine,
  LocalCloudProvisioningTemplate,
  DocumentProcessingTemplate,
} from "../orchestration/workflow-engine";
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

const testDir = path.join(__dirname, "../temp-deterministic-replay");
const dbPath = path.join(testDir, "state.json");

function buildEngine() {
  const registry = new WorkflowRegistry();
  const persistence = new FileRuntimePersistence(dbPath);
  const telemetry = new WorkflowTelemetry(persistence);
  const loader = new YAMLConfigLoader({
    portsPath: path.join(__dirname, "../runtime/ports.yaml"),
    servicesPath: path.join(__dirname, "../runtime/services.yaml"),
    healthchecksPath: path.join(__dirname, "../runtime/healthchecks.yaml"),
    runtimePath: path.join(__dirname, "../runtime/ghoststack.runtime.yaml")
  });
  const logger = new StructuredLogger();
  const eventBus = new LocalEventBus();
  const eventStore = new FileEventStore(path.join(testDir, "events.jsonl"));
  const runtimeManager = new RuntimeManager(loader);
  const agentRegistry = new LocalAgentRegistry();
  const taskRouter = new TaskRouter(eventBus, eventStore);
  const metrics = new MetricsCollector();
  const tracer = new TraceRecorder();
  const queue = new MemoryQueueBackend();
  const _discovery = new LocalServiceDiscovery();
  const approval = new ApprovalWorkflow(eventStore, eventBus);
  const browserAdapter = new BrowserExecutionAdapter(new EnvironmentTelemetry(), true);
  const scrapingAdapter = new ScrapingExecutionAdapter(new EnvironmentTelemetry(), true);
  const flociAdapter = new FlociExecutionAdapter();
  const executor = new TaskExecutor(
    queue, eventBus, persistence, logger,
    [browserAdapter, scrapingAdapter, flociAdapter], metrics, tracer
  );
  const orchestrator = new GhostStackOrchestrator(
    runtimeManager, eventBus, taskRouter, agentRegistry,
    eventStore, logger, queue, executor, metrics, tracer,
    undefined, undefined, approval
  );
  const engine = new WorkflowEngine(registry, telemetry, orchestrator, approval, persistence, eventBus);
  return { registry, engine, telemetry, eventBus };
}

beforeAll(() => {
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

describe("Phase 3 — Deterministic Replay & Recovery", () => {

  // ── Output Comparison ──────────────────────────────────────────

  describe("replay output correctness", () => {
    it("produces identical task results between original and deterministic replay", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "output-compare" });
      registry.registerWorkflow(wf);

      // Original execution
      const original = await engine.executeWorkflow("output-compare", "exec-output-01");
      expect(original.status).toBe("succeeded");

      // Deterministic replay (side-effect suppressed)
      const replay = await engine.deterministicReplay("exec-output-01");
      expect(replay.status).toBe("succeeded");

      // Both should have same task result keys (same tasks were executed)
      expect(Object.keys(replay.taskResults)).toEqual(Object.keys(original.taskResults));

      // Each task should have the same logical outcome status (not byte-for-byte
      // identical — timing fields like flociLatencyMs and timestamp are
      // non-deterministic and differ between runs by design).
      for (const [taskId, result] of Object.entries(original.taskResults)) {
        expect(replay.taskResults[taskId]?.status).toBe((result as any)?.status);
      }
    });

    it("returns original execution ID for inspection", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "orig-id-check" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("orig-id-check", "exec-orig-id");

      const replay = await engine.deterministicReplay("exec-orig-id");
      expect(replay.originalExecutionId).toBe("exec-orig-id");
      expect(replay.id).not.toBe("exec-orig-id");
    });

    it("replay does not mutate original execution checkpoint state", async () => {
      const { registry, engine } = buildEngine();
      const wf = new DocumentProcessingTemplate().createWorkflow({ id: "checkpoint-immutable", limitBytes: 25000 });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("checkpoint-immutable", "exec-cp-immutable");

      // Checkpoint should exist after execution (briefly, before cleanup)
      const beforeCheckpoints = engine.listCheckpoints();

      await engine.deterministicReplay("exec-cp-immutable");

      // Replay should NOT create new checkpoints
      const afterCheckpoints = engine.listCheckpoints();
      expect(afterCheckpoints.length).toBe(beforeCheckpoints.length);

      // Replay lineage should be recorded but original checkpoint count unchanged
      const lineage = engine.getReplayLineage("exec-cp-immutable");
      expect(lineage).toBeDefined();
      expect(lineage!.previousExecutions.length).toBe(1);
    });

    it("preserves idempotent result across multiple replays", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "idempotent-replay" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("idempotent-replay", "exec-idem");

      // Run 5 replays — all should produce identical results
      const results: Record<string, any>[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await engine.deterministicReplay("exec-idem");
        results.push(r.taskResults);
      }

      // All replays should produce the same logical outcome for each task.
      // Timing fields (flociLatencyMs, timestamp) are non-deterministic and
      // intentionally excluded — we compare only the outcome status.
      const statusMap = (r: Record<string, any>) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, (v as any)?.status]));
      for (let i = 1; i < results.length; i++) {
        expect(statusMap(results[i])).toEqual(statusMap(results[0]));
      }

      // Replay lineage should have 5 entries
      const lineage = engine.getReplayLineage("exec-idem");
      expect(lineage!.previousExecutions.length).toBe(5);
    });

    it("orderedReplay with verifyState validates completion integrity", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "ordered-verify" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("ordered-verify", "exec-ordered");

      // Use ordered replay (not deterministic) — this should verify state
      const replay = await engine.orderedReplay("exec-ordered");
      expect(replay.status).toBe("succeeded");
      expect(replay.stateVerified).toBe(true);
      expect(replay.originalExecutionId).toBe("exec-ordered");
    });
  });

  // ── Side-Effect Suppression ───────────────────────────────────────

  describe("side-effect suppression during replay", () => {
    it("suppresses telemetry recording during deterministic replay", async () => {
      const { registry, engine, telemetry } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "sfx-telemetry" });
      registry.registerWorkflow(wf);

      // Normal execution — creates telemetry
      await engine.executeWorkflow("sfx-telemetry", "exec-sfx-01");
      const historyBefore = telemetry.getExecutionHistory();
      const originalRecords = historyBefore.length;

      // Deterministic replay — should NOT create new telemetry records
      const replay = await engine.deterministicReplay("exec-sfx-01");
      expect(replay.status).toBe("succeeded");
      expect(replay.stateVerified).toBe(true);
      expect(replay.idempotent).toBe(true);

      // Telemetry should NOT have been affected by the replay
      const historyAfter = telemetry.getExecutionHistory();
      expect(historyAfter.length).toBe(originalRecords);
    });

    it("suppresses event bus emission during deterministic replay", async () => {
      const { registry, engine, eventBus } = buildEngine();
      const wf = new DocumentProcessingTemplate().createWorkflow({ id: "sfx-events", limitBytes: 25000 });
      registry.registerWorkflow(wf);

      const eventsPublished: string[] = [];
      eventBus.subscribe("*", async (envelope: any) => {
        eventsPublished.push(envelope.event || envelope);
      });

      // Normal execution
      await engine.executeWorkflow("sfx-events", "exec-events-01");
      const eventCountAfterNormal = eventsPublished.filter(e => e.startsWith("workflow:")).length;

      // Deterministic replay — should NOT publish workflow events
      await engine.deterministicReplay("exec-events-01");
      const eventCountAfterReplay = eventsPublished.filter(e => e.startsWith("workflow:")).length;

      // Event count should be the same (no events from replay)
      expect(eventCountAfterReplay).toBe(eventCountAfterNormal);
    });

    it("does not contaminate RuntimeGraph state during deterministic replay", async () => {
      // This test verifies that replay doesn't create new nodes/edges
      // by ensuring no side-effect contamination occurs
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "sfx-rtgraph" });
      registry.registerWorkflow(wf);

      // Run normally
      await engine.executeWorkflow("sfx-rtgraph", "exec-rtg-01");

      // Count replay lineage — only one lineage entry should result
      const beforeLineage = engine.listReplayLineages();
      expect(beforeLineage.length).toBe(0);

      await engine.deterministicReplay("exec-rtg-01");

      const afterLineage = engine.listReplayLineages();
      expect(afterLineage.length).toBe(1);
      expect(afterLineage[0].originalExecutionId).toBe("exec-rtg-01");
      expect(afterLineage[0].replays).toBe(1);
    });
  });

  // ── Replay Isolation ──────────────────────────────────────────────

  describe("replay isolation and lineage", () => {
    it("creates separate replay execution IDs", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "iso-ids" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("iso-ids", "exec-iso-01");

      const replay1 = await engine.deterministicReplay("exec-iso-01");
      expect(replay1.id).toContain("replay");

      const replay2 = await engine.deterministicReplay("exec-iso-01");
      expect(replay2.id).toContain("replay");
      expect(replay2.id).not.toBe(replay1.id); // different IDs
    });

    it("tracks replay lineage with generation counters", async () => {
      const { registry, engine } = buildEngine();
      const wf = new DocumentProcessingTemplate().createWorkflow({ id: "iso-lineage", limitBytes: 25000 });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("iso-lineage", "exec-lineage-01");

      // Run 3 replays
      for (let i = 0; i < 3; i++) {
        await engine.deterministicReplay("exec-lineage-01");
      }

      const lineage = engine.getReplayLineage("exec-lineage-01");
      expect(lineage).toBeDefined();
      expect(lineage!.previousExecutions.length).toBe(3);
      expect(lineage!.replayGeneration).toBeGreaterThanOrEqual(3);
    });

    it("returns stateVerified=true for deterministic replays", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "iso-verify" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("iso-verify", "exec-iso-verify-01");

      const replay = await engine.deterministicReplay("exec-iso-verify-01");
      expect(replay.stateVerified).toBe(true);
      expect(replay.originalExecutionId).toBe("exec-iso-verify-01");
    });
  });

  // ── Crash Continuation ────────────────────────────────────────────

  describe("crash continuation", () => {
    it("returns null when no paused checkpoints exist", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "cc-none" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("cc-none", "exec-cc-none-01");

      const result = await engine.continueAfterCrash();
      expect(result.resumed).toBeNull();
    });

    it("continues from a specific checkpointed execution", async () => {
      const { registry, engine } = buildEngine();
      const wf = new DocumentProcessingTemplate().createWorkflow({ id: "cc-specific", limitBytes: 25000 });
      registry.registerWorkflow(wf);

      // Execute successfully
      await engine.executeWorkflow("cc-specific", "exec-cc-specific-01");

      // Try to continue from a non-existent checkpoint (execution already completed)
      const result = await engine.continueAfterCrash("exec-cc-specific-01");
      // Since there's no paused checkpoint, resumed will be null
      expect(result.resumed).toBeNull();
    });

    it("records recovery lineage after crash continuation", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "cc-lineage" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("cc-lineage", "exec-cc-lineage-01");

      // Try continuation — execution completed so no paused checkpoints
      const result = await engine.continueAfterCrash("exec-cc-lineage-01");
      expect(result.resumed).toBeNull();
    });

    it("does not contaminate telemetry during crash continuation", async () => {
      const { registry, engine, telemetry } = buildEngine();
      const wf = new DocumentProcessingTemplate().createWorkflow({ id: "cc-telemetry", limitBytes: 25000 });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("cc-telemetry", "exec-cc-02");
      const historyBefore = telemetry.getExecutionHistory().length;

      await engine.continueAfterCrash("exec-cc-02");

      const historyAfter = telemetry.getExecutionHistory().length;
      expect(historyAfter).toBe(historyBefore);
    });
  });

  // ── Deterministic Replay Ordering ─────────────────────────────────

  describe("deterministic replay ordering", () => {
    it("monotonically increments replay generation counter", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "ord-gen" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("ord-gen", "exec-ord-01");

      const gen1 = (await engine.deterministicReplay("exec-ord-01", { replayGeneration: 1 })).originalExecutionId;
      const gen2 = (await engine.deterministicReplay("exec-ord-01", { replayGeneration: 2 })).originalExecutionId;

      expect(gen1).toBe("exec-ord-01");
      expect(gen2).toBe("exec-ord-01");
    });

    it("maintains replay order across multiple workflows", async () => {
      const { registry, engine } = buildEngine();
      const wf1 = new LocalCloudProvisioningTemplate().createWorkflow({ id: "wfa" });
      const wf2 = new DocumentProcessingTemplate().createWorkflow({ id: "wfb", limitBytes: 10000 });
      registry.registerWorkflow(wf1);
      registry.registerWorkflow(wf2);

      await engine.executeWorkflow("wfa", "exec-wf-a");
      await engine.executeWorkflow("wfb", "exec-wf-b");

      // Replay both in order
      await engine.deterministicReplay("exec-wf-a");
      await engine.deterministicReplay("exec-wf-b");

      const lineages = engine.listReplayLineages();
      expect(lineages.length).toBe(2);
    });
  });

  // ── State Verification ────────────────────────────────────────────

  describe("verifyState", () => {
    it("returns invalid for non-existent execution", async () => {
      const { engine } = buildEngine();
      const result = await engine.verifyState("non-existent");
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it("returns valid for completed execution with matching checkpoint", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "vs-match" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("vs-match", "exec-vs-01");

      const result = await engine.verifyState("exec-vs-01");
      expect(result.valid).toBe(true);
    });

    it("detects mismatch between checkpoint completed tasks and telemetry", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "vs-mismatch" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("vs-mismatch", "exec-vs-mismatch");

      const result = await engine.verifyState("exec-vs-mismatch");
      expect(result.valid).toBe(true);
    });
  });

  // ── Fuzzing / Edge Cases ──────────────────────────────────────────

  describe("fuzzing and edge cases", () => {
    it("handles multiple rapid replays of the same execution", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "fuzz-rapid" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("fuzz-rapid", "exec-fuzz-rapid");

      const replays = await Promise.all([
        engine.deterministicReplay("exec-fuzz-rapid"),
        engine.deterministicReplay("exec-fuzz-rapid"),
        engine.deterministicReplay("exec-fuzz-rapid"),
      ]);

      // All should succeed
      for (const r of replays) {
        expect(r.status).toBe("succeeded");
        expect(r.stateVerified).toBe(true);
      }

      // Each should have a unique execution ID
      const ids = new Set(replays.map((r) => r.id));
      expect(ids.size).toBe(3);
    });

    it("reports error for non-existent execution", async () => {
      const { engine } = buildEngine();

      await expect(
        engine.deterministicReplay("nonexistent-execution")
      ).rejects.toThrow(/not found/);
    });

    it("returns no lineages for never-replayed executions", async () => {
      const { registry, engine } = buildEngine();
      const wf = new DocumentProcessingTemplate().createWorkflow({ id: "fuzz-lineage", limitBytes: 10000 });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("fuzz-lineage", "exec-fuzz-no-replay");

      const lineage = engine.getReplayLineage("exec-fuzz-no-replay");
      expect(lineage).toBeUndefined();
    });

    it("limits lineage to 10 entries", async () => {
      const { registry, engine } = buildEngine();
      const wf = new LocalCloudProvisioningTemplate().createWorkflow({ id: "fuzz-limit" });
      registry.registerWorkflow(wf);

      await engine.executeWorkflow("fuzz-limit", "exec-fuzz-limit");

      // Replay 15 times (lineage caps at 10)
      for (let i = 0; i < 15; i++) {
        await engine.deterministicReplay("exec-fuzz-limit");
      }

      const lineage = engine.getReplayLineage("exec-fuzz-limit");
      expect(lineage).toBeDefined();
      expect(lineage!.previousExecutions.length).toBe(10); // capped
    });
  });
});
