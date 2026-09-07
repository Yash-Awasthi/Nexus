// SPDX-License-Identifier: Apache-2.0
import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  probeFlociHealth: vi.fn(),
  resolveFlociEndpoint: vi.fn(() => "http://localhost:4566"),
}));

vi.mock("../src/floci-client.js", () => ({
  probeFlociHealth: mocks.probeFlociHealth,
  resolveFlociEndpoint: mocks.resolveFlociEndpoint,
}));

import { FederationHealthController } from "../src/federation-health-controller.js";
import type { FederationSupervisor } from "../src/federation-supervisor.js";

const DATA_DIR = "data-runtime";

let root: string;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function makeController(opts: Parameters<typeof FederationHealthController.prototype.constructor>[2] = {}) {
  const supervisor = {} as FederationSupervisor;
  const controller = new FederationHealthController(supervisor, root, {
    degradedAfterMs: 1000,
    degradedToRestartingMs: 2000,
    restartingToOfflineMs: 3000,
    dataDir: DATA_DIR,
    autoCleanupOnStart: false,
    enableBackgroundReconciliation: false,
    ...opts,
  });
  return controller;
}

function stateFile(): string {
  return path.join(root, DATA_DIR, "federation-supervisor-state.json");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fh-"));
  fs.mkdirSync(path.join(root, DATA_DIR), { recursive: true });
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("FederationHealthController lifecycle", () => {
  it("starts and stops the reconciliation loop", async () => {
    const controller = makeController({ enableBackgroundReconciliation: true });
    mocks.probeFlociHealth.mockResolvedValue({ reachable: false, error: "down" });
    const cleanup = await controller.start();
    expect(controller.isRunning).toBe(true);
    expect(cleanup).toBeNull(); // autoCleanupOnStart false
    vi.advanceTimersByTime(30_000);
    await vi.runAllTicks();
    controller.stop();
    expect(controller.isRunning).toBe(false);
  });

  it("runs auto-cleanup on start when enabled", async () => {
    const stale = path.join(root, DATA_DIR, "old.json");
    fs.writeFileSync(stale, "{}");
    const old = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(stale, old, old);
    const controller = makeController({
      autoCleanupOnStart: true,
      staleStateMaxAgeMs: 60_000,
    });
    mocks.probeFlociHealth.mockResolvedValue({ reachable: true, latencyMs: 1 });
    const report = await controller.start();
    expect(report?.staleStateFilesRemoved).toContain(stale);
    controller.stop();
  });
});

describe("escalation", () => {
  it("starts healthy and stays healthy while the service responds", async () => {
    const controller = makeController();
    const level = await controller.checkAndEscalate("svc", { status: "healthy" });
    expect(level).toBe("healthy");
    // a record exists but never transitioned away from healthy
    expect(controller.getEscalationRecord("svc")).toMatchObject({ currentLevel: "healthy", transitions: 0 });
  });

  it("creates a record on first check and degrades within the window", async () => {
    const controller = makeController();
    const level = await controller.checkAndEscalate("svc", { status: "unreachable" });
    expect(level).toBe("degraded");
    expect(controller.getEscalationRecord("svc")).toMatchObject({
      serviceName: "svc",
      currentLevel: "degraded",
      transitions: 1,
    });
  });

  it("escalates degraded → restarting → offline as time passes", async () => {
    const controller = makeController();
    await controller.checkAndEscalate("svc", { status: "unreachable" });
    expect(controller.getEscalationRecord("svc")!.currentLevel).toBe("degraded");

    vi.advanceTimersByTime(1200);
    await controller.checkAndEscalate("svc", { status: "unreachable" });
    expect(controller.getEscalationRecord("svc")!.currentLevel).toBe("restarting");

    vi.advanceTimersByTime(3500);
    await controller.checkAndEscalate("svc", { status: "unreachable" });
    expect(controller.getEscalationRecord("svc")!.currentLevel).toBe("offline");

    // offline is terminal without a health return
    vi.advanceTimersByTime(5000);
    await controller.checkAndEscalate("svc", { status: "unreachable" });
    expect(controller.getEscalationRecord("svc")!.currentLevel).toBe("offline");
    expect(controller.getEscalationRecord("svc")!.transitions).toBe(3);
    expect(controller.getAllEscalationRecords()).toHaveLength(1);
  });

  it("resets to healthy when the service returns and records reset removes state", async () => {
    const controller = makeController();
    await controller.checkAndEscalate("svc", { status: "unreachable" });
    expect(controller.getEscalationRecord("svc")!.currentLevel).toBe("degraded");
    const level = await controller.checkAndEscalate("svc", { status: "healthy" });
    expect(level).toBe("healthy");
    expect(controller.getEscalationRecord("svc")!.currentLevel).toBe("healthy");
    expect(controller.getEscalationRecord("svc")!.history.at(-1)).toMatchObject({ from: "degraded", to: "healthy" });
    controller.resetService("svc");
    expect(controller.getEscalationRecord("svc")).toBeUndefined();
    expect(controller.getAllEscalationRecords()).toEqual([]);
  });

  it("returns healthy level when no prior record exists and health is good", async () => {
    const controller = makeController();
    await expect(controller.checkAndEscalate("fresh", { status: "healthy" })).resolves.toBe("healthy");
  });
});

describe("reconciliation", () => {
  it("flags a docker_missing issue when Floci is down but the supervisor started it", async () => {
    fs.writeFileSync(stateFile(), JSON.stringify({ weStartedFlociDocker: true, apiPid: 1 }));
    mocks.probeFlociHealth.mockResolvedValue({ reachable: false, error: "connection refused" });
    const controller = makeController();
    const report = await controller.reconcile();
    expect(report.servicesReconciled).toBe(2);
    expect(report.issues.some((i) => i.type === "docker_missing" && i.severity === "critical")).toBe(true);
  });

  it("skips the docker_missing issue when Floci is reachable", async () => {
    mocks.probeFlociHealth.mockResolvedValue({ reachable: true, latencyMs: 5 });
    const controller = makeController();
    const report = await controller.reconcile();
    expect(report.issues.some((i) => i.type === "docker_missing")).toBe(false);
    expect(report.timestamp).toBeTruthy();
  });

  it("reads apiPort from conductor.config.json when present", async () => {
    fs.writeFileSync(
      path.join(root, "conductor.config.json"),
      JSON.stringify({ apiPort: 40123, mcpPort: 40124 }),
      "utf8",
    );
    mocks.probeFlociHealth.mockResolvedValue({ reachable: true, latencyMs: 5 });
    const controller = makeController();
    const report = await controller.reconcile();
    expect(report.servicesReconciled).toBe(2);
  });

  it("ignores a malformed supervisor state file", async () => {
    fs.writeFileSync(stateFile(), "{not json");
    mocks.probeFlociHealth.mockResolvedValue({ reachable: false, error: "x" });
    const controller = makeController();
    const report = await controller.reconcile();
    expect(report.issues.some((i) => i.type === "docker_missing")).toBe(false);
  });
});

describe("orphan cleanup", () => {
  it("removes stale state files and skips files for still-running processes", async () => {
    const child = childProcess.spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
      stdio: "ignore",
    });
    try {
      const stalePlain = path.join(root, DATA_DIR, "stale.json");
      fs.writeFileSync(stalePlain, "{}");
      const old = new Date(Date.now() - 2 * 3600_000);
      fs.utimesSync(stalePlain, old, old);

      // live federation state pointing at a running child → file must be retained
      const live = stateFile();
      fs.writeFileSync(live, JSON.stringify({ apiPid: child.pid, mcpPid: null }));
      const oldLive = new Date(Date.now() - 2 * 3600_000);
      fs.utimesSync(live, oldLive, oldLive);

      const controller = makeController();
      const report = await controller.cleanupOrphans();
      expect(report.staleStateFilesRemoved).toContain(stalePlain);
      expect(report.staleStateFilesRemoved).not.toContain(live);
      expect(report.totalBytesFreed).toBeGreaterThan(0);
      // the orphan sweep terminates the still-running child
      expect(report.zombiePidsKilled).toContain(child.pid);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("kills zombie child processes referenced by state files", async () => {
    const child = childProcess.spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      setTimeout(() => resolve(null), 2000);
    });
    try {
      fs.writeFileSync(stateFile(), JSON.stringify({ apiPid: child.pid, mcpPid: null }));
      const controller = makeController();
      const report = await controller.cleanupOrphans();
      expect(report.zombiePidsKilled).toContain(child.pid);
      expect(await exited).not.toBeNull();
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("skips non-json entries and handles corrupt state files", async () => {
    fs.writeFileSync(path.join(root, DATA_DIR, "notes.txt"), "ignore me");
    fs.writeFileSync(stateFile(), "{corrupt");
    const controller = makeController();
    const report = await controller.cleanupOrphans();
    expect(report.staleStateFilesRemoved).toEqual([]);
    expect(report.zombiePidsKilled).toEqual([]);
  });
});
