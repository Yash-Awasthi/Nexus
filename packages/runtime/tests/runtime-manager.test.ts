// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import type { IConfigLoader } from "../src/config-loader.js";
import { RuntimeManager } from "../src/runtime-manager.js";

function loader(services?: Record<string, unknown>): IConfigLoader {
  return {
    loadServices: vi.fn().mockResolvedValue({ services: services ?? {} }),
    loadPorts: vi.fn().mockResolvedValue({}),
  } as unknown as IConfigLoader;
}

describe("RuntimeManager", () => {
  it("unions config-declared and registered service names", async () => {
    const manager = new RuntimeManager(loader({ api: {}, worker: {} }));
    manager.registerService("custom");
    const names = await manager.getActiveServices();
    expect(names.sort()).toEqual(["api", "custom", "worker"]);
  });

  it("falls back to registered names when the config loader fails", async () => {
    const failing = loader();
    (failing.loadServices as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no config"));
    const manager = new RuntimeManager(failing);
    manager.registerService("only-me");
    expect(await manager.getActiveServices()).toEqual(["only-me"]);
  });

  it("registers, updates in place, and unregisters services", async () => {
    const manager = new RuntimeManager(loader());
    manager.registerService("svc", "stopped", "initial");
    manager.registerService("svc", "running", "changed");
    const record = manager.getServiceRecord("svc")!;
    expect(record.status).toBe("running");
    expect(record.detail).toBe("changed");
    expect(record.restartCount).toBe(0);
    manager.unregisterService("svc");
    expect(manager.getServiceRecord("svc")).toBeUndefined();
  });

  it("marks lifecycle states on demand", () => {
    const manager = new RuntimeManager(loader());
    manager.markRunning("a");
    manager.markStopped("a", "by operator");
    manager.markDegraded("b");
    manager.markError("c", "kaboom");
    manager.markRunning("c");

    expect(manager.getServiceRecord("a")).toMatchObject({ status: "stopped", detail: "by operator" });
    expect(manager.getServiceRecord("a")?.stoppedAt).toBeInstanceOf(Date);
    const c = manager.getServiceRecord("c")!;
    expect(c.status).toBe("running");
    expect(c.lastError).toBeUndefined();
    expect(c.startedAt).toBeInstanceOf(Date);
  });

  it("startService flips to running and increments the restart count", async () => {
    const manager = new RuntimeManager(loader());
    await manager.startService("svc", async () => {});
    expect(manager.getServiceRecord("svc")).toMatchObject({ status: "running", restartCount: 1 });
    await manager.startService("svc", async () => {});
    expect(manager.getServiceRecord("svc")?.restartCount).toBe(2);
  });

  it("startService records errors and rethrows", async () => {
    const manager = new RuntimeManager(loader());
    await expect(
      manager.startService("svc", async () => {
        throw new Error("boot failure");
      }),
    ).rejects.toThrow("boot failure");
    expect(manager.getServiceRecord("svc")).toMatchObject({
      status: "error",
      lastError: "boot failure",
    });
  });

  it("stopService flips to stopped and handles failures", async () => {
    const manager = new RuntimeManager(loader());
    await manager.stopService("svc", async () => {});
    expect(manager.getServiceRecord("svc")?.status).toBe("stopped");
    await expect(
      manager.stopService("svc", async () => {
        throw new Error("drain failed");
      }),
    ).rejects.toThrow("drain failed");
    expect(manager.getServiceRecord("svc")).toMatchObject({ status: "error", lastError: "drain failed" });
  });

  it("restartService stops then starts", async () => {
    const manager = new RuntimeManager(loader());
    const stopFn = vi.fn(async () => {});
    const startFn = vi.fn(async () => {});
    await manager.restartService("svc", stopFn, startFn);
    expect(stopFn).toHaveBeenCalledOnce();
    expect(startFn).toHaveBeenCalledOnce();
    expect(manager.getServiceRecord("svc")).toMatchObject({ status: "running", restartCount: 1 });
  });

  it("summarizes health across all records", async () => {
    const manager = new RuntimeManager(loader());
    manager.markRunning("api");
    manager.markRunning("worker");
    manager.markStopped("cli");
    const healthy = manager.getHealthSummary();
    expect(healthy.overall).toBe("healthy");
    expect(healthy.runningCount).toBe(2);
    expect(healthy.stoppedCount).toBe(1);
    expect(healthy.uptimeMs).toBeGreaterThanOrEqual(0);

    manager.markDegraded("cache");
    expect(manager.getHealthSummary().overall).toBe("degraded");
    manager.markError("cache", "e");
    expect(manager.getHealthSummary().overall).toBe("unhealthy");
    expect(manager.getHealthSummary().errorCount).toBe(1);
    expect(manager.getAllRecords()).toHaveLength(4);
  });
});
