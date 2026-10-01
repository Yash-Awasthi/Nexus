// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { TaskDependencyResolver } from "../src/dependency-resolver.js";
import type { Task } from "../src/task-router.js";

function makeTask(id: string, dependencies: string[] = []): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    priority: "normal",
    status: "pending",
    dependencies,
  };
}

describe("TaskDependencyResolver.detectCycles()", () => {
  const resolver = new TaskDependencyResolver();

  it("returns false for empty task list", () => {
    expect(resolver.detectCycles([])).toBe(false);
  });

  it("returns false for single task with no deps", () => {
    expect(resolver.detectCycles([makeTask("a")])).toBe(false);
  });

  it("returns false for linear chain a → b → c", () => {
    const tasks = [makeTask("a"), makeTask("b", ["a"]), makeTask("c", ["b"])];
    expect(resolver.detectCycles(tasks)).toBe(false);
  });

  it("returns false for diamond dependency a → {b,c} → d", () => {
    const tasks = [
      makeTask("a"),
      makeTask("b", ["a"]),
      makeTask("c", ["a"]),
      makeTask("d", ["b", "c"]),
    ];
    expect(resolver.detectCycles(tasks)).toBe(false);
  });

  it("returns true for direct self-cycle a → a", () => {
    expect(resolver.detectCycles([makeTask("a", ["a"])])).toBe(true);
  });

  it("returns true for 2-node cycle a → b → a", () => {
    const tasks = [makeTask("a", ["b"]), makeTask("b", ["a"])];
    expect(resolver.detectCycles(tasks)).toBe(true);
  });

  it("returns true for 3-node cycle a → b → c → a", () => {
    const tasks = [makeTask("a", ["c"]), makeTask("b", ["a"]), makeTask("c", ["b"])];
    expect(resolver.detectCycles(tasks)).toBe(true);
  });

  it("returns true for partial cycle in larger graph", () => {
    const tasks = [
      makeTask("root"),
      makeTask("a", ["root"]),
      makeTask("b", ["a"]),
      makeTask("c", ["b", "x"]),
      makeTask("x", ["c"]), // x → c → b → a (cycle x→c)
    ];
    expect(resolver.detectCycles(tasks)).toBe(true);
  });
});

describe("TaskDependencyResolver.resolveOrder()", () => {
  const resolver = new TaskDependencyResolver();

  it("returns single task as-is", () => {
    const tasks = [makeTask("a")];
    expect(resolver.resolveOrder(tasks)).toEqual(tasks);
  });

  it("resolves linear chain in dependency order", () => {
    const a = makeTask("a");
    const b = makeTask("b", ["a"]);
    const c = makeTask("c", ["b"]);
    const order = resolver.resolveOrder([c, b, a]); // deliberately reversed input
    const ids = order.map((t) => t.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  it("resolves diamond dependency: a before b and c, both before d", () => {
    const a = makeTask("a");
    const b = makeTask("b", ["a"]);
    const c = makeTask("c", ["a"]);
    const d = makeTask("d", ["b", "c"]);
    const order = resolver.resolveOrder([d, c, b, a]);
    const ids = order.map((t) => t.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
  });

  it("includes all input tasks in output", () => {
    const tasks = [makeTask("a"), makeTask("b", ["a"]), makeTask("c"), makeTask("d", ["b", "c"])];
    const order = resolver.resolveOrder(tasks);
    expect(order).toHaveLength(4);
    expect(order.map((t) => t.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("throws on cyclic dependencies", () => {
    const tasks = [makeTask("a", ["b"]), makeTask("b", ["a"])];
    expect(() => resolver.resolveOrder(tasks)).toThrow("Cyclic dependencies");
  });

  it("handles independent tasks (no deps) without throwing", () => {
    const tasks = [makeTask("x"), makeTask("y"), makeTask("z")];
    const order = resolver.resolveOrder(tasks);
    expect(order).toHaveLength(3);
  });

  it("handles tasks with deps on unknown ids gracefully", () => {
    // Dep points to non-existent task — resolver should not throw
    const tasks = [makeTask("a", ["missing-id"]), makeTask("b")];
    expect(() => resolver.resolveOrder(tasks)).not.toThrow();
  });
});
