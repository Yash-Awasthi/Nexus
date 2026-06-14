// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PidFile,
  InMemoryFileIO,
  HealthChecker,
  ProcessRegistry,
  ShutdownCascade,
} from "../src/index.js";

// ── PidFile ────────────────────────────────────────────────────────────────────

describe("PidFile", () => {
  let io: InMemoryFileIO;
  let pf: PidFile;

  beforeEach(() => {
    io = new InMemoryFileIO();
    pf = new PidFile("/run/worker.pid", io);
  });

  it("write + read round-trips", () => {
    pf.write(1234, "worker");
    const r = pf.read();
    expect(r?.pid).toBe(1234);
    expect(r?.name).toBe("worker");
    expect(r?.startedAt).toBeTruthy();
  });

  it("exists() reflects presence", () => {
    expect(pf.exists()).toBe(false);
    pf.write(1, "w");
    expect(pf.exists()).toBe(true);
  });

  it("clear() removes pid file", () => {
    pf.write(1, "w");
    expect(pf.clear()).toBe(true);
    expect(pf.exists()).toBe(false);
  });

  it("clear() returns false when file absent", () => {
    expect(pf.clear()).toBe(false);
  });

  it("read() returns null when file absent", () => {
    expect(pf.read()).toBeNull();
  });

  it("read() returns null for corrupt content", () => {
    io.write("/run/worker.pid", "not json {{");
    expect(pf.read()).toBeNull();
  });

  it("isStale() is false when within TTL", () => {
    pf.write(1, "w");
    expect(pf.isStale()).toBe(false);
  });

  it("isStale() is false when file absent", () => {
    expect(pf.isStale()).toBe(false);
  });

  it("isStale() is true when startedAt is ancient", () => {
    const ancient = new Date(Date.now() - 999_999).toISOString();
    io.write("/run/worker.pid", JSON.stringify({ pid: 1, name: "w", startedAt: ancient }));
    const pf2 = new PidFile("/run/worker.pid", io, { staleTtlMs: 1000 });
    expect(pf2.isStale()).toBe(true);
  });
});

describe("InMemoryFileIO", () => {
  it("write/read/exists/remove lifecycle", () => {
    const io = new InMemoryFileIO();
    io.write("/tmp/f", "data");
    expect(io.exists("/tmp/f")).toBe(true);
    expect(io.read("/tmp/f")).toBe("data");
    expect(io.remove("/tmp/f")).toBe(true);
    expect(io.exists("/tmp/f")).toBe(false);
    expect(io.read("/tmp/f")).toBeNull();
  });

  it("remove returns false for unknown path", () => {
    expect(new InMemoryFileIO().remove("/ghost")).toBe(false);
  });
});

// ── HealthChecker ──────────────────────────────────────────────────────────────

describe("HealthChecker", () => {
  it("returns healthy when probe returns true", async () => {
    const hc = new HealthChecker(async () => true);
    const r = await hc.check();
    expect(r.status).toBe("healthy");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.checkedAt).toBeTruthy();
  });

  it("returns unhealthy when probe returns false", async () => {
    const hc = new HealthChecker(async () => false, { retries: 0 });
    const r = await hc.check();
    expect(r.status).toBe("unhealthy");
  });

  it("returns unhealthy when probe throws", async () => {
    const hc = new HealthChecker(async () => { throw new Error("connection refused"); }, { retries: 0 });
    const r = await hc.check();
    expect(r.status).toBe("unhealthy");
    expect(r.error).toContain("connection refused");
  });

  it("retries on failure", async () => {
    let calls = 0;
    const hc = new HealthChecker(async () => {
      if (++calls < 2) throw new Error("not ready");
      return true;
    }, { retries: 2, retryDelayMs: 0 });
    const r = await hc.check();
    expect(r.status).toBe("healthy");
    expect(calls).toBe(2);
  });

  it("returns timeout status on slow probe", async () => {
    const hc = new HealthChecker(
      () => new Promise<boolean>((r) => setTimeout(() => r(true), 200)),
      { timeoutMs: 10 },
    );
    const r = await hc.check();
    expect(r.status).toBe("timeout");
  });
});

// ── ProcessRegistry ────────────────────────────────────────────────────────────

