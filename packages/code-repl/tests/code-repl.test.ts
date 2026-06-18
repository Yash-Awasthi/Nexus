// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  JupyterMode,
  MockReplExecutor,
  KernelSession,
  SessionReaper,
  KernelManager,
  type ReplLanguage,
} from "../src/index.js";

// ── JupyterMode ───────────────────────────────────────────────────────────────

describe("JupyterMode.wrapPython", () => {
  it("wraps expression to auto-print", () => {
    const wrapped = JupyterMode.wrapPython("1 + 2");
    expect(wrapped).toContain("__repl_last__");
    expect(wrapped).toContain("1 + 2");
  });

  it("does not wrap assignment statements", () => {
    const code = "x = 5";
    expect(JupyterMode.wrapPython(code)).toBe(code);
  });

  it("does not wrap def statements", () => {
    const code = "def foo():\n  pass";
    expect(JupyterMode.wrapPython(code)).toBe(code);
  });

  it("does not wrap import statements", () => {
    const code = "import os";
    expect(JupyterMode.wrapPython(code)).toBe(code);
  });

  it("does not wrap print calls", () => {
    const code = "print('hello')";
    expect(JupyterMode.wrapPython(code)).toBe(code);
  });

  it("handles empty code", () => {
    expect(JupyterMode.wrapPython("")).toBe("");
  });

  it("handles code with trailing whitespace lines", () => {
    const code = "x + 1\n\n\n";
    const wrapped = JupyterMode.wrapPython(code);
    expect(wrapped).toContain("__repl_last__");
  });
});

describe("JupyterMode.wrapR", () => {
  it("wraps expression", () => {
    const wrapped = JupyterMode.wrapR("1 + 2");
    expect(wrapped).toContain("print(1 + 2)");
  });

  it("does not wrap assignment", () => {
    const code = "x <- 5";
    expect(JupyterMode.wrapR(code)).toBe(code);
  });
});

describe("JupyterMode.wrapJulia", () => {
  it("wraps expression", () => {
    const wrapped = JupyterMode.wrapJulia("1 + 2");
    expect(wrapped).toContain("println(1 + 2)");
  });

  it("does not wrap assignment", () => {
    const code = "x = 5";
    expect(JupyterMode.wrapJulia(code)).toBe(code);
  });
});

describe("JupyterMode.wrap", () => {
  it("dispatches to correct language wrapper", () => {
    expect(JupyterMode.wrap("x + 1", "python")).toContain("__repl_last__");
    expect(JupyterMode.wrap("x + 1", "r")).toContain("print(x + 1)");
    expect(JupyterMode.wrap("x + 1", "julia")).toContain("println(x + 1)");
  });
});

// ── MockReplExecutor ──────────────────────────────────────────────────────────

describe("MockReplExecutor", () => {
  it("execute records calls and returns behavior", async () => {
    const exec = new MockReplExecutor({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      durationMs: 5,
    });
    const result = await exec.execute("python", "print('hello')", {} as any);
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
    expect(exec.executionLog).toHaveLength(1);
    expect(exec.executionLog[0]!.language).toBe("python");
  });

  it("throws when behavior.throws is set", async () => {
    const exec = new MockReplExecutor({ throws: "kernel crash" });
    await expect(exec.execute("python", "x=1", {} as any)).rejects.toThrow("kernel crash");
  });

  it("cycles through behavior array", async () => {
    const exec = new MockReplExecutor([{ stdout: "first" }, { stdout: "second" }]);
    const r1 = await exec.execute("python", "1", {} as any);
    const r2 = await exec.execute("python", "2", {} as any);
    const r3 = await exec.execute("python", "3", {} as any); // wraps to last
    expect(r1.stdout).toBe("first");
    expect(r2.stdout).toBe("second");
    expect(r3.stdout).toBe("second"); // stays on last behavior
  });

  it("calls onExecute with code and state", async () => {
    let capturedCode = "";
    const exec = new MockReplExecutor({
      onExecute: (code) => {
        capturedCode = code;
      },
    });
    await exec.execute("python", "test_code", {} as any);
    expect(capturedCode).toBe("test_code");
  });
});

// ── KernelSession ─────────────────────────────────────────────────────────────

