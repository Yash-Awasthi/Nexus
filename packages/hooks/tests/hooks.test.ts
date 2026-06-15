// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  HookRegistry,
  HookError,
  MemoryHookStore,
  globalHooks,
  definePlugin,
  HOOK_EVENTS,
  type Plugin,
  type HookRegistration,
  type EmitResult,
  type HookStore,
  type StoredHandler,
  type HookHandler,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRegistry(): HookRegistry {
  return new HookRegistry();
}

const SESSION_INIT = { sessionId: "s1", startedAt: 1000 };
const TASK_BEFORE = { taskId: "t1", taskType: "doc.ingest", payload: {}, attempt: 1 };
const TASK_AFTER = { taskId: "t1", taskType: "doc.ingest", result: {}, durationMs: 42 };
const TASK_ERROR = {
  taskId: "t1",
  taskType: "doc.ingest",
  error: "failed",
  attempt: 1,
  willRetry: false,
};
const SESSION_END = { sessionId: "s1", endedAt: 2000, durationMs: 1000 };
const MEM_BEFORE = { text: "remember this", metadata: {} };
const MEM_AFTER = { id: "m1", text: "remember this", metadata: {}, createdAt: 1000 };
const AGENT_OBS = { agentId: "a1", event: "tool.call", data: {} };
const FILE_BEFORE = { path: "/file.ts", operation: "update" as const };
const FILE_AFTER = { path: "/file.ts", operation: "update" as const, success: true };

// ── HOOK_EVENTS constant ──────────────────────────────────────────────────────

describe("HOOK_EVENTS", () => {
  it("contains all 10 expected events", () => {
    expect(HOOK_EVENTS).toHaveLength(10);
  });

  it("includes session.init and session.end", () => {
    expect(HOOK_EVENTS).toContain("session.init");
    expect(HOOK_EVENTS).toContain("session.end");
  });

  it("includes all task hooks", () => {
    expect(HOOK_EVENTS).toContain("task.before");
    expect(HOOK_EVENTS).toContain("task.after");
    expect(HOOK_EVENTS).toContain("task.error");
  });

  it("includes memory hooks", () => {
    expect(HOOK_EVENTS).toContain("memory.before_write");
    expect(HOOK_EVENTS).toContain("memory.after_write");
  });

  it("includes agent.observe and file hooks", () => {
    expect(HOOK_EVENTS).toContain("agent.observe");
    expect(HOOK_EVENTS).toContain("file.before_edit");
    expect(HOOK_EVENTS).toContain("file.after_edit");
  });
});

// ── HookError ─────────────────────────────────────────────────────────────────

describe("HookError", () => {
  it("has name 'HookError'", () => {
    expect(new HookError("m", "C").name).toBe("HookError");
  });

  it("stores code", () => {
    expect(new HookError("m", "MY_CODE").code).toBe("MY_CODE");
  });

  it("is instanceof Error", () => {
    expect(new HookError("x", "Y")).toBeInstanceOf(Error);
  });

  it("stores optional context", () => {
    expect(new HookError("m", "C", { k: 1 }).context).toEqual({ k: 1 });
  });
});

// ── definePlugin ──────────────────────────────────────────────────────────────

describe("definePlugin", () => {
  it("returns the plugin unchanged", () => {
    const p: Plugin = { name: "p", version: "1.0.0", install: vi.fn() };
    expect(definePlugin(p)).toBe(p);
  });
});

// ── HookRegistry — on / off ───────────────────────────────────────────────────

describe("HookRegistry.on / off", () => {
  let reg: HookRegistry;
  beforeEach(() => {
    reg = makeRegistry();
  });

  it("on returns a HookRegistration with id, event, priority", () => {
    const h = reg.on("task.before", vi.fn());
    expect(h.id).toBeTruthy();
    expect(h.event).toBe("task.before");
    expect(h.priority).toBe(0);
  });

  it("on stores the label when provided", () => {
    const h = reg.on("task.before", vi.fn(), { label: "my-hook" });
    expect(h.label).toBe("my-hook");
  });

  it("on uses 0 as default priority", () => {
    expect(reg.on("session.init", vi.fn()).priority).toBe(0);
  });

  it("off removes the handler so it no longer fires", async () => {
    const fn = vi.fn();
    const h = reg.on("task.before", fn);
    reg.off(h);
    await reg.emit("task.before", TASK_BEFORE);
    expect(fn).not.toHaveBeenCalled();
  });

  it("off is a no-op for an already-removed registration", () => {
    const h = reg.on("task.before", vi.fn());
    reg.off(h);
    expect(() => reg.off(h)).not.toThrow();
  });

  it("off for unknown event is a no-op", () => {
    const fakeReg: HookRegistration = { id: "x", event: "task.before", priority: 0 };
    expect(() => reg.off(fakeReg)).not.toThrow();
  });

  it("handlerCount reflects registrations and removals", () => {
    const h1 = reg.on("task.before", vi.fn());
    const h2 = reg.on("task.before", vi.fn());
    expect(reg.handlerCount("task.before")).toBe(2);
    reg.off(h1);
    expect(reg.handlerCount("task.before")).toBe(1);
    reg.off(h2);
    expect(reg.handlerCount("task.before")).toBe(0);
  });
});

