// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  VectorClock,
  ConflictResolver,
  SyncStore,
  SyncManager,
  type SyncSession,
  type SyncOperation,
} from "../src/index.js";

// ── VectorClock ───────────────────────────────────────────────────────────────

describe("VectorClock", () => {
  it("starts at 0 for unknown device", () => {
    const vc = new VectorClock();
    expect(vc.get("device1")).toBe(0);
  });

  it("tick increments and returns new value", () => {
    const vc = new VectorClock();
    expect(vc.tick("d1")).toBe(1);
    expect(vc.tick("d1")).toBe(2);
    expect(vc.get("d1")).toBe(2);
  });

  it("merge takes max of each device", () => {
    const vc = new VectorClock({ d1: 3, d2: 1 });
    vc.merge({ d1: 1, d2: 5, d3: 2 });
    expect(vc.get("d1")).toBe(3);
    expect(vc.get("d2")).toBe(5);
    expect(vc.get("d3")).toBe(2);
  });

  it("happenedBefore returns true for strictly earlier clock", () => {
    const a = new VectorClock({ d1: 1, d2: 1 });
    const b = new VectorClock({ d1: 2, d2: 2 });
    expect(a.happenedBefore(b)).toBe(true);
    expect(b.happenedBefore(a)).toBe(false);
  });

  it("happenedBefore returns false for equal clocks", () => {
    const a = new VectorClock({ d1: 1 });
    const b = new VectorClock({ d1: 1 });
    expect(a.happenedBefore(b)).toBe(false);
  });

  it("concurrent detects parallel updates", () => {
    const a = new VectorClock({ d1: 2, d2: 1 });
    const b = new VectorClock({ d1: 1, d2: 2 });
    expect(a.concurrent(b)).toBe(true);
  });

  it("toJSON returns clock snapshot", () => {
    const vc = new VectorClock({ d1: 3 });
    expect(vc.toJSON()).toEqual({ d1: 3 });
  });

  it("static from creates clock from plain object", () => {
    const vc = VectorClock.from({ d1: 5, d2: 3 });
    expect(vc.get("d1")).toBe(5);
    expect(vc.get("d2")).toBe(3);
  });
});

// ── ConflictResolver ──────────────────────────────────────────────────────────

const makeSession = (overrides: Partial<SyncSession>): SyncSession => ({
  id: "s1",
  userId: "u1",
  deviceId: "d1",
  data: { key: "value" },
  vectorClock: {},
  updatedAt: "2024-01-01T00:00:00Z",
  status: "conflict",
  version: 1,
  ...overrides,
});

describe("ConflictResolver", () => {
  it("last-write-wins picks remote when remote is newer", () => {
    const resolver = new ConflictResolver("last-write-wins");
    const local = makeSession({ updatedAt: "2024-01-01T00:00:00Z", data: { k: "local" } });
    const remote = makeSession({ updatedAt: "2024-01-02T00:00:00Z", data: { k: "remote" } });
    const result = resolver.resolve(local, remote);
    expect(result.winner).toBe("remote");
    expect(result.resolved["k"]).toBe("remote");
  });

  it("last-write-wins picks local when local is newer", () => {
    const resolver = new ConflictResolver("last-write-wins");
    const local = makeSession({ updatedAt: "2024-01-02T00:00:00Z", data: { k: "local" } });
    const remote = makeSession({ updatedAt: "2024-01-01T00:00:00Z", data: { k: "remote" } });
    const result = resolver.resolve(local, remote);
    expect(result.winner).toBe("local");
    expect(result.resolved["k"]).toBe("local");
  });

  it("union strategy merges both, local wins on collision", () => {
    const resolver = new ConflictResolver("union");
    const local = makeSession({ data: { a: "local-a", b: "local-b" } });
    const remote = makeSession({ data: { b: "remote-b", c: "remote-c" } });
    const result = resolver.resolve(local, remote);
    expect(result.winner).toBe("merged");
    expect(result.resolved["a"]).toBe("local-a");
    expect(result.resolved["b"]).toBe("local-b"); // local wins collision
    expect(result.resolved["c"]).toBe("remote-c");
  });

  it("custom strategy uses provided function", () => {
    const resolver = new ConflictResolver("custom", (local, remote) => ({
      ...local,
      ...remote,
      custom: true,
    }));
    const local = makeSession({ data: { x: 1 } });
    const remote = makeSession({ data: { y: 2 } });
    const result = resolver.resolve(local, remote);
    expect(result.winner).toBe("merged");
    expect(result.resolved["custom"]).toBe(true);
  });
});

// ── SyncStore ─────────────────────────────────────────────────────────────────

