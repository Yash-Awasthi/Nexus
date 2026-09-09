// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HealthMonitor, LocalServiceDiscovery } from "../src/service-discovery.js";
import type { IConfigLoader } from "../src/config-loader.js";
import type { ILogger } from "../src/interfaces/logger.interface.js";

// ── LocalServiceDiscovery ─────────────────────────────────────────────────────

describe("LocalServiceDiscovery", () => {
  it("registers, lists, and fetches services with a default healthy status", async () => {
    const d = new LocalServiceDiscovery();
    await d.registerService("floci", 4566);
    await d.registerService("mcp", 8100, { type: "docker", status: "degraded" });

    const svc = await d.getService("floci");
    expect(svc).toMatchObject({ name: "floci", status: "healthy" });
    expect(svc?.details).toMatchObject({ port: 4566 });

    const degraded = await d.getService("mcp");
    expect(degraded?.status).toBe("degraded");

    expect((await d.listServices()).map((s) => s.name).sort()).toEqual(["floci", "mcp"]);
  });

  it("deregisters a service and reports undefined afterwards", async () => {
    const d = new LocalServiceDiscovery();
    await d.registerService("floci", 4566);
    await d.deregisterService("floci");
    expect(await d.getService("floci")).toBeUndefined();
    expect(await d.listServices()).toEqual([]);
  });
});

// ── HealthMonitor ─────────────────────────────────────────────────────────────

const logger: ILogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

interface LoaderConfig {
  services?: { services: Record<string, { type: string; port: number }> };
  healthchecks?: { healthchecks: Record<string, { path: string; interval: number }> };
  throwOnLoad?: boolean;
}

function fakeLoader(cfg: LoaderConfig): IConfigLoader {
  return {
    async loadServices() {
      if (cfg.throwOnLoad) throw new Error("loader down");
      return (cfg.services ?? { services: {} }) as never;
    },
    async loadHealthchecks() {
      return (cfg.healthchecks ?? { healthchecks: {} }) as never;
    },
    async loadPorts() {
      return { floci: 4566, fcc: 0, mcp: 8100, ollama: 11434 };
    },
    async loadRuntime() {
      return {} as never;
    },
  };
}

let originalFetch: typeof globalThis.fetch;
const ENV_KEYS = ["GHOSTSTACK_OFFLINE_MODE", "FLOCI_ENDPOINT"] as const;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

describe("HealthMonitor", () => {
  it("startMonitoring skips the initial poll in offline mode and can be stopped", async () => {
    setEnv("GHOSTSTACK_OFFLINE_MODE", "true");
    const discovery = new LocalServiceDiscovery();
    const monitor = new HealthMonitor(fakeLoader({}), discovery, logger);

    await monitor.startMonitoring(); // must not throw despite no fetch
    await monitor.stopMonitoring();
    expect(await discovery.listServices()).toEqual([]);
  });

  it("polls HTTP services and marks them healthy/degraded/offline from fetch", async () => {
    setEnv("GHOSTSTACK_OFFLINE_MODE", "false");
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: true } as Response;
      return { ok: false } as Response;
    }) as unknown as typeof fetch;

    const discovery = new LocalServiceDiscovery();
    const loader = fakeLoader({
      services: { services: { web: { type: "process", port: 8080 } } },
      healthchecks: { healthchecks: { web: { path: "/health", interval: 5 } } },
    });
    const monitor = new HealthMonitor(loader, discovery, logger);
    // Exercise pollChecks through startMonitoring's non-offline initial poll.
    await monitor.startMonitoring();
    await monitor.stopMonitoring();

    const svc = await discovery.getService("web");
    expect(svc?.status).toBe("healthy");
    expect(svc?.details).toMatchObject({ port: 8080, type: "process", healthPath: "/health" });
  });

  it("marks HTTP services offline when fetch throws", async () => {
    setEnv("GHOSTSTACK_OFFLINE_MODE", "false");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const discovery = new LocalServiceDiscovery();
    const loader = fakeLoader({
      services: { services: { web: { type: "process", port: 8080 } } },
      healthchecks: { healthchecks: { web: { path: "/health", interval: 5 } } },
    });
    const monitor = new HealthMonitor(loader, discovery, logger);
    await monitor.startMonitoring();
    await monitor.stopMonitoring();
    expect((await discovery.getService("web"))?.status).toBe("offline");
  });

  it("probes floci via floci-client and records offline when unreachable", async () => {
    setEnv("GHOSTSTACK_OFFLINE_MODE", "false");
    setEnv("FLOCI_ENDPOINT", "http://floci.test");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connect failed");
    }) as unknown as typeof fetch;

    const discovery = new LocalServiceDiscovery();
    const loader = fakeLoader({
      services: { services: { floci: { type: "docker", port: 4566 } } },
      healthchecks: { healthchecks: {} },
    });
    const monitor = new HealthMonitor(loader, discovery, logger);
    await monitor.startMonitoring();
    await monitor.stopMonitoring();

    const svc = await discovery.getService("floci");
    expect(svc?.status).toBe("offline");
    expect(globalThis.fetch).toHaveBeenCalledWith("http://floci.test/_localstack/health");
  });

  it("marks floci healthy when the probe fetch succeeds", async () => {
    setEnv("GHOSTSTACK_OFFLINE_MODE", "false");
    globalThis.fetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    const discovery = new LocalServiceDiscovery();
    const loader = fakeLoader({
      services: { services: { floci: { type: "docker", port: 4566 } } },
      healthchecks: { healthchecks: {} },
    });
    const monitor = new HealthMonitor(loader, discovery, logger);
    await monitor.startMonitoring();
    await monitor.stopMonitoring();
    expect((await discovery.getService("floci"))?.status).toBe("healthy");
  });

  it("checkService reflects the discovery status", async () => {
    const discovery = new LocalServiceDiscovery();
    await discovery.registerService("ok", 1);
    await discovery.registerService("down", 1, { status: "offline" });
    const monitor = new HealthMonitor(fakeLoader({}), discovery, logger);
    expect(await monitor.checkService("ok")).toBe(true);
    expect(await monitor.checkService("down")).toBe(false);
    expect(await monitor.checkService("missing")).toBe(false);
  });

  it("logs and swallows poll errors when the config loader throws", async () => {
    setEnv("GHOSTSTACK_OFFLINE_MODE", "false");
    const discovery = new LocalServiceDiscovery();
    const monitor = new HealthMonitor(fakeLoader({ throwOnLoad: true }), discovery, logger);
    await monitor.startMonitoring(); // must not reject
    await monitor.stopMonitoring();
    expect(logger.error).toHaveBeenCalledWith("Error in healthcheck polling", expect.any(Error));
  });
});