// ── HookRegistry — offAll ─────────────────────────────────────────────────────

describe("HookRegistry.offAll", () => {
  let reg: HookRegistry;
  beforeEach(() => {
    reg = makeRegistry();
  });

  it("offAll(event) clears all handlers for that event", async () => {
    const fn = vi.fn();
    reg.on("task.before", fn);
    reg.on("task.before", fn);
    reg.offAll("task.before");
    await reg.emit("task.before", TASK_BEFORE);
    expect(fn).not.toHaveBeenCalled();
  });

  it("offAll(event) does not affect other events", async () => {
    const taskFn = vi.fn();
    const sessionFn = vi.fn();
    reg.on("task.before", taskFn);
    reg.on("session.init", sessionFn);
    reg.offAll("task.before");
    await reg.emit("session.init", SESSION_INIT);
    expect(sessionFn).toHaveBeenCalledTimes(1);
  });

  it("offAll() with no argument clears all handlers across all events", async () => {
    const fn = vi.fn();
    reg.on("task.before", fn);
    reg.on("session.init", fn);
    reg.offAll();
    await reg.emit("task.before", TASK_BEFORE);
    await reg.emit("session.init", SESSION_INIT);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ── HookRegistry — emit basics ────────────────────────────────────────────────

describe("HookRegistry.emit — basics", () => {
  let reg: HookRegistry;
  beforeEach(() => {
    reg = makeRegistry();
  });

  it("calls registered handler with payload", async () => {
    const fn = vi.fn();
    reg.on("task.before", fn);
    await reg.emit("task.before", TASK_BEFORE);
    expect(fn).toHaveBeenCalledWith(TASK_BEFORE);
  });

  it("returns EmitResult with event field", async () => {
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.event).toBe("task.before");
  });

  it("returns handled=0 when no handlers registered", async () => {
    const result = await reg.emit("session.init", SESSION_INIT);
    expect(result.handled).toBe(0);
    expect(result.aborted).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it("returns handled=N for N handlers", async () => {
    reg.on("task.before", vi.fn());
    reg.on("task.before", vi.fn());
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.handled).toBe(2);
  });

  it("calls multiple handlers all with same payload", async () => {
    const a = vi.fn();
    const b = vi.fn();
    reg.on("session.init", a);
    reg.on("session.init", b);
    await reg.emit("session.init", SESSION_INIT);
    expect(a).toHaveBeenCalledWith(SESSION_INIT);
    expect(b).toHaveBeenCalledWith(SESSION_INIT);
  });

  it("handles all event types without error", async () => {
    for (const event of HOOK_EVENTS) {
      const result = await reg.emit(event as never, {} as never);
      expect(result.handled).toBe(0);
    }
  });

  it("EmitResult includes compensationsRan field", async () => {
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result).toHaveProperty("compensationsRan");
    expect(result.compensationsRan).toBe(0);
  });
});

// ── HookRegistry — priority ordering ─────────────────────────────────────────

describe("HookRegistry.emit — priority ordering", () => {
  let reg: HookRegistry;
  let order: number[];

  beforeEach(() => {
    reg = makeRegistry();
    order = [];
  });

  it("runs higher priority before lower priority", async () => {
    reg.on(
      "task.before",
      () => {
        order.push(1);
      },
      { priority: 10 },
    );
    reg.on(
      "task.before",
      () => {
        order.push(2);
      },
      { priority: 20 },
    );
    reg.on(
      "task.before",
      () => {
        order.push(3);
      },
      { priority: 5 },
    );
    await reg.emit("task.before", TASK_BEFORE);
    expect(order).toEqual([2, 1, 3]);
  });

  it("handlers with equal priority run in insertion order", async () => {
    reg.on(
      "task.before",
      () => {
        order.push(1);
      },
      { priority: 0 },
    );
    reg.on(
      "task.before",
      () => {
        order.push(2);
      },
      { priority: 0 },
    );
    reg.on(
      "task.before",
      () => {
        order.push(3);
      },
      { priority: 0 },
    );
    await reg.emit("task.before", TASK_BEFORE);
    expect(order).toEqual([1, 2, 3]);
  });
});

// ── HookRegistry — abort ──────────────────────────────────────────────────────

describe("HookRegistry.emit — abort", () => {
  let reg: HookRegistry;
  beforeEach(() => {
    reg = makeRegistry();
  });

  it("stops chain when handler returns { abort: true }", async () => {
    const second = vi.fn();
    reg.on("task.before", () => ({ abort: true }), { priority: 10 });
    reg.on("task.before", second, { priority: 5 });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.aborted).toBe(true);
    expect(second).not.toHaveBeenCalled();
  });

  it("result.handled counts the aborting handler", async () => {
    reg.on("task.before", () => ({ abort: true }));
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.handled).toBe(1);
  });

  it("aborted=false when no handler aborts", async () => {
    reg.on("task.before", vi.fn());
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.aborted).toBe(false);
  });
});