describe("ProcessRegistry", () => {
  let reg: ProcessRegistry;
  beforeEach(() => { reg = new ProcessRegistry(); });

  it("register creates entry in 'starting' state", () => {
    const e = reg.register("worker");
    expect(e.name).toBe("worker");
    expect(e.state).toBe("starting");
    expect(e.crashCount).toBe(0);
  });

  it("markRunning transitions to 'running' with pid", () => {
    reg.register("w");
    reg.markRunning("w", 4242);
    const e = reg.get("w")!;
    expect(e.state).toBe("running");
    expect(e.pid).toBe(4242);
    expect(e.startedAt).toBeTruthy();
  });

  it("markStopping transitions to 'stopping'", () => {
    reg.register("w");
    reg.markStopping("w");
    expect(reg.get("w")!.state).toBe("stopping");
  });

  it("markStopped clears pid and sets stoppedAt", () => {
    reg.register("w");
    reg.markRunning("w", 10);
    reg.markStopped("w");
    const e = reg.get("w")!;
    expect(e.state).toBe("stopped");
    expect(e.pid).toBeUndefined();
    expect(e.stoppedAt).toBeTruthy();
  });

  it("markCrashed increments crashCount", () => {
    reg.register("w");
    reg.markCrashed("w");
    reg.register("w"); // re-register resets entry
    reg.markCrashed("w");
    // each re-register creates new entry with crashCount=0 then increments
    expect(reg.get("w")!.crashCount).toBe(1);
  });

  it("list() returns all entries", () => {
    reg.register("a");
    reg.register("b");
    expect(reg.list()).toHaveLength(2);
  });

  it("list(state) filters by state", () => {
    reg.register("a");
    reg.register("b");
    reg.markRunning("b");
    expect(reg.list("running")).toHaveLength(1);
    expect(reg.list("starting")).toHaveLength(1);
  });

  it("deregister removes entry", () => {
    reg.register("w");
    expect(reg.deregister("w")).toBe(true);
    expect(reg.get("w")).toBeUndefined();
  });

  it("deregister returns false for unknown name", () => {
    expect(reg.deregister("ghost")).toBe(false);
  });

  it("count() returns correct count", () => {
    reg.register("a");
    reg.register("b");
    expect(reg.count()).toBe(2);
  });

  it("throws on state change for unregistered process", () => {
    expect(() => reg.markRunning("ghost")).toThrow();
  });

  it("stores metadata", () => {
    const e = reg.register("w", { port: 3000, version: "1.0" });
    expect(e.metadata["port"]).toBe(3000);
  });
});

// ── ShutdownCascade ────────────────────────────────────────────────────────────

describe("ShutdownCascade", () => {
  let cascade: ShutdownCascade;
  beforeEach(() => { cascade = new ShutdownCascade(); });

  it("runs steps in order", async () => {
    const order: number[] = [];
    cascade
      .addStep({ name: "a", handler: () => { order.push(1); } })
      .addStep({ name: "b", handler: () => { order.push(2); } });
    await cascade.run();
    expect(order).toEqual([1, 2]);
  });

  it("returns results per step", async () => {
    cascade.addStep({ name: "close-db", handler: async () => {} });
    const results = await cascade.run();
    expect(results[0]!.name).toBe("close-db");
    expect(results[0]!.success).toBe(true);
  });

  it("marks failed step and continues", async () => {
    cascade
      .addStep({ name: "fail", handler: () => { throw new Error("boom"); } })
      .addStep({ name: "ok", handler: () => {} });
    const results = await cascade.run();
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toContain("boom");
    expect(results[1]!.success).toBe(true);
  });

  it("marks timed-out step", async () => {
    cascade.addStep({
      name: "slow",
      handler: () => new Promise<void>((r) => setTimeout(r, 200)),
      timeoutMs: 10,
    });
    const results = await cascade.run();
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toContain("timed out");
  });

  it("isShuttingDown becomes true after run()", async () => {
    expect(cascade.isShuttingDown).toBe(false);
    cascade.addStep({ name: "noop", handler: () => {} });
    await cascade.run();
    expect(cascade.isShuttingDown).toBe(true);
  });

  it("second run() returns empty (idempotent)", async () => {
    cascade.addStep({ name: "x", handler: () => {} });
    await cascade.run();
    const r2 = await cascade.run();
    expect(r2).toHaveLength(0);
  });

  it("reset() allows re-running", async () => {
    cascade.addStep({ name: "x", handler: () => {} });
    await cascade.run();
    cascade.reset();
    cascade.addStep({ name: "y", handler: () => {} });
    const r2 = await cascade.run();
    expect(r2).toHaveLength(1);
    expect(r2[0]!.name).toBe("y");
  });

  it("supports method chaining on addStep", () => {
    expect(cascade.addStep({ name: "x", handler: () => {} })).toBe(cascade);
  });

  it("async handlers are awaited", async () => {
    let done = false;
    cascade.addStep({ name: "async", handler: async () => { await new Promise((r) => setTimeout(r, 5)); done = true; } });
    await cascade.run();
    expect(done).toBe(true);
  });
});
