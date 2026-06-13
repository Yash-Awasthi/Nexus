// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  HookRegistry,
  HookError,
  globalHooks,
  definePlugin,
  HOOK_EVENTS,
  type Plugin,
  type HookRegistration,
  type EmitResult,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRegistry(): HookRegistry {
  return new HookRegistry();
}

const SESSION_INIT = { sessionId: "s1", startedAt: 1000 };
const TASK_BEFORE = { taskId: "t1", taskType: "doc.ingest", payload: {}, attempt: 1 };
const TASK_AFTER = { taskId: "t1", taskType: "doc.ingest", result: {}, durationMs: 42 };
const TASK_ERROR = { taskId: "t1", taskType: "doc.ingest", error: "failed", attempt: 1, willRetry: false };
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
  beforeEach(() => { reg = makeRegistry(); });

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
  beforeEach(() => { reg = makeRegistry(); });

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
  beforeEach(() => { reg = makeRegistry(); });

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
    reg.on("task.before", () => { order.push(1); }, { priority: 10 });
    reg.on("task.before", () => { order.push(2); }, { priority: 20 });
    reg.on("task.before", () => { order.push(3); }, { priority: 5 });
    await reg.emit("task.before", TASK_BEFORE);
    expect(order).toEqual([2, 1, 3]);
  });

  it("handlers with equal priority run in insertion order", async () => {
    reg.on("task.before", () => { order.push(1); }, { priority: 0 });
    reg.on("task.before", () => { order.push(2); }, { priority: 0 });
    reg.on("task.before", () => { order.push(3); }, { priority: 0 });
    await reg.emit("task.before", TASK_BEFORE);
    expect(order).toEqual([1, 2, 3]);
  });
});

// ── HookRegistry — abort ──────────────────────────────────────────────────────

describe("HookRegistry.emit — abort", () => {
  let reg: HookRegistry;
  beforeEach(() => { reg = makeRegistry(); });

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
  beforeEach(() => { reg = makeRegistry(); });

  it("collects error from throwing handler without stopping chain", async () => {
    const second = vi.fn();
    reg.on("task.before", () => { throw new Error("boom"); }, { priority: 10 });
    reg.on("task.before", second, { priority: 5 });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("boom");
    expect(second).toHaveBeenCalled();
  });

  it("error entry includes handlerId", async () => {
    const h = reg.on("task.before", () => { throw new Error("x"); });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors[0]?.handlerId).toBe(h.id);
  });

  it("error entry includes label when provided", async () => {
    reg.on("task.before", () => { throw new Error("x"); }, { label: "my-label" });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors[0]?.label).toBe("my-label");
  });

  it("does not throw even when all handlers throw", async () => {
    reg.on("task.before", () => { throw new Error("1"); });
    reg.on("task.before", () => { throw new Error("2"); });
    await expect(reg.emit("task.before", TASK_BEFORE)).resolves.toBeDefined();
  });

  it("async throwing handler is collected", async () => {
    reg.on("task.before", async () => { throw new Error("async-err"); });
    const result = await reg.emit("task.before", TASK_BEFORE);
    expect(result.errors[0]?.error).toContain("async-err");
  });
});

// ── HookRegistry — specific event shapes ──────────────────────────────────────

describe("HookRegistry.emit — all event payload shapes", () => {
  let reg: HookRegistry;
  beforeEach(() => { reg = makeRegistry(); });

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
  beforeEach(() => { reg = makeRegistry(); });

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
  beforeEach(() => { reg = makeRegistry(); });

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
    try { reg.use(p); } catch (e) { caught = e; }
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
    reg.use(definePlugin({ name: "a", version: "1", install: (r) => { r.on("task.before", () => { calls.push("a"); }); } }));
    reg.use(definePlugin({ name: "b", version: "1", install: (r) => { r.on("task.before", () => { calls.push("b"); }); } }));
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