// ── HookRegistry — error handling ─────────────────────────────────────────────

describe("HookRegistry.emit — error handling", () => {
  let reg: HookRegistry;
  beforeEach(() => {
    reg = makeRegistry();
  });

  it("collects error from throwing handler without stopping chain", async () => {
    const second = vi.fn();
    reg.on(
      "task.before",
      () => {
        throw new Error("boom");
      },
      { priority: 10 },
    );
    reg.on("task.before", second, { priority: 5 });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("boom");
    expect(second).toHaveBeenCalled();
  });

  it("error entry includes handlerId", async () => {
    const h = reg.on("task.before", () => {
      throw new Error("x");
    });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors[0]?.handlerId).toBe(h.id);
  });

  it("error entry includes label when provided", async () => {
    reg.on(
      "task.before",
      () => {
        throw new Error("x");
      },
      { label: "my-label" },
    );
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors[0]?.label).toBe("my-label");
  });

  it("does not throw even when all handlers throw", async () => {
    reg.on("task.before", () => {
      throw new Error("1");
    });
    reg.on("task.before", () => {
      throw new Error("2");
    });
    await expect(reg.emit("task.before", TASK_BEFORE)).resolves.toBeDefined();
  });

  it("async throwing handler is collected", async () => {
    reg.on("task.before", async () => {
      throw new Error("async-err");
    });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors[0]?.error).toContain("async-err");
  });
});

// ── HookRegistry — specific event shapes ──────────────────────────────────────

describe("HookRegistry.emit — all event payload shapes", () => {
  let reg: HookRegistry;
  beforeEach(() => {
    reg = makeRegistry();
  });

  it("session.init payload is typed correctly", async () => {
    const fn = vi.fn();
    reg.on("session.init", fn);
    await reg.emit("session.init", SESSION_INIT);
    expect(fn).toHaveBeenCalledWith(SESSION_INIT);
  });

  it("session.end payload is passed through", async () => {
    const fn = vi.fn();
    reg.on("session.end", fn);
    await reg.emit("session.end", SESSION_END);
    expect(fn).toHaveBeenCalledWith(SESSION_END);
  });

  it("task.after payload is passed through", async () => {
    const fn = vi.fn();
    reg.on("task.after", fn);
    await reg.emit("task.after", TASK_AFTER);
    expect(fn).toHaveBeenCalledWith(TASK_AFTER);
  });

  it("task.error payload is passed through", async () => {
    const fn = vi.fn();
    reg.on("task.error", fn);
    await reg.emit("task.error", TASK_ERROR);
    expect(fn).toHaveBeenCalledWith(TASK_ERROR);
  });

  it("memory.before_write payload is passed through", async () => {
    const fn = vi.fn();
    reg.on("memory.before_write", fn);
    await reg.emit("memory.before_write", MEM_BEFORE);
    expect(fn).toHaveBeenCalledWith(MEM_BEFORE);
  });

  it("memory.after_write payload is passed through", async () => {
    const fn = vi.fn();
    reg.on("memory.after_write", fn);
    await reg.emit("memory.after_write", MEM_AFTER);
    expect(fn).toHaveBeenCalledWith(MEM_AFTER);
  });

  it("agent.observe payload is passed through", async () => {
    const fn = vi.fn();
    reg.on("agent.observe", fn);
    await reg.emit("agent.observe", AGENT_OBS);
    expect(fn).toHaveBeenCalledWith(AGENT_OBS);
  });

  it("file.before_edit payload is passed through", async () => {
    const fn = vi.fn();
    reg.on("file.before_edit", fn);
    await reg.emit("file.before_edit", FILE_BEFORE);
    expect(fn).toHaveBeenCalledWith(FILE_BEFORE);
  });

  it("file.after_edit payload is passed through", async () => {
    const fn = vi.fn();
    reg.on("file.after_edit", fn);
    await reg.emit("file.after_edit", FILE_AFTER);
    expect(fn).toHaveBeenCalledWith(FILE_AFTER);
  });
});

