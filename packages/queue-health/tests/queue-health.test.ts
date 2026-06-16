// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryQueueLane,
  LaneRegistry,
  AlertPolicy,
  HealthMonitor,
  HealthAggregator,
  DEFAULT_THRESHOLDS,
} from "../src/index.js";

// ── InMemoryQueueLane ─────────────────────────────────────────────────────────

describe("InMemoryQueueLane", () => {
  it("returns default zero metrics", async () => {
    const lane = new InMemoryQueueLane("emails");
    const m = await lane.getMetrics();
    expect(m.waiting).toBe(0);
    expect(m.failed).toBe(0);
    expect(m.paused).toBe(false);
    expect(m.unavailable).toBe(false);
  });

  it("reflects set state", async () => {
    const lane = new InMemoryQueueLane("emails", { waiting: 50, failed: 5, active: 3 });
    const m = await lane.getMetrics();
    expect(m.waiting).toBe(50);
    expect(m.failed).toBe(5);
    expect(m.active).toBe(3);
  });

  it("setState updates metrics", async () => {
    const lane = new InMemoryQueueLane("emails");
    lane.setState({ waiting: 100 });
    expect((await lane.getMetrics()).waiting).toBe(100);
  });

  it("throwOnGet simulates unavailability", async () => {
    const lane = new InMemoryQueueLane("broken", { throwOnGet: true });
    await expect(lane.getMetrics()).rejects.toThrow("Queue unavailable");
  });
});

// ── LaneRegistry ─────────────────────────────────────────────────────────────

describe("LaneRegistry", () => {
  let reg: LaneRegistry;

  beforeEach(() => {
    reg = new LaneRegistry();
  });

  it("registers and retrieves a lane", () => {
    const lane = new InMemoryQueueLane("emails");
    reg.register(lane);
    expect(reg.get("emails")).toBe(lane);
  });

  it("unregister removes lane", () => {
    const lane = new InMemoryQueueLane("emails");
    reg.register(lane);
    expect(reg.unregister("emails")).toBe(true);
    expect(reg.get("emails")).toBeUndefined();
    expect(reg.unregister("emails")).toBe(false);
  });

  it("list returns all lanes", () => {
    reg.register(new InMemoryQueueLane("a"));
    reg.register(new InMemoryQueueLane("b"));
    expect(reg.list()).toHaveLength(2);
  });

  it("names returns lane names", () => {
    reg.register(new InMemoryQueueLane("a"));
    reg.register(new InMemoryQueueLane("b"));
    expect(reg.names()).toContain("a");
    expect(reg.names()).toContain("b");
  });

  it("register supports chaining", () => {
    expect(reg.register(new InMemoryQueueLane("x"))).toBe(reg);
  });

  it("count returns correct count", () => {
    reg.register(new InMemoryQueueLane("a"));
    reg.register(new InMemoryQueueLane("b"));
    expect(reg.count()).toBe(2);
  });
});

// ── AlertPolicy ───────────────────────────────────────────────────────────────

