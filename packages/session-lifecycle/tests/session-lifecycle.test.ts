// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  SessionStore,
  LifecycleEventBus,
  IdempotencyGuard,
  SessionCompletionHandler,
  GeneratorExitHandler,
  createLifecycle,
  type LifecycleEvent,
  type CleanupTask,
} from "../src/index.js";

// ── SessionStore ──────────────────────────────────────────────────────────────

describe("SessionStore", () => {
  it("create returns a session record", () => {
    const store = new SessionStore();
    const s = store.create({ userId: "u1" });
    expect(s.id).toMatch(/^session-/);
    expect(s.status).toBe("pending");
    expect(s.metadata.userId).toBe("u1");
  });

  it("get retrieves by id", () => {
    const store = new SessionStore();
    const s = store.create();
    expect(store.get(s.id)).toBe(s);
  });

  it("has returns correct boolean", () => {
    const store = new SessionStore();
    const s = store.create();
    expect(store.has(s.id)).toBe(true);
    expect(store.has("nonexistent")).toBe(false);
  });

  it("update patches fields", () => {
    const store = new SessionStore();
    const s = store.create();
    const updated = store.update(s.id, { status: "running" });
    expect(updated.status).toBe("running");
  });

  it("update throws for unknown id", () => {
    const store = new SessionStore();
    expect(() => store.update("bad", { status: "running" })).toThrow("Session not found");
  });

  it("delete removes session", () => {
    const store = new SessionStore();
    const s = store.create();
    expect(store.delete(s.id)).toBe(true);
    expect(store.has(s.id)).toBe(false);
  });

  it("list returns all sessions", () => {
    const store = new SessionStore();
    store.create();
    store.create();
    expect(store.list()).toHaveLength(2);
  });

  it("byStatus filters correctly", () => {
    const store = new SessionStore();
    const s1 = store.create();
    store.update(s1.id, { status: "running" });
    store.create(); // pending
    const running = store.byStatus("running");
    expect(running).toHaveLength(1);
    expect(running[0]!.id).toBe(s1.id);
  });

  it("clear removes all", () => {
    const store = new SessionStore();
    store.create();
    store.clear();
    expect(store.count()).toBe(0);
  });
});

// ── LifecycleEventBus ─────────────────────────────────────────────────────────

describe("LifecycleEventBus", () => {
  it("on emits specific event type", () => {
    const bus = new LifecycleEventBus();
    const received: LifecycleEvent[] = [];
    bus.on("session_completed", (e) => received.push(e));
    bus.emit({ type: "session_completed", sessionId: "s1", timestamp: new Date().toISOString() });
    expect(received).toHaveLength(1);
    expect(received[0]!.sessionId).toBe("s1");
  });

  it("wildcard receives all events", () => {
    const bus = new LifecycleEventBus();
    const received: LifecycleEvent[] = [];
    bus.on("*", (e) => received.push(e));
    bus.emit({ type: "session_started", sessionId: "s1", timestamp: "" });
    bus.emit({ type: "session_completed", sessionId: "s2", timestamp: "" });
    expect(received).toHaveLength(2);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new LifecycleEventBus();
    const received: LifecycleEvent[] = [];
    const unsub = bus.on("session_failed", (e) => received.push(e));
    unsub();
    bus.emit({ type: "session_failed", sessionId: "s1", timestamp: "" });
    expect(received).toHaveLength(0);
  });

  it("listener error does not propagate", () => {
    const bus = new LifecycleEventBus();
    bus.on("*", () => { throw new Error("boom"); });
    expect(() => bus.emit({ type: "session_started", sessionId: "x", timestamp: "" })).not.toThrow();
  });

  it("clear removes all listeners", () => {
    const bus = new LifecycleEventBus();
    const received: LifecycleEvent[] = [];
    bus.on("*", (e) => received.push(e));
    bus.clear();
    bus.emit({ type: "session_started", sessionId: "s1", timestamp: "" });
    expect(received).toHaveLength(0);
  });
});

// ── IdempotencyGuard ──────────────────────────────────────────────────────────

describe("IdempotencyGuard", () => {
  it("first tryComplete returns true", () => {
    const guard = new IdempotencyGuard();
    expect(guard.tryComplete("s1")).toBe(true);
  });

  it("second tryComplete returns false", () => {
    const guard = new IdempotencyGuard();
    guard.tryComplete("s1");
    expect(guard.tryComplete("s1")).toBe(false);
  });

  it("isCompleted reflects state", () => {
    const guard = new IdempotencyGuard();
    expect(guard.isCompleted("s1")).toBe(false);
    guard.tryComplete("s1");
    expect(guard.isCompleted("s1")).toBe(true);
  });

  it("reset allows re-completion", () => {
    const guard = new IdempotencyGuard();
    guard.tryComplete("s1");
    guard.reset("s1");
    expect(guard.tryComplete("s1")).toBe(true);
  });

  it("clear resets all", () => {
    const guard = new IdempotencyGuard();
    guard.tryComplete("s1");
    guard.tryComplete("s2");
    guard.clear();
    expect(guard.size()).toBe(0);
  });
});