// ── HookRegistry — listHandlers / handlerCount ────────────────────────────────

describe("HookRegistry.listHandlers", () => {
  let reg: HookRegistry;
  beforeEach(() => {
    reg = makeRegistry();
  });

  it("returns [] when no handlers registered", () => {
    expect(reg.listHandlers("task.before")).toEqual([]);
  });

  it("returns registrations for a specific event", () => {
    reg.on("task.before", vi.fn());
    reg.on("task.before", vi.fn());
    reg.on("session.init", vi.fn());
    expect(reg.listHandlers("task.before")).toHaveLength(2);
  });

  it("returns all handlers when no event specified", () => {
    reg.on("task.before", vi.fn());
    reg.on("session.init", vi.fn());
    expect(reg.listHandlers()).toHaveLength(2);
  });
});

// ── Plugin system ─────────────────────────────────────────────────────────────

describe("HookRegistry.use / unuse", () => {
  let reg: HookRegistry;
  beforeEach(() => {
    reg = makeRegistry();
  });

  it("use calls plugin.install with the registry", () => {
    const install = vi.fn();
    reg.use({ name: "p", version: "1.0.0", install });
    expect(install).toHaveBeenCalledWith(reg);
  });

  it("use returns the registry for chaining", () => {
    const p: Plugin = { name: "p", version: "1.0.0", install: vi.fn() };
    expect(reg.use(p)).toBe(reg);
  });

  it("use throws DUPLICATE_PLUGIN for a plugin registered twice", () => {
    const p: Plugin = { name: "p", version: "1.0.0", install: vi.fn() };
    reg.use(p);
    let caught: unknown;
    try {
      reg.use(p);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HookError);
    expect((caught as HookError).code).toBe("DUPLICATE_PLUGIN");
  });

  it("listPlugins returns installed plugins", () => {
    reg.use({ name: "a", version: "1.0.0", install: vi.fn() });
    reg.use({ name: "b", version: "1.0.0", install: vi.fn() });
    expect(reg.listPlugins().map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("unuse removes the plugin from listPlugins", () => {
    reg.use({ name: "p", version: "1.0.0", install: vi.fn() });
    reg.unuse("p");
    expect(reg.listPlugins()).toHaveLength(0);
  });

  it("unuse calls plugin.uninstall when defined", () => {
    const uninstall = vi.fn();
    reg.use({ name: "p", version: "1.0.0", install: vi.fn(), uninstall });
    reg.unuse("p");
    expect(uninstall).toHaveBeenCalledWith(reg);
  });

  it("unuse does not call uninstall when not defined", () => {
    reg.use({ name: "p", version: "1.0.0", install: vi.fn() });
    expect(() => reg.unuse("p")).not.toThrow();
  });

  it("unuse is a no-op for unknown plugin name", () => {
    expect(reg.unuse("nonexistent")).toBe(reg);
  });

  it("plugin can register and deregister hooks via install/uninstall", async () => {
    const fn = vi.fn();
    let reg1: HookRegistration | undefined;

    const p = definePlugin({
      name: "audit",
      version: "0.1.0",
      install(r) {
        reg1 = r.on("task.before", fn);
      },
      uninstall(r) {
        if (reg1) r.off(reg1);
      },
    });

    reg.use(p);
    await reg.emit("task.before", TASK_BEFORE);
    expect(fn).toHaveBeenCalledTimes(1);

    reg.unuse("audit");
    await reg.emit("task.before", TASK_BEFORE);
    expect(fn).toHaveBeenCalledTimes(1); // not called again
  });

  it("two plugins can both register handlers and both fire", async () => {
    const calls: string[] = [];
    reg.use(
      definePlugin({
        name: "a",
        version: "1",
        install: (r) => {
          r.on("task.before", () => {
            calls.push("a");
          });
        },
      }),
    );
    reg.use(
      definePlugin({
        name: "b",
        version: "1",
        install: (r) => {
          r.on("task.before", () => {
            calls.push("b");
          });
        },
      }),
    );
    await reg.emit("task.before", TASK_BEFORE);
    expect(calls).toContain("a");
    expect(calls).toContain("b");
  });
});

// ── globalHooks ───────────────────────────────────────────────────────────────

describe("globalHooks", () => {
  it("is a HookRegistry instance", () => {
    expect(globalHooks).toBeInstanceOf(HookRegistry);
  });

  it("can register and emit a hook", async () => {
    const fn = vi.fn();
    const h = globalHooks.on("agent.observe", fn);
    await globalHooks.emit("agent.observe", AGENT_OBS);
    expect(fn).toHaveBeenCalled();
    globalHooks.off(h); // cleanup
  });
});

// ── MemoryHookStore ───────────────────────────────────────────────────────────

describe("MemoryHookStore", () => {
  let store: MemoryHookStore;

  const entry: StoredHandler = {
    id: "h1",
    event: "task.before",
    label: "my-logger",
    priority: 10,
    timeoutMs: 500,
    createdAt: 1000,
  };

  beforeEach(() => {
    store = new MemoryHookStore();
  });

  it("loadAll returns empty array initially", async () => {
    const all = await store.loadAll();
    expect(all).toEqual([]);
  });

  it("save stores an entry retrievable via loadAll", async () => {
    await store.save(entry);
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: "h1", label: "my-logger", event: "task.before" });
  });

  it("save stores a defensive copy", async () => {
    await store.save(entry);
    // Mutate original
    (entry as StoredHandler & { extra?: string }).extra = "mutated";
    const all = await store.loadAll();
    expect((all[0] as StoredHandler & { extra?: string }).extra).toBeUndefined();
    delete (entry as StoredHandler & { extra?: string }).extra;
  });

  it("save overwrites on same id", async () => {
    await store.save(entry);
    await store.save({ ...entry, label: "updated-label" });
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.label).toBe("updated-label");
  });

  it("delete removes entry", async () => {
    await store.save(entry);
    await store.delete("h1");
    const all = await store.loadAll();
    expect(all).toHaveLength(0);
  });

  it("delete is a no-op for non-existent id", async () => {
    await expect(store.delete("nonexistent")).resolves.toBeUndefined();
  });

  it("multiple entries stored independently", async () => {
    await store.save({ ...entry, id: "h1", label: "first" });
    await store.save({ ...entry, id: "h2", label: "second" });
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    const labels = all.map((e) => e.label).sort();
    expect(labels).toEqual(["first", "second"]);
  });

  it("delete removes only the targeted entry", async () => {
    await store.save({ ...entry, id: "h1", label: "first" });
    await store.save({ ...entry, id: "h2", label: "second" });
    await store.delete("h1");
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.label).toBe("second");
  });
});