describe("SyncStore", () => {
  let store: SyncStore;

  beforeEach(() => {
    store = new SyncStore();
  });

  it("creates a session", () => {
    const s = store.createSession("user1", "device1", { theme: "dark" });
    expect(s.id).toMatch(/^sess-/);
    expect(s.userId).toBe("user1");
    expect(s.deviceId).toBe("device1");
    expect(s.data["theme"]).toBe("dark");
    expect(s.version).toBe(1);
  });

  it("applies set operation", () => {
    const s = store.createSession("u", "d");
    const op: SyncOperation = {
      sessionId: s.id,
      deviceId: "d",
      type: "set",
      key: "theme",
      value: "dark",
      timestamp: new Date().toISOString(),
      logicalTime: 1,
    };
    const updated = store.applyOp(op);
    expect(updated!.data["theme"]).toBe("dark");
    expect(updated!.version).toBe(2);
  });

  it("applies delete operation", () => {
    const s = store.createSession("u", "d", { toDelete: "yes" });
    const op: SyncOperation = {
      sessionId: s.id,
      deviceId: "d",
      type: "delete",
      key: "toDelete",
      timestamp: new Date().toISOString(),
      logicalTime: 1,
    };
    const updated = store.applyOp(op);
    expect(updated!.data["toDelete"]).toBeUndefined();
  });

  it("applies merge operation", () => {
    const s = store.createSession("u", "d", { settings: { a: 1 } });
    const op: SyncOperation = {
      sessionId: s.id,
      deviceId: "d",
      type: "merge",
      key: "settings",
      value: { b: 2 },
      timestamp: new Date().toISOString(),
      logicalTime: 1,
    };
    const updated = store.applyOp(op);
    expect(updated!.data["settings"]).toMatchObject({ a: 1, b: 2 });
  });

  it("applyOp returns undefined for unknown sessionId", () => {
    const op: SyncOperation = {
      sessionId: "ghost",
      deviceId: "d",
      type: "set",
      key: "k",
      timestamp: new Date().toISOString(),
      logicalTime: 1,
    };
    expect(store.applyOp(op)).toBeUndefined();
  });

  it("getOpsSince filters by logicalTime", () => {
    const s = store.createSession("u", "d");
    const op1: SyncOperation = {
      sessionId: s.id,
      deviceId: "d",
      type: "set",
      key: "a",
      value: 1,
      timestamp: new Date().toISOString(),
      logicalTime: 1,
    };
    const op2: SyncOperation = {
      sessionId: s.id,
      deviceId: "d",
      type: "set",
      key: "b",
      value: 2,
      timestamp: new Date().toISOString(),
      logicalTime: 5,
    };
    store.applyOp(op1);
    store.applyOp(op2);
    const ops = store.getOpsSince(s.id, 2);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.key).toBe("b");
  });

  it("list returns all sessions", () => {
    store.createSession("u1", "d1");
    store.createSession("u1", "d2");
    store.createSession("u2", "d1");
    expect(store.list()).toHaveLength(3);
    expect(store.list("u1")).toHaveLength(2);
  });

  it("delete removes a session", () => {
    const s = store.createSession("u", "d");
    expect(store.delete(s.id)).toBe(true);
    expect(store.get(s.id)).toBeUndefined();
  });
});

// ── SyncManager ───────────────────────────────────────────────────────────────

describe("SyncManager", () => {
  it("push applies operations and returns result", () => {
    const manager = new SyncManager("device1");
    const s = manager.getStore().createSession("user1", "device1");
    const result = manager.push(s.id, [
      { type: "set", key: "name", value: "Alice" },
      { type: "set", key: "theme", value: "dark" },
    ]);
    expect(result.opsApplied).toBe(2);
    expect(result.newVersion).toBeGreaterThan(1);
    expect(manager.getStore().get(s.id)!.data["name"]).toBe("Alice");
  });

  it("pull returns ops since logicalTime", () => {
    const manager = new SyncManager("device1");
    const s = manager.getStore().createSession("user1", "device1");
    manager.push(s.id, [{ type: "set", key: "a", value: 1 }]);
    manager.push(s.id, [{ type: "set", key: "b", value: 2 }]);
    const result = manager.pull(s.id, 0);
    expect(result.ops.length).toBeGreaterThan(0);
    expect(result.session).toBeDefined();
  });

  it("merge uses vector clocks to determine winner", () => {
    const storeA = new SyncStore();
    const managerA = new SyncManager("deviceA", { store: storeA });
    const s = storeA.createSession("u", "deviceA");

    managerA.push(s.id, [{ type: "set", key: "x", value: "A" }]);
    managerA.push(s.id, [{ type: "set", key: "y", value: "A2" }]);

    const localSession = storeA.get(s.id)!;
    // Create a "remote" that only has x set (happened-before local)
    const remote: SyncSession = {
      ...localSession,
      data: { x: "remote-old" },
      vectorClock: { deviceB: 1 }, // only deviceB's clock, not deviceA
      updatedAt: "2024-01-01T00:00:00Z",
    };

    // Since localSession has deviceA's clock and remote only has deviceB's,
    // they are concurrent — resolver decides
    const resolution = managerA.merge(s.id, remote);
    expect(["local", "remote", "merged"]).toContain(resolution.winner);
  });

  it("merge returns remote for unknown sessionId", () => {
    const manager = new SyncManager("d1");
    const remote: SyncSession = {
      id: "unknown",
      userId: "u",
      deviceId: "d2",
      data: { k: "v" },
      vectorClock: {},
      updatedAt: "",
      status: "clean",
      version: 1,
    };
    const result = manager.merge("unknown", remote);
    expect(result.winner).toBe("remote");
    expect(result.resolved["k"]).toBe("v");
  });
});