describe("AlertPolicy", () => {
  const policy = new AlertPolicy({ maxWaiting: 100, maxFailed: 10, maxStalled: 5 });

  const baseMetrics = (overrides = {}) => ({
    name: "test",
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    stalled: 0,
    paused: false,
    unavailable: false,
    snapshotAt: "",
    ...overrides,
  });

  it("no alerts for healthy queue", () => {
    expect(policy.evaluate(baseMetrics())).toHaveLength(0);
  });

  it("alerts when waiting exceeds threshold", () => {
    const alerts = policy.evaluate(baseMetrics({ waiting: 200 }));
    expect(alerts.some((a) => a.includes("waiting"))).toBe(true);
  });

  it("alerts when failed exceeds threshold", () => {
    const alerts = policy.evaluate(baseMetrics({ failed: 50 }));
    expect(alerts.some((a) => a.includes("failed"))).toBe(true);
  });

  it("alerts when stalled exceeds threshold", () => {
    const alerts = policy.evaluate(baseMetrics({ stalled: 20 }));
    expect(alerts.some((a) => a.includes("stalled"))).toBe(true);
  });

  it("alerts when paused", () => {
    const alerts = policy.evaluate(baseMetrics({ paused: true }));
    expect(alerts.some((a) => a.includes("paused"))).toBe(true);
  });

  it("returns single unavailable alert when unavailable", () => {
    const alerts = policy.evaluate(baseMetrics({ unavailable: true, failed: 9999 }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("unavailable");
  });

  it("deriveStatus returns healthy when no alerts", () => {
    expect(policy.deriveStatus(baseMetrics(), [])).toBe("healthy");
  });

  it("deriveStatus returns degraded when alerts present", () => {
    expect(policy.deriveStatus(baseMetrics(), ["some alert"])).toBe("degraded");
  });

  it("deriveStatus returns unavailable when metrics.unavailable=true", () => {
    expect(policy.deriveStatus(baseMetrics({ unavailable: true }), [])).toBe("unavailable");
  });

  it("DEFAULT_THRESHOLDS are reasonable", () => {
    expect(DEFAULT_THRESHOLDS.maxWaiting).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.maxFailed).toBeGreaterThan(0);
  });
});

// ── HealthMonitor ─────────────────────────────────────────────────────────────

describe("HealthMonitor", () => {
  it("checkLane returns healthy for normal lane", async () => {
    const reg = new LaneRegistry().register(new InMemoryQueueLane("emails"));
    const monitor = new HealthMonitor(reg);
    const health = await monitor.checkLane(reg.get("emails")!);
    expect(health.name).toBe("emails");
    expect(health.status).toBe("healthy");
    expect(health.alerts).toHaveLength(0);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("checkLane returns unavailable when lane throws", async () => {
    const reg = new LaneRegistry().register(new InMemoryQueueLane("broken", { throwOnGet: true }));
    const monitor = new HealthMonitor(reg);
    const health = await monitor.checkLane(reg.get("broken")!);
    expect(health.status).toBe("unavailable");
    expect(health.metrics.unavailable).toBe(true);
    expect(health.alerts.some((a) => a.includes("unavailable"))).toBe(true);
  });

  it("checkLane returns degraded when thresholds exceeded", async () => {
    const reg = new LaneRegistry().register(new InMemoryQueueLane("heavy", { failed: 1000 }));
    const monitor = new HealthMonitor(reg, { policy: new AlertPolicy({ maxFailed: 10 }) });
    const health = await monitor.checkLane(reg.get("heavy")!);
    expect(health.status).toBe("degraded");
    expect(health.alerts.length).toBeGreaterThan(0);
  });

  it("checkAll returns health for all lanes", async () => {
    const reg = new LaneRegistry()
      .register(new InMemoryQueueLane("a"))
      .register(new InMemoryQueueLane("b"))
      .register(new InMemoryQueueLane("c"));
    const monitor = new HealthMonitor(reg);
    const healths = await monitor.checkAll();
    expect(healths).toHaveLength(3);
  });

  it("checkByName returns undefined for unknown lane", async () => {
    const monitor = new HealthMonitor(new LaneRegistry());
    expect(await monitor.checkByName("ghost")).toBeUndefined();
  });

  it("checkByName returns health for known lane", async () => {
    const reg = new LaneRegistry().register(new InMemoryQueueLane("x"));
    const monitor = new HealthMonitor(reg);
    const health = await monitor.checkByName("x");
    expect(health?.name).toBe("x");
  });
});

// ── HealthAggregator ──────────────────────────────────────────────────────────

describe("HealthAggregator", () => {
  const agg = new HealthAggregator();

  const makeHealth = (name: string, overrides = {}): import("../src/index.js").LaneHealth => ({
    name,
    status: "healthy",
    metrics: {
      name,
      waiting: 0,
      active: 0,
      completed: 100,
      failed: 0,
      delayed: 0,
      stalled: 0,
      paused: false,
      unavailable: false,
      snapshotAt: "",
    },
    alerts: [],
    latencyMs: 5,
    ...overrides,
  });

  it("aggregates healthy lanes", () => {
    const result = agg.aggregate([makeHealth("a"), makeHealth("b")]);
    expect(result.laneCount).toBe(2);
    expect(result.healthyCount).toBe(2);
    expect(result.overallStatus).toBe("healthy");
    expect(result.totalCompleted).toBe(200);
  });

  it("overallStatus is degraded when any lane is degraded", () => {
    const result = agg.aggregate([
      makeHealth("a"),
      makeHealth("b", { status: "degraded", alerts: ["alert"] }),
    ]);
    expect(result.overallStatus).toBe("degraded");
    expect(result.degradedCount).toBe(1);
  });

  it("overallStatus is unavailable when any lane is unavailable", () => {
    const result = agg.aggregate([
      makeHealth("a"),
      makeHealth("b", { status: "unavailable", alerts: ["unavailable"] }),
    ]);
    expect(result.overallStatus).toBe("unavailable");
  });

  it("aggregates total waiting and failed", () => {
    const result = agg.aggregate([
      makeHealth("a", {
        metrics: {
          name: "a",
          waiting: 50,
          failed: 5,
          active: 2,
          completed: 0,
          delayed: 0,
          stalled: 0,
          paused: false,
          unavailable: false,
          snapshotAt: "",
        },
      }),
      makeHealth("b", {
        metrics: {
          name: "b",
          waiting: 30,
          failed: 3,
          active: 1,
          completed: 0,
          delayed: 0,
          stalled: 0,
          paused: false,
          unavailable: false,
          snapshotAt: "",
        },
      }),
    ]);
    expect(result.totalWaiting).toBe(80);
    expect(result.totalFailed).toBe(8);
  });

  it("collects all alerts", () => {
    const result = agg.aggregate([
      makeHealth("a", { alerts: ["alert1"] }),
      makeHealth("b", { alerts: ["alert2", "alert3"] }),
    ]);
    expect(result.allAlerts).toHaveLength(3);
  });

  it("hotspots returns top K lanes by failures", () => {
    const result = agg.aggregate([
      makeHealth("a", {
        metrics: {
          name: "a",
          failed: 100,
          waiting: 0,
          active: 0,
          completed: 0,
          delayed: 0,
          stalled: 0,
          paused: false,
          unavailable: false,
          snapshotAt: "",
        },
      }),
      makeHealth("b", {
        metrics: {
          name: "b",
          failed: 50,
          waiting: 0,
          active: 0,
          completed: 0,
          delayed: 0,
          stalled: 0,
          paused: false,
          unavailable: false,
          snapshotAt: "",
        },
      }),
      makeHealth("c", {
        metrics: {
          name: "c",
          failed: 10,
          waiting: 0,
          active: 0,
          completed: 0,
          delayed: 0,
          stalled: 0,
          paused: false,
          unavailable: false,
          snapshotAt: "",
        },
      }),
      makeHealth("d", {
        metrics: {
          name: "d",
          failed: 0,
          waiting: 0,
          active: 0,
          completed: 0,
          delayed: 0,
          stalled: 0,
          paused: false,
          unavailable: false,
          snapshotAt: "",
        },
      }),
    ]);
    const spots = agg.hotspots(result, 2);
    expect(spots).toHaveLength(2);
    expect(spots[0]!.name).toBe("a");
    expect(spots[1]!.name).toBe("b");
  });

  it("empty lanes produces zero aggregate", () => {
    const result = agg.aggregate([]);
    expect(result.laneCount).toBe(0);
    expect(result.overallStatus).toBe("healthy");
  });
});