// ── HookRegistry — constructor with store ─────────────────────────────────────

describe("HookRegistry — store option in constructor", () => {
  it("constructs without store (default no-op)", () => {
    const reg = new HookRegistry();
    expect(reg).toBeInstanceOf(HookRegistry);
  });

  it("constructs with a HookStore", () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });
    expect(reg).toBeInstanceOf(HookRegistry);
  });

  it("constructs with empty options object", () => {
    const reg = new HookRegistry({});
    expect(reg).toBeInstanceOf(HookRegistry);
  });
});

// ── HookRegistry — persist: true ─────────────────────────────────────────────

describe("HookRegistry — persist: true", () => {
  it("saves to store when persist: true and label provided", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });

    reg.on("task.before", vi.fn(), {
      label: "my-handler",
      persist: true,
      priority: 5,
      timeoutMs: 200,
    });

    // Give the fire-and-forget promise a tick to resolve
    await Promise.resolve();

    const stored = await store.loadAll();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.label).toBe("my-handler");
    expect(stored[0]?.event).toBe("task.before");
    expect(stored[0]?.priority).toBe(5);
    expect(stored[0]?.timeoutMs).toBe(200);
  });

  it("does NOT save when persist: true but no label", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });

    reg.on("task.before", vi.fn(), { persist: true }); // no label
    await Promise.resolve();

    const stored = await store.loadAll();
    expect(stored).toHaveLength(0);
  });

  it("does NOT save when persist: true but no store configured", async () => {
    const reg = new HookRegistry(); // no store
    // Should not throw
    expect(() => reg.on("task.before", vi.fn(), { label: "x", persist: true })).not.toThrow();
  });

  it("does NOT save when persist is omitted", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });

    reg.on("task.before", vi.fn(), { label: "no-persist" });
    await Promise.resolve();

    const stored = await store.loadAll();
    expect(stored).toHaveLength(0);
  });

  it("off() calls store.delete for persisted handler", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });

    const h = reg.on("task.before", vi.fn(), { label: "deletable", persist: true });
    await Promise.resolve();
    expect(await store.loadAll()).toHaveLength(1);

    reg.off(h);
    await Promise.resolve();
    expect(await store.loadAll()).toHaveLength(0);
  });

  it("off() without store does not throw", () => {
    const reg = new HookRegistry();
    const h = reg.on("task.before", vi.fn(), { label: "x" });
    expect(() => reg.off(h)).not.toThrow();
  });
});