// ── SessionCompletionHandler ──────────────────────────────────────────────────

describe("SessionCompletionHandler", () => {
  it("complete marks session as completed", () => {
    const { store, bus, completionHandler } = createLifecycle();
    const s = store.create();
    store.update(s.id, { status: "running" });
    const result = completionHandler.complete(s.id);
    expect(result.wasAlreadyCompleted).toBe(false);
    expect(result.record.status).toBe("completed");
    expect(result.record.completedAt).toBeDefined();
  });

  it("second complete returns wasAlreadyCompleted=true", () => {
    const { store, completionHandler } = createLifecycle();
    const s = store.create();
    completionHandler.complete(s.id);
    const result = completionHandler.complete(s.id);
    expect(result.wasAlreadyCompleted).toBe(true);
  });

  it("marks status=failed when error provided", () => {
    const { store, completionHandler } = createLifecycle();
    const s = store.create();
    const result = completionHandler.complete(s.id, { error: "something went wrong" });
    expect(result.record.status).toBe("failed");
    expect(result.record.error).toBe("something went wrong");
  });

  it("emits lifecycle event on completion", () => {
    const { store, bus, completionHandler } = createLifecycle();
    const s = store.create();
    const events: LifecycleEvent[] = [];
    bus.on("session_completed", (e) => events.push(e));
    completionHandler.complete(s.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe(s.id);
  });

  it("emits failed event when error provided", () => {
    const { store, bus, completionHandler } = createLifecycle();
    const s = store.create();
    const events: LifecycleEvent[] = [];
    bus.on("session_failed", (e) => events.push(e));
    completionHandler.complete(s.id, { error: "err" });
    expect(events).toHaveLength(1);
  });

  it("merges finalMetadata into record", () => {
    const { store, completionHandler } = createLifecycle();
    const s = store.create({ existing: true });
    const result = completionHandler.complete(s.id, { finalMetadata: { tokens: 500 } });
    expect(result.record.metadata.tokens).toBe(500);
    expect(result.record.metadata.existing).toBe(true);
  });

  it("getGuard returns the guard", () => {
    const { completionHandler } = createLifecycle();
    expect(completionHandler.getGuard()).toBeDefined();
  });
});

// ── GeneratorExitHandler ──────────────────────────────────────────────────────

describe("GeneratorExitHandler", () => {
  it("runs all cleanup tasks", async () => {
    const { bus, exitHandler } = createLifecycle();
    const log: string[] = [];
    const tasks: CleanupTask[] = [
      { name: "close-db", fn: async () => { log.push("db"); } },
      { name: "flush-cache", fn: () => { log.push("cache"); } },
    ];
    const result = await exitHandler.cleanup("s1", tasks);
    expect(log).toContain("db");
    expect(log).toContain("cache");
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.every((t) => t.success)).toBe(true);
  });

  it("captures task errors without throwing", async () => {
    const { bus, exitHandler } = createLifecycle();
    const tasks: CleanupTask[] = [
      { name: "bad-task", fn: async () => { throw new Error("cleanup failed"); } },
    ];
    const result = await exitHandler.cleanup("s1", tasks);
    expect(result.tasks[0]!.success).toBe(false);
    expect(result.tasks[0]!.error).toContain("cleanup failed");
  });

  it("emits cleanup_started and cleanup_finished", async () => {
    const { bus, exitHandler } = createLifecycle();
    const types: string[] = [];
    bus.on("*", (e) => types.push(e.type));
    await exitHandler.cleanup("s1", []);
    expect(types).toContain("cleanup_started");
    expect(types).toContain("cleanup_finished");
  });

  it("handles timeout gracefully", async () => {
    const bus = new LifecycleEventBus();
    const exitHandler = new GeneratorExitHandler(bus, 10); // 10ms timeout
    const tasks: CleanupTask[] = [
      { name: "slow-task", fn: () => new Promise((r) => setTimeout(r, 200)) },
    ];
    const result = await exitHandler.cleanup("s1", tasks);
    expect(result.tasks[0]!.success).toBe(false);
    expect(result.tasks[0]!.error).toContain("Timeout");
  });
});

// ── createLifecycle ───────────────────────────────────────────────────────────

describe("createLifecycle", () => {
  it("returns all components", () => {
    const lifecycle = createLifecycle();
    expect(lifecycle.store).toBeDefined();
    expect(lifecycle.bus).toBeDefined();
    expect(lifecycle.guard).toBeDefined();
    expect(lifecycle.completionHandler).toBeDefined();
    expect(lifecycle.exitHandler).toBeDefined();
  });

  it("components are wired together", () => {
    const { store, completionHandler } = createLifecycle();
    const s = store.create();
    const result = completionHandler.complete(s.id);
    expect(result.record.status).toBe("completed");
  });
});
