import * as fs from "fs";
import * as path from "path";
import { createRuntimeContext, startRuntime, stopRuntime } from "../runtime/runtime-context";
import { runFederationE2e } from "../runtime/e2e-federation";
import { probeFlociHealth, resolveFlociEndpoint } from "../orchestration/floci-client";

const runLive = process.env.GHOSTSTACK_FLOCI_INTEGRATION === "1";

(runLive ? describe : describe.skip)("Federation E2E workflow (live Floci)", () => {
  const repoRoot = path.resolve(__dirname, "..");

  beforeAll(async () => {
    const h = await probeFlociHealth(resolveFlociEndpoint(), 8000);
    if (!h.reachable) {
      throw new Error(`Floci required for E2E: ${h.error}`);
    }
  });

  it("runs S3 → Lambda create → invoke pipeline", async () => {
    process.env.GHOSTSTACK_DATA_DIR = path.join(__dirname, "../temp-e2e-federation-db");
    const ctx = await createRuntimeContext(repoRoot);
    await startRuntime(ctx);
    try {
      const result = await runFederationE2e(ctx, { strict: true, cleanup: true });
      expect(result.status).toBe("succeeded");
      expect(result.workflowId).toMatch(/^federation-e2e-/);
    } finally {
      await stopRuntime(ctx);
    }
  }, 180000);
});

describe("Federation E2E workflow (offline mock)", () => {
  it("registers dynamic workflow and completes with mocks", async () => {
    const dataDir = path.join(__dirname, "../temp-e2e-mock-db");
    // Fresh data dir to avoid stale event log accumulation
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }
    process.env.GHOSTSTACK_DATA_DIR = dataDir;
    process.env.GHOSTSTACK_OFFLINE_MODE = "true";
    process.env.GHOSTSTACK_FLOCI_STRICT = "0";
    process.env.GHOSTSTACK_FLOCI_MOCK_FALLBACK = "true";

    const repoRoot = path.resolve(__dirname, "..");
    console.log("[e2e-mock] Creating runtime context...");
    const t0 = Date.now();
    const ctx = await createRuntimeContext(repoRoot);
    console.log(`[e2e-mock] Context created in ${Date.now() - t0}ms`);

    console.log(`[e2e-mock] Starting runtime (offline=${process.env.GHOSTSTACK_OFFLINE_MODE})...`);
    const t1 = Date.now();
    await startRuntime(ctx);
    console.log(`[e2e-mock] Runtime started in ${Date.now() - t1}ms`);

    try {
      console.log("[e2e-mock] Running federation E2E...");
      const t2 = Date.now();
      const result = await runFederationE2e(ctx, { strict: false, cleanup: false });
      console.log(`[e2e-mock] E2E completed in ${Date.now() - t2}ms with status=${result.status}`);
      expect(result.status).toBe("succeeded");
    } catch (err) {
      console.error("[e2e-mock] E2E workflow failed:", (err as Error).message);
      console.error("[e2e-mock] Stack:", (err as Error).stack);
      throw err;
    } finally {
      console.log("[e2e-mock] Stopping runtime...");
      const t3 = Date.now();
      await stopRuntime(ctx);
      console.log(`[e2e-mock] Runtime stopped in ${Date.now() - t3}ms`);
    }
  }, 60000);
});