// ── HookRegistry — rehydrate ──────────────────────────────────────────────────

describe("HookRegistry.rehydrate", () => {
  it("returns 0 when no store is configured", async () => {
    const reg = new HookRegistry();
    const count = await reg.rehydrate({ myHandler: vi.fn() });
    expect(count).toBe(0);
  });

  it("returns 0 when store is empty", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });
    const count = await reg.rehydrate({ myHandler: vi.fn() });
    expect(count).toBe(0);
  });

  it("re-registers stored handler by label", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });

    // Simulate a persisted registration from a previous process
    const storedEntry: StoredHandler = {
      id: "stored-id-1",
      event: "task.before",
      label: "my-logger",
      priority: 10,
      createdAt: Date.now(),
    };
    await store.save(storedEntry);

    const fn = vi.fn();
    const count = await reg.rehydrate({ "my-logger": fn });
    expect(count).toBe(1);
    expect(reg.handlerCount("task.before")).toBe(1);

    await reg.emit("task.before", TASK_BEFORE);
    expect(fn).toHaveBeenCalledWith(TASK_BEFORE);
  });

  it("skips entries whose label is not in namedHandlers", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });

    await store.save({
      id: "s1",
      event: "task.before",
      label: "unknown-handler",
      priority: 0,
      createdAt: Date.now(),
    });

    const count = await reg.rehydrate({ "my-handler": vi.fn() });
    expect(count).toBe(0);
    expect(reg.handlerCount("task.before")).toBe(0);
  });

  it("rehydrates multiple entries", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });

    await store.save({
      id: "s1",
      event: "task.before",
      label: "h1",
      priority: 0,
      createdAt: Date.now(),
    });
    await store.save({
      id: "s2",
      event: "session.init",
      label: "h2",
      priority: 5,
      createdAt: Date.now(),
    });

    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const count = await reg.rehydrate({ h1: fn1, h2: fn2 });
    expect(count).toBe(2);

    await reg.emit("task.before", TASK_BEFORE);
    await reg.emit("session.init", SESSION_INIT);
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("restores stored priority", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });

    await store.save({
      id: "s1",
      event: "task.before",
      label: "high-pri",
      priority: 99,
      createdAt: Date.now(),
    });

    const order: string[] = [];
    await reg.rehydrate({
      "high-pri": () => {
        order.push("rehydrated");
      },
    });
    reg.on(
      "task.before",
      () => {
        order.push("new");
      },
      { priority: 1 },
    );

    await reg.emit("task.before", TASK_BEFORE);
    expect(order).toEqual(["rehydrated", "new"]);
  });

  it("prevents duplicate rehydration for same id", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });

    await store.save({
      id: "s1",
      event: "task.before",
      label: "h1",
      priority: 0,
      createdAt: Date.now(),
    });

    const fn = vi.fn();
    const count1 = await reg.rehydrate({ h1: fn });
    const count2 = await reg.rehydrate({ h1: fn });

    expect(count1).toBe(1);
    expect(count2).toBe(0); // second call skips duplicate
    expect(reg.handlerCount("task.before")).toBe(1);
  });

  it("rehydrated handler fires normally on emit", async () => {
    const store = new MemoryHookStore();
    const reg = new HookRegistry({ store });

    await store.save({
      id: "s-fire",
      event: "agent.observe",
      label: "observer",
      priority: 0,
      createdAt: Date.now(),
    });

    const fn = vi.fn();
    await reg.rehydrate({ observer: fn });
    const result = await reg.emit("agent.observe", AGENT_OBS);
    expect(result.handled).toBe(1);
    expect(fn).toHaveBeenCalledWith(AGENT_OBS);
  });
});

// ── HookRegistry — timeoutMs ──────────────────────────────────────────────────

