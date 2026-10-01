// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createRuntimeContext, startRuntime, stopRuntime } from "../src/runtime-context.js";

let repoRoot: string;
let prevEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rtctx-"));
  fs.mkdirSync(path.join(repoRoot, "specs"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".env"), "", "utf8");
  for (const k of [
    "GHOSTSTACK_OFFLINE_MODE",
    "DATABASE_URL",
    "GROQ_API_KEY",
    "GHOSTSTACK_DATA_DIR",
    "TAVILY_API_KEY",
    "GHOSTSTACK_BACKUP_ON_START",
    "GHOSTSTACK_FLOCI_STRICT",
  ]) {
    prevEnv[k] = process.env[k];
  }
  process.env.GHOSTSTACK_OFFLINE_MODE = "true";
  delete process.env.DATABASE_URL;
  delete process.env.GROQ_API_KEY;
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("createRuntimeContext", () => {
  it("composes the full runtime from a bare repo root", async () => {
    const ctx = await createRuntimeContext(repoRoot);

    // ── Wiring integrity ─────────────────────────────────────────
    expect(ctx.repoRoot).toBe(repoRoot);
    expect(ctx.sandbox).toMatchObject({ root: repoRoot, specsDir: path.join(repoRoot, "specs") });
    expect(fs.existsSync(ctx.sandbox.dataDir)).toBe(true);
    expect(ctx.runtimeDbDir).toBe(ctx.sandbox.dataDir);

    expect(ctx.eventBus).toBeDefined();
    expect(ctx.eventStore.getEventLogPath()).toContain("events.jsonl");
    expect(ctx.persistence.getStateFilePath()).toContain("cache.json");
    expect(ctx.queue).toBeDefined();
    expect(ctx.discovery).toBeDefined();
    expect(ctx.healthMonitor).toBeDefined();
    expect(ctx.orchestrator).toBeDefined();
    expect(ctx.approval).toBeDefined();

    // Workflow layer
    expect(ctx.registry.listWorkflows()).toHaveLength(0);
    expect(ctx.registry.listTemplates().map((t) => t.templateId)).toEqual(
      expect.arrayContaining([
        "browser-research-template",
        "cloud-provisioning-template",
        "document-processing-template",
        "spec-execution-template",
        "governed-etl-template",
      ]),
    );
    expect(ctx.workflowEngine).toBeDefined();
    expect(ctx.workflowTelemetry).toBeDefined();

    // Memory + knowledge layer
    expect(ctx.memoryStore).toBeDefined();
    expect(ctx.agentBus).toBeDefined();
    expect(await ctx.agentBus.getCapabilities()).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: "runtime" })]),
    );
    expect(ctx.vectorMemory).toBeDefined();
    expect(ctx.traceIndexer).toBeDefined();
    expect(ctx.diagnosticEnricher).toBeDefined();

    // Governance
    expect(ctx.governanceEngine).toBeDefined();
    expect(ctx.planningEngine).toBeDefined();

    // Resilience
    expect(ctx.circuitBreaker).toBeDefined();
    expect(ctx.circuitBreakerWrapper).toBeDefined();
    expect(ctx.runtimeCompactor).toBeDefined();
    expect(ctx.leakDetector).toBeDefined();
    expect(ctx.quotaManager).toBeDefined();
    expect(ctx.inspector).toBeDefined();
    expect(ctx.runtimeGraph).toBeDefined();

    // Graph registered the base nodes
    expect(ctx.runtimeGraph.getNode("floci")).toBeDefined();
    expect(ctx.runtimeGraph.getNode("conductor-runtime")).toBeDefined();
    expect(ctx.runtimeGraph.getNode("mcp-bridge")).toBeDefined();

    // Floci auto-registration on completion events
    const evt = ctx.eventBus;
    await evt.publish("floci_action_completed", {
      action: "create_s3_bucket",
      status: "success",
      service: "s3",
      bucketName: "data-bucket",
    });
    expect(await ctx.runtimeGraph.getNode("s3:data-bucket")).toBeDefined();
    // delete_lambda branch
    await evt.publish("floci_action_completed", {
      action: "delete_lambda",
      status: "success",
      service: "lambda",
      functionName: "fn-1",
    });

    // cleanup function list is populated
    expect(ctx.cleanup.length).toBeGreaterThan(0);
    await stopRuntime(ctx);
    await new Promise((r) => setTimeout(r, 30));
  });

  it("supports start/stop lifecycle and backup-on-start", async () => {
    process.env.GHOSTSTACK_BACKUP_ON_START = "1";
    const ctx = await createRuntimeContext(repoRoot);
    const services = await startRuntime(ctx);
    expect(Array.isArray(services)).toBe(true);
    const backupDir = ctx.sandbox.backupsDir;
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.readdirSync(backupDir).length).toBeGreaterThan(0);
    await stopRuntime(ctx);
    await new Promise((r) => setTimeout(r, 30));
  });

  it("stopRuntime tolerates failing cleanup steps", async () => {
    const ctx = await createRuntimeContext(repoRoot);
    ctx.healthMonitor = {
      stopMonitoring: vi.fn().mockRejectedValue(new Error("stop failed")),
    } as never;
    ctx.runtimeCompactor = {
      compact: vi.fn().mockRejectedValue(new Error("compact failed")),
      stop: vi.fn(),
    } as never;
    const loggerWarn = vi.spyOn(ctx.logger, "warn").mockImplementation(() => {});
    await stopRuntime(ctx);
    expect(loggerWarn).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 30));
  });
});
