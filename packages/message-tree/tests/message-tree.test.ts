// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { MessageTree, BranchManager } from "../src/index.js";

// ── MessageTree ───────────────────────────────────────────────────────────────

describe("MessageTree — add / get", () => {
  let tree: MessageTree;
  beforeEach(() => {
    tree = new MessageTree();
  });

  it("adds root node when no parentId given", () => {
    const n = tree.add({ role: "system", content: "You are helpful" });
    expect(tree.root?.id).toBe(n.id);
    expect(n.depth).toBe(0);
    expect(n.parentId).toBeNull();
  });

  it("adds child at depth 1", () => {
    const root = tree.add({ role: "system", content: "sys" });
    const child = tree.add({ role: "user", content: "hello" }, root.id);
    expect(child.depth).toBe(1);
    expect(child.parentId).toBe(root.id);
    expect(root.childIds).toContain(child.id);
  });

  it("get returns node by id", () => {
    const n = tree.add({ role: "user", content: "hi" });
    expect(tree.get(n.id)).toBeDefined();
  });

  it("get returns undefined for unknown id", () => {
    expect(tree.get("ghost")).toBeUndefined();
  });

  it("size increments correctly", () => {
    expect(tree.size).toBe(0);
    tree.add({ role: "user", content: "a" });
    expect(tree.size).toBe(1);
  });

  it("throws when adding child to unknown parent", () => {
    expect(() => tree.add({ role: "user", content: "x" }, "ghost")).toThrow();
  });

  it("default state is 'complete'", () => {
    const n = tree.add({ role: "user", content: "hello" });
    expect(n.state).toBe("complete");
  });

  it("custom state accepted", () => {
    const n = tree.add({ role: "assistant", content: "...", state: "streaming" });
    expect(n.state).toBe("streaming");
  });

  it("stores metadata", () => {
    const n = tree.add({ role: "assistant", content: "x", metadata: { model: "claude" } });
    expect(n.metadata?.["model"]).toBe("claude");
  });
});

describe("MessageTree — setState", () => {
  it("updates node state", () => {
    const tree = new MessageTree();
    const n = tree.add({ role: "assistant", content: "thinking..." });
    tree.setState(n.id, "streaming");
    expect(tree.get(n.id)!.state).toBe("streaming");
  });

  it("throws for unknown id", () => {
    const tree = new MessageTree();
    expect(() => tree.setState("ghost", "complete")).toThrow();
  });
});

describe("MessageTree — pathTo", () => {
  let tree: MessageTree;
  let rootId: string;
  let midId: string;
  let leafId: string;

  beforeEach(() => {
    tree = new MessageTree();
    const root = tree.add({ role: "system", content: "sys" });
    const mid = tree.add({ role: "user", content: "Q" }, root.id);
    const leaf = tree.add({ role: "assistant", content: "A" }, mid.id);
    rootId = root.id;
    midId = mid.id;
    leafId = leaf.id;
  });

  it("returns path from root to leaf", () => {
    const path = tree.pathTo(leafId);
    expect(path).toHaveLength(3);
    expect(path[0]!.id).toBe(rootId);
    expect(path[2]!.id).toBe(leafId);
  });

  it("returns single-element path for root", () => {
    const path = tree.pathTo(rootId);
    expect(path).toHaveLength(1);
  });
});

describe("MessageTree — leaves + level", () => {
  it("leaves() returns nodes with no children", () => {
    const tree = new MessageTree();
    const root = tree.add({ role: "user", content: "root" });
    const a = tree.add({ role: "assistant", content: "a" }, root.id);
    const b = tree.add({ role: "assistant", content: "b" }, root.id);
    const leaves = tree.leaves();
    expect(leaves.map((l) => l.id)).toContain(a.id);
    expect(leaves.map((l) => l.id)).toContain(b.id);
    expect(leaves.map((l) => l.id)).not.toContain(root.id);
  });

  it("level() returns all nodes at given depth", () => {
    const tree = new MessageTree();
    const root = tree.add({ role: "user", content: "root" });
    tree.add({ role: "assistant", content: "a" }, root.id);
    tree.add({ role: "assistant", content: "b" }, root.id);
    expect(tree.level(1)).toHaveLength(2);
    expect(tree.level(0)).toHaveLength(1);
  });
});

describe("MessageTree — fork", () => {
  it("creates a new tree with the ancestor chain", () => {
    const tree = new MessageTree();
    const root = tree.add({ role: "system", content: "sys" });
    const mid = tree.add({ role: "user", content: "Q" }, root.id);
    const leaf = tree.add({ role: "assistant", content: "A" }, mid.id);

    const forked = tree.fork(leaf.id);
    expect(forked.size).toBe(3);
    expect(forked.root?.role).toBe("system");
    expect(forked.leaves()[0]?.content).toBe("A");
  });

  it("fork is independent of original tree", () => {
    const tree = new MessageTree();
    const root = tree.add({ role: "user", content: "hi" });
    const forked = tree.fork(root.id);
    forked.add({ role: "assistant", content: "new branch" }, forked.root!.id);
    expect(tree.size).toBe(1);
    expect(forked.size).toBe(2);
  });
});

describe("MessageTree — snapshot / fromSnapshot", () => {
  it("round-trips correctly", () => {
    const tree = new MessageTree();
    const r = tree.add({ role: "user", content: "hello" });
    tree.add({ role: "assistant", content: "world" }, r.id);
    const snap = tree.snapshot();
    const restored = MessageTree.fromSnapshot(snap);
    expect(restored.size).toBe(2);
    expect(restored.root?.content).toBe("hello");
  });
});

// ── BranchManager ──────────────────────────────────────────────────────────────

describe("BranchManager", () => {
  let mgr: BranchManager;

  beforeEach(() => {
    mgr = new BranchManager();
  });

  it("creates and retrieves a branch", () => {
    const b = mgr.create("main", "node-1");
    expect(mgr.get("main")).toBe(b);
  });

  it("list() returns all branches", () => {
    mgr.create("main", "n1");
    mgr.create("feature", "n2");
    expect(mgr.list()).toHaveLength(2);
  });

  it("has() returns correct boolean", () => {
    mgr.create("main", "n1");
    expect(mgr.has("main")).toBe(true);
    expect(mgr.has("dev")).toBe(false);
  });

  it("update() changes tipNodeId", () => {
    mgr.create("main", "n1");
    mgr.update("main", "n2");
    expect(mgr.get("main")!.tipNodeId).toBe("n2");
  });

  it("update() throws for unknown branch", () => {
    expect(() => mgr.update("ghost", "n1")).toThrow();
  });

  it("delete() removes branch", () => {
    mgr.create("main", "n1");
    expect(mgr.delete("main")).toBe(true);
    expect(mgr.has("main")).toBe(false);
  });

  it("delete() returns false for unknown branch", () => {
    expect(mgr.delete("ghost")).toBe(false);
  });

  it("diff() returns nodes in B not in A path", () => {
    const tree = new MessageTree();
    const root = tree.add({ role: "system", content: "sys" });
    const pathA = tree.add({ role: "user", content: "branch A" }, root.id);
    const pathB = tree.add({ role: "user", content: "branch B" }, root.id);
    const pathBChild = tree.add({ role: "assistant", content: "B child" }, pathB.id);

    mgr.create("A", pathA.id);
    mgr.create("B", pathBChild.id);

    const diff = mgr.diff(tree, "A", "B");
    expect(diff).toContain(pathB.id);
    expect(diff).toContain(pathBChild.id);
    expect(diff).not.toContain(root.id);
  });
});