describe("HookRegistry — timeoutMs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fast handler (no timeout set) runs normally", async () => {
    const reg = new HookRegistry();
    const fn = vi.fn();
    reg.on("task.before", fn);
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(fn).toHaveBeenCalled();
    expect(result.errors).toHaveLength(0);
  });

  it("handler that completes before timeout succeeds", async () => {
    const reg = new HookRegistry();
    const fn = vi.fn().mockResolvedValue(undefined);
    reg.on("task.before", fn, { timeoutMs: 5000, label: "fast" });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors).toHaveLength(0);
    expect(result.handled).toBe(1);
  });

  it("slow handler exceeding timeoutMs records timeout error", async () => {
    vi.useFakeTimers();
    const reg = new HookRegistry();

    reg.on("task.before", () => new Promise<void>((resolve) => setTimeout(resolve, 10_000)), {
      label: "slow-op",
      timeoutMs: 50,
    });

    const emitPromise = reg.emit("task.before", TASK_BEFORE);
    await vi.advanceTimersByTimeAsync(100);
    const result = await emitPromise;

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("timed out");
    expect(result.errors[0]?.label).toBe("slow-op");
  });

  it("timeout error message includes handler label", async () => {
    vi.useFakeTimers();
    const reg = new HookRegistry();

    reg.on(
      "task.before",
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
      { label: "stuck-handler", timeoutMs: 10 },
    );

    const emitPromise = reg.emit("task.before", TASK_BEFORE);
    await vi.advanceTimersByTimeAsync(50);
    const result = await emitPromise;

    expect(result.errors[0]?.error).toContain("stuck-handler");
  });

  it("timed-out handler does not prevent remaining handlers from running", async () => {
    vi.useFakeTimers();
    const reg = new HookRegistry();
    const next = vi.fn();

    reg.on(
      "task.before",
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
      { timeoutMs: 10, priority: 10 },
    );
    reg.on("task.before", next, { priority: 5 });

    const emitPromise = reg.emit("task.before", TASK_BEFORE);
    await vi.advanceTimersByTimeAsync(50);
    const result = await emitPromise;

    expect(result.errors).toHaveLength(1);
    expect(next).toHaveBeenCalled();
    expect(result.handled).toBe(2);
  });
});

// ── HookRegistry — before/after ordering constraints ─────────────────────────

describe("HookRegistry — before/after ordering", () => {
  let reg: HookRegistry;
  let order: string[];

  beforeEach(() => {
    reg = makeRegistry();
    order = [];
  });

  it("handler with before: 'X' runs before handler labeled 'X'", async () => {
    reg.on(
      "task.before",
      () => {
        order.push("A");
      },
      { label: "A", before: "B" },
    );
    reg.on(
      "task.before",
      () => {
        order.push("B");
      },
      { label: "B" },
    );
    await reg.emit("task.before", TASK_BEFORE);
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
  });

  it("handler with after: 'X' runs after handler labeled 'X'", async () => {
    // Register C before B in insertion order, but C declares after: "B"
    reg.on(
      "task.before",
      () => {
        order.push("C");
      },
      { label: "C", after: "B" },
    );
    reg.on(
      "task.before",
      () => {
        order.push("B");
      },
      { label: "B" },
    );
    await reg.emit("task.before", TASK_BEFORE);
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("C"));
  });

  it("three handlers with chain ordering A → B → C", async () => {
    reg.on(
      "task.before",
      () => {
        order.push("C");
      },
      { label: "C", after: "B" },
    );
    reg.on(
      "task.before",
      () => {
        order.push("A");
      },
      { label: "A", before: "B" },
    );
    reg.on(
      "task.before",
      () => {
        order.push("B");
      },
      { label: "B" },
    );
    await reg.emit("task.before", TASK_BEFORE);
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("before/after constraints with unknown label are ignored", async () => {
    // "before: 'nonexistent'" should not throw or break ordering
    reg.on(
      "task.before",
      () => {
        order.push("A");
      },
      { label: "A", before: "nonexistent" },
    );
    reg.on(
      "task.before",
      () => {
        order.push("B");
      },
      { label: "B" },
    );
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors).toHaveLength(0);
    expect(order).toHaveLength(2);
  });

  it("before constraint can reorder handlers even when declaring handler has lower priority", async () => {
    // The topological sort is applied globally after priority sort.
    // A before: "X" constraint re-inserts the declaring handler before "X"
    // even if "X" had a higher priority value.
    reg.on(
      "task.before",
      () => {
        order.push("low");
      },
      { label: "low", priority: 1, before: "high" },
    );
    reg.on(
      "task.before",
      () => {
        order.push("high");
      },
      { label: "high", priority: 100 },
    );
    await reg.emit("task.before", TASK_BEFORE);
    // "low" declared before: "high", so topological sort places it first
    expect(order.indexOf("low")).toBeLessThan(order.indexOf("high"));
  });

  it("same-priority handlers: after constraint reorders within tier", async () => {
    // A, B, C all priority 0. B declares after: "C".
    // Insertion order: A(0), B(1, after:C), C(2)
    // After topological sort: A, C, B
    reg.on(
      "task.before",
      () => {
        order.push("A");
      },
      { label: "A" },
    );
    reg.on(
      "task.before",
      () => {
        order.push("B");
      },
      { label: "B", after: "C" },
    );
    reg.on(
      "task.before",
      () => {
        order.push("C");
      },
      { label: "C" },
    );
    await reg.emit("task.before", TASK_BEFORE);
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("B"));
    expect(order[0]).toBe("A"); // A has no constraint, stays first
  });
});