describe("KernelSession", () => {
  it("execute runs code and returns result", async () => {
    const exec = new MockReplExecutor({ stdout: "42\n" });
    const session = new KernelSession("python", exec);
    const result = await session.execute({ code: "print(42)" });
    expect(result.stdout).toBe("42\n");
  });

  it("records code in history", async () => {
    const exec = new MockReplExecutor({ stdout: "" });
    const session = new KernelSession("python", exec);
    await session.execute({ code: "x = 1" });
    await session.execute({ code: "y = 2" });
    expect(session.getHistory()).toEqual(["x = 1", "y = 2"]);
  });

  it("increments executionCount", async () => {
    const exec = new MockReplExecutor({ stdout: "" });
    const session = new KernelSession("python", exec);
    await session.execute({ code: "x = 1" });
    await session.execute({ code: "y = 2" });
    expect(session.executionCount).toBe(2);
  });

  it("applies JupyterMode wrapping by default", async () => {
    let capturedCode = "";
    const exec = new MockReplExecutor({
      onExecute: (code) => {
        capturedCode = code;
      },
    });
    const session = new KernelSession("python", exec, true);
    await session.execute({ code: "1 + 2" });
    expect(capturedCode).toContain("__repl_last__");
  });

  it("skips JupyterMode wrapping when disabled", async () => {
    let capturedCode = "";
    const exec = new MockReplExecutor({
      onExecute: (code) => {
        capturedCode = code;
      },
    });
    const session = new KernelSession("python", exec, false);
    await session.execute({ code: "1 + 2" });
    expect(capturedCode).toBe("1 + 2");
  });

  it("setVariable and getVariable work", () => {
    const exec = new MockReplExecutor();
    const session = new KernelSession("python", exec);
    session.setVariable("x", 42);
    expect(session.getVariable("x")).toBe(42);
  });

  it("idleTimeMs is non-negative", () => {
    const exec = new MockReplExecutor();
    const session = new KernelSession("python", exec);
    expect(session.idleTimeMs()).toBeGreaterThanOrEqual(0);
  });

  it("each session gets a unique id", () => {
    const exec = new MockReplExecutor();
    const s1 = new KernelSession("python", exec);
    const s2 = new KernelSession("python", exec);
    expect(s1.id).not.toBe(s2.id);
  });
});

// ── SessionReaper ─────────────────────────────────────────────────────────────

describe("SessionReaper", () => {
  it("identify returns empty when no sessions are idle", () => {
    const exec = new MockReplExecutor();
    const s1 = new KernelSession("python", exec);
    const reaper = new SessionReaper(60_000);
    expect(reaper.identify([s1])).toHaveLength(0);
  });

  it("reap removes idle sessions from registry", () => {
    const exec = new MockReplExecutor();
    const s1 = new KernelSession("python", exec);
    // Manually set lastUsedAt to way in the past
    (s1 as any).state.lastUsedAt = new Date(0).toISOString(); // epoch = very old
    const reaper = new SessionReaper(0); // 0ms threshold → any age is idle
    const registry = new Map([[s1.id, s1]]); // key must match session.id for delete to work
    const count = reaper.reap(registry);
    expect(count).toBe(1);
    expect(registry.size).toBe(0);
  });
});

// ── KernelManager ─────────────────────────────────────────────────────────────

describe("KernelManager", () => {
  let exec: MockReplExecutor;
  let manager: KernelManager;

  beforeEach(() => {
    exec = new MockReplExecutor({ stdout: "" });
    manager = new KernelManager({ executor: exec, maxSessions: 3 });
  });

  it("create returns a new KernelSession", () => {
    const session = manager.create("python");
    expect(session).toBeDefined();
    expect(session.language).toBe("python");
    expect(manager.count()).toBe(1);
  });

  it("get retrieves session by id", () => {
    const session = manager.create("r");
    expect(manager.get(session.id)).toBe(session);
  });

  it("has returns correct boolean", () => {
    const session = manager.create("julia");
    expect(manager.has(session.id)).toBe(true);
    expect(manager.has("nonexistent")).toBe(false);
  });

  it("destroy removes a session", () => {
    const session = manager.create("python");
    expect(manager.destroy(session.id)).toBe(true);
    expect(manager.has(session.id)).toBe(false);
  });

  it("destroyAll clears all sessions", () => {
    manager.create("python");
    manager.create("r");
    manager.destroyAll();
    expect(manager.count()).toBe(0);
  });

  it("list returns all sessions", () => {
    manager.create("python");
    manager.create("r");
    expect(manager.list()).toHaveLength(2);
  });

  it("throws when at capacity with no idle sessions to reap", () => {
    manager.create("python");
    manager.create("r");
    manager.create("julia");
    expect(() => manager.create("python")).toThrow("capacity");
  });

  it("reapIdle removes idle sessions freeing capacity", () => {
    const s1 = manager.create("python");
    (s1 as any).state.lastUsedAt = new Date(0).toISOString(); // make idle
    manager.create("r");
    manager.create("julia");
    // now at capacity, but s1 is idle — reap should allow a 4th
    manager.reapIdle();
    expect(() => manager.create("python")).not.toThrow();
  });

  it("create supports all 3 languages", () => {
    const langs: ReplLanguage[] = ["python", "r", "julia"];
    for (const lang of langs) {
      const session = manager.create(lang);
      expect(session.language).toBe(lang);
    }
  });
});