// ── HookRegistry — compensation handlers ─────────────────────────────────────

describe("HookRegistry — compensation handlers", () => {
  let reg: HookRegistry;

  beforeEach(() => {
    reg = makeRegistry();
  });

  it("compensation handlers do NOT run when no abort", async () => {
    const comp = vi.fn();
    reg.on("task.before", vi.fn()); // normal handler, no abort
    reg.on("task.before", comp, { compensate: true });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(comp).not.toHaveBeenCalled();
    expect(result.compensationsRan).toBe(0);
  });

  it("compensation handlers run when abort is triggered", async () => {
    const comp = vi.fn();
    reg.on("task.before", () => ({ abort: true }));
    reg.on("task.before", comp, { compensate: true });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(comp).toHaveBeenCalled();
    expect(result.compensationsRan).toBe(1);
    expect(result.aborted).toBe(true);
  });

  it("multiple compensation handlers run in reverse registration order", async () => {
    const order: string[] = [];
    reg.on("task.before", () => ({ abort: true }), { priority: 10 });
    reg.on(
      "task.before",
      () => {
        order.push("comp1");
      },
      { compensate: true },
    );
    reg.on(
      "task.before",
      () => {
        order.push("comp2");
      },
      { compensate: true },
    );
    reg.on(
      "task.before",
      () => {
        order.push("comp3");
      },
      { compensate: true },
    );
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.compensationsRan).toBe(3);
    expect(order).toEqual(["comp3", "comp2", "comp1"]);
  });

  it("compensationsRan counts only successfully ran compensations", async () => {
    reg.on("task.before", () => ({ abort: true }));
    reg.on("task.before", vi.fn(), { compensate: true });
    reg.on(
      "task.before",
      () => {
        throw new Error("comp-fail");
      },
      { compensate: true },
    );
    reg.on("task.before", vi.fn(), { compensate: true });

    // Registration order: comp1, comp2 (throws), comp3
    // Reverse order for execution: comp3, comp2 (throws), comp1
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.compensationsRan).toBe(2); // comp3 and comp1 succeed
    expect(result.errors.some((e) => e.error.includes("[compensation]"))).toBe(true);
  });

  it("compensation handler error is prefixed with [compensation] in error string", async () => {
    reg.on("task.before", () => ({ abort: true }));
    reg.on(
      "task.before",
      () => {
        throw new Error("rollback-failed");
      },
      { compensate: true },
    );
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors[0]?.error).toContain("[compensation]");
    expect(result.errors[0]?.error).toContain("rollback-failed");
  });

  it("compensation handlers receive the same payload as normal handlers", async () => {
    const comp = vi.fn();
    reg.on("task.before", () => ({ abort: true }));
    reg.on("task.before", comp, { compensate: true });
    await reg.emit("task.before", TASK_BEFORE);
    expect(comp).toHaveBeenCalledWith(TASK_BEFORE);
  });

  it("normal handlers skipped after abort are NOT treated as compensation handlers", async () => {
    const skipped = vi.fn();
    const comp = vi.fn();
    reg.on("task.before", () => ({ abort: true }), { priority: 10 });
    reg.on("task.before", skipped, { priority: 5 }); // normal, skipped
    reg.on("task.before", comp, { compensate: true });

    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(skipped).not.toHaveBeenCalled();
    expect(comp).toHaveBeenCalledTimes(1);
    expect(result.compensationsRan).toBe(1);
  });

  it("compensationsRan is 0 in EmitResult when abort never fires", async () => {
    reg.on("task.before", vi.fn());
    reg.on("task.before", vi.fn(), { compensate: true });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.compensationsRan).toBe(0);
  });
});
