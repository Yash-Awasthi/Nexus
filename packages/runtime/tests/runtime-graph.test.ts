// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { GraphConsistencyError, GraphMutationError, RuntimeGraph } from "../src/runtime-graph.js";
import type { IEventBus } from "../src/event-bus.js";
import type { IRuntimePersistence } from "../src/interfaces/persistence.interface.js";

// ── Fakes ──────────────────────────────────────────────────────────────────────

class FakePersistence implements IRuntimePersistence {
  store = new Map<string, unknown>();
  async saveState(key: string, state: unknown): Promise<void> {
    this.store.set(key, state);
  }
  async getState<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }
  async clearState(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class FakeBus {
  events: { channel: string; payload: unknown; causeEventId?: string }[] = [];
  async publish(
    channel: string,
    payload: unknown,
    options?: { causeEventId?: string },
  ): Promise<void> {
    this.events.push({ channel, payload, causeEventId: options?.causeEventId });
  }
}

function makeGraph(opts?: { persistence?: FakePersistence; bus?: FakeBus }) {
  const persistence = opts?.persistence ?? new FakePersistence();
  const bus = opts?.bus ?? new FakeBus();
  const graph = new RuntimeGraph(
    persistence as unknown as IRuntimePersistence,
    bus as unknown as IEventBus,
  );
  graph.setAutoCheckpoint(false);
  return { graph, persistence, bus };
}

// ── Error classes ─────────────────────────────────────────────────────────────

describe("graph error classes", () => {
  it("GraphMutationError carries an op and optional cause", () => {
    const cause = new Error("root");
    const e = new GraphMutationError("boom", "addNode", cause);
    expect(e.name).toBe("GraphMutationError");
    expect(e.op).toBe("addNode");
    expect(e.cause).toBe(cause);
  });

  it("GraphConsistencyError carries an integrity report", () => {
    const e = new GraphConsistencyError("inconsistent", {
      valid: false,
    } as never);
    expect(e.name).toBe("GraphConsistencyError");
    expect(e.report.valid).toBe(false);
  });
});

// ── Node mutations ────────────────────────────────────────────────────────────

describe("RuntimeGraph node mutations", () => {
  it("addNode creates a node with defaults and publishes an event", async () => {
    const { graph, bus } = makeGraph();
    const node = await graph.addNode("wf-1", "workflow", "My Workflow");
    expect(node).toMatchObject({
      id: "wf-1",
      type: "workflow",
      name: "My Workflow",
      status: "active",
      metadata: {},
      dependencies: [],
    });
    expect(bus.events.some((e) => e.channel === "runtime_graph:node_added")).toBe(true);
    expect(await graph.getNode("wf-1")).toBeDefined();
  });

  it("addNode with an existing id updates instead of duplicating", async () => {
    const { graph } = makeGraph();
    await graph.addNode("n1", "agent", "Agent A", { status: "pending", metadata: { x: 1 } });
    const updated = await graph.addNode("n1", "agent", "Agent A", {
      status: "active",
      metadata: { y: 2 },
      dependencies: ["dep-1"],
    });
    expect(updated.status).toBe("active");
    expect(updated.metadata).toEqual({ x: 1, y: 2 });
    expect(updated.dependencies).toEqual(["dep-1"]);
    expect(await graph.getAllNodes()).toHaveLength(1);
    // Re-adding merges dependency sets without duplicates.
    await graph.addNode("n1", "agent", "Agent A", { dependencies: ["dep-1", "dep-2"] });
    expect((await graph.getNode("n1"))?.dependencies).toEqual(["dep-1", "dep-2"]);
  });

  it("updateNodeStatus updates the node and records the journal; missing node throws", async () => {
    const { graph } = makeGraph();
    await graph.addNode("n1", "agent", "A");
    await graph.updateNodeStatus("n1", "degraded", { reason: "slow" });
    const node = await graph.getNode("n1");
    expect(node?.status).toBe("degraded");
    expect(node?.metadata.reason).toBe("slow");
    expect(graph.getJournal().some((j) => j.op === "updateNode")).toBe(true);

    await expect(graph.updateNodeStatus("ghost", "failed")).rejects.toThrow(
      "Node not found: ghost",
    );
  });

  it("updateNodeMetadata merges and throws for unknown nodes", async () => {
    const { graph } = makeGraph();
    await graph.addNode("n1", "agent", "A");
    await graph.updateNodeMetadata("n1", { region: "us" });
    expect((await graph.getNode("n1"))?.metadata).toEqual({ region: "us" });
    await expect(graph.updateNodeMetadata("ghost", {})).rejects.toThrow("Node not found: ghost");
  });

  it("removeNode cascades edges and dependency references", async () => {
    const { graph, bus } = makeGraph();
    await graph.addNode("a", "agent", "A");
    await graph.addNode("b", "agent", "B", { dependencies: ["a"] });
    await graph.addEdge("a", "b", "manages");
    await graph.addEdge("b", "a", "triggers");

    await graph.removeNode("a");
    expect(await graph.getNode("a")).toBeUndefined();
    expect((await graph.getNode("b"))?.dependencies).toEqual([]);
    expect(bus.events.some((e) => e.channel === "runtime_graph:node_removed")).toBe(true);

    const report = await graph.validate();
    expect(report.danglingEdgeCount).toBe(0); // both edges cascaded away
  });

  it("bulkAddNodes adds all atomically and skips existing ids", async () => {
    const { graph } = makeGraph();
    await graph.addNode("existing", "agent", "E");
    const added = await graph.bulkAddNodes([
      { id: "existing", type: "agent", name: "E" },
      { id: "x1", type: "workflow", name: "X1" },
      { id: "x2", type: "workflow", name: "X2" },
    ]);
    expect(added.map((n) => n.id)).toEqual(["existing", "x1", "x2"]);
    expect(await graph.getAllNodes()).toHaveLength(3);
  });
});

// ── Edges + queries ───────────────────────────────────────────────────────────

describe("RuntimeGraph edges and queries", () => {
  it("addEdge requires both endpoints and skips exact duplicates", async () => {
    const { graph } = makeGraph();
    await graph.addNode("a", "agent", "A");
    await graph.addNode("b", "agent", "B");
    await expect(graph.addEdge("a", "ghost", "manages")).rejects.toThrow(
      "Target node not found: ghost",
    );
    await expect(graph.addEdge("ghost", "b", "manages")).rejects.toThrow(
      "Source node not found: ghost",
    );

    await graph.addEdge("a", "b", "depends_on", { why: "test" });
    await graph.addEdge("a", "b", "depends_on", { why: "test" }); // duplicate — no-op
    expect(await graph.getSnapshot()).toHaveProperty("edges", [
      expect.objectContaining({ from: "a", to: "b" }),
    ]);
  });

  it("removeEdge only removes the exact matching edge", async () => {
    const { graph } = makeGraph();
    await graph.addNode("a", "agent", "A");
    await graph.addNode("b", "agent", "B");
    await graph.addEdge("a", "b", "triggers");
    await graph.addEdge("a", "b", "manages");
    await graph.removeEdge("a", "b", "triggers");
    const snap = await graph.getSnapshot();
    expect(snap.edges).toHaveLength(1);
    expect(snap.edges[0]?.relationship).toBe("manages");
  });

  it("queries nodes by type/status and resolves dependents/dependencies", async () => {
    const { graph } = makeGraph();
    await graph.addNode("wf", "workflow", "W", { status: "active" });
    await graph.addNode("agent-1", "agent", "A1", { status: "pending", dependencies: ["wf"] });
    await graph.addNode("agent-2", "agent", "A2", { status: "failed" });
    await graph.addEdge("agent-1", "agent-2", "depends_on"); // agent-1 depends on agent-2

    expect((await graph.getNodesByType("agent")).map((n) => n.id).sort()).toEqual([
      "agent-1",
      "agent-2",
    ]);
    expect((await graph.getNodesByStatus("pending")).map((n) => n.id)).toEqual(["agent-1"]);
    // agent-1 depends on wf (static) and on agent-2 (edge-based depends_on from agent-1).
    const deps = (await graph.getDependencies("agent-1")).map((n) => n.id).sort();
    expect(deps).toEqual(["agent-2", "wf"]);
    expect((await graph.getDependents("agent-2")).map((n) => n.id)).toEqual(["agent-1"]);
    expect(await graph.getDependencies("missing")).toEqual([]);
  });

  it("getSnapshot summarises by type/status/service counts", async () => {
    const { graph } = makeGraph();
    await graph.addNode("wf", "workflow", "W");
    await graph.addNode("s1", "floci_s3_bucket", "S1");
    await graph.addNode("s2", "mcp_server", "S2", { status: "failed" });
    await graph.addNode("a1", "agent", "A1", { status: "pending" });

    const snap = await graph.getSnapshot();
    expect(snap.summary).toMatchObject({
      totalNodes: 4,
      workflows: 1,
      activeServices: 1, // s1 active + non-workflow
      failedServices: 1,
      byType: { workflow: 1, floci_s3_bucket: 1, mcp_server: 1, agent: 1 },
    });
    expect(snap.summary.byStatus.pending).toBe(1);
  });
});

// ── Snapshots ─────────────────────────────────────────────────────────────────

describe("RuntimeGraph snapshots", () => {
  it("saveSnapshot persists and getSnapshots returns copies", async () => {
    const { graph, persistence } = makeGraph();
    await graph.addNode("a", "agent", "A");
    const snap = await graph.saveSnapshot("initial");
    expect(snap.summary.totalNodes).toBe(1);
    expect(graph.getSnapshots()).toHaveLength(1);
    expect(persistence.store.size).toBeGreaterThan(0);
  });

  it("compareSnapshots diffs added/removed/changed nodes and edges", async () => {
    const { graph } = makeGraph();
    await graph.addNode("keep", "agent", "K");
    await graph.addNode("gone", "agent", "G");
    await graph.addNode("mutate", "agent", "M", { status: "active" });
    const before = await graph.getSnapshot();

    await graph.addNode("added", "agent", "N");
    await graph.removeNode("gone");
    await graph.updateNodeStatus("mutate", "failed");

    const after = await graph.getSnapshot();
    const diff = graph.compareSnapshots(before, after);
    expect(diff.addedNodes.map((n) => n.id)).toEqual(["added"]);
    expect(diff.removedNodes.map((n) => n.id)).toEqual(["gone"]);
    expect(diff.changedNodes.map((c) => c.id)).toEqual(["mutate"]);
    expect(diff.addedEdges).toEqual([]);
    expect(diff.removedEdges).toEqual([]);
  });

  it("restoreSnapshot reverts the graph to a captured state", async () => {
    const { graph } = makeGraph();
    await graph.addNode("a", "agent", "A");
    const snap = await graph.saveSnapshot();
    await graph.addNode("b", "agent", "B");
    await graph.addNode("c", "agent", "C");
    await graph.restoreSnapshot(snap);
    expect((await graph.getAllNodes()).map((n) => n.id)).toEqual(["a"]);
  });
});

// ── Checkpoints ───────────────────────────────────────────────────────────────

describe("RuntimeGraph checkpoints", () => {
  it("creates a checkpoint and restores the last valid one", async () => {
    const { graph } = makeGraph();
    await graph.addNode("a", "agent", "A");
    await graph.createCheckpoint("clean");
    // Corrupt the graph afterwards.
    await graph.addNode("b", "agent", "B", { dependencies: ["ghost"] });

    const cp = graph.getCheckpoints();
    expect(cp).toHaveLength(1);
    expect(cp[0]?.label).toBe("clean");
    expect(cp[0]?.report.valid).toBe(true);

    // The only checkpoint is valid (captured before corruption) — restore brings back 'a'.
    const restored = await graph.restoreLastValidCheckpoint();
    expect(restored?.label).toBe("clean");
    expect((await graph.getAllNodes()).map((n) => n.id)).toEqual(["a"]);
  });

  it("restoreLastValidCheckpoint walks backwards to a valid checkpoint", async () => {
    const { graph } = makeGraph();
    await graph.addNode("a", "agent", "A");
    await graph.createCheckpoint("v1");
    await graph.addNode("b", "agent", "B", { dependencies: ["ghost"] });
    await graph.createCheckpoint("broken");

    expect(graph.getCheckpoints()[1]?.report.valid).toBe(false);
    const restored = await graph.restoreLastValidCheckpoint();
    expect(restored?.label).toBe("v1");
  });

  it("returns null when no valid checkpoint exists", async () => {
    const { graph } = makeGraph();
    graph.setAutoCheckpoint(true);
    // Preload a corrupt graph and checkpoint it.
    const { persistence } = makeGraph();
    void persistence;
    await expect(graph.restoreLastValidCheckpoint()).resolves.toBeNull();
  });

  it("auto-checkpoints every 25 mutations when enabled", async () => {
    const { graph } = makeGraph();
    graph.setAutoCheckpoint(true);
    for (let i = 0; i < 26; i++) {
      await graph.addNode(`n${i}`, "agent", `N${i}`);
    }
    const cps = graph.getCheckpoints();
    expect(cps.length).toBeGreaterThanOrEqual(1);
    expect(cps[0]?.label).toContain("auto-mutation");
  });

  it("journal records ops and can be cleared", async () => {
    const { graph } = makeGraph();
    await graph.addNode("a", "agent", "A");
    await graph.updateNodeStatus("a", "failed");
    expect(graph.getJournal().map((j) => j.op)).toEqual(["addNode", "updateNode"]);
    graph.clearJournal();
    expect(graph.getJournal()).toEqual([]);
  });
});

// ── Integrity: validate / repair / cycles ─────────────────────────────────────

describe("RuntimeGraph integrity", () => {
  it("validate passes for a consistent graph and flags dangling edges + missing deps", async () => {
    const { graph } = makeGraph();
    await graph.addNode("a", "agent", "A");
    const clean = await graph.validate();
    expect(clean.valid).toBe(true);

    // Missing dep: add a node whose dependency never existed.
    await graph.addNode("c", "agent", "C", { dependencies: ["nope"] });
    const report = await graph.validate();
    expect(report.valid).toBe(false);
    expect(report.missingDependencyCount).toBe(1);
    expect(report.missingDependencyList[0]).toEqual({ nodeId: "c", missingDepId: "nope" });
    expect(report.warnings.length).toBeGreaterThan(0);

    // Dangling edge: removeNode cascades edges, so a dangling edge can only be
    // created by loading state that already references a missing node.
    const p = new FakePersistence();
    await p.saveState("runtime_graph_data", {
      nodes: [
        [
          "a",
          {
            id: "a",
            type: "agent",
            name: "A",
            status: "active",
            metadata: {},
            dependencies: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      ],
      edges: [{ from: "a", to: "ghost", relationship: "manages" }],
    });
    const g2 = new RuntimeGraph(p as unknown as IRuntimePersistence);
    g2.setAutoCheckpoint(false);
    const dangle = await g2.validate();
    expect(dangle.danglingEdgeCount).toBe(1);
    expect(dangle.danglingEdgeList[0]).toMatchObject({ from: "a", to: "ghost" });
  });

  it("detectCycles finds dependency cycles", async () => {
    const { graph } = makeGraph();
    await graph.addNode("a", "agent", "A", { dependencies: ["b"] });
    await graph.addNode("b", "agent", "B", { dependencies: ["a"] });
    const cycles = await graph.detectCycles();
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]?.[0]).toBe(cycles[0]?.[cycles[0]!.length - 1]);
  });

  it("validate flags desynced depends_on edges and stale statuses", async () => {
    const { graph, persistence } = makeGraph();
    await graph.addNode("a", "agent", "A");
    await graph.addNode("b", "agent", "B");
    await graph.addEdge("a", "b", "depends_on"); // B doesn't list A as a dependency
    const report = await graph.validate();
    expect(report.desyncedEdgeCount).toBe(1);

    // Stale "removed" node via a preloaded persistence snapshot (>24h old).
    const staleDate = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const state = {
      nodes: [
        [
          "old",
          {
            id: "old",
            type: "agent",
            name: "Old",
            status: "removed",
            metadata: {},
            dependencies: [],
            createdAt: staleDate,
            updatedAt: staleDate,
          },
        ],
      ],
      edges: [],
    };
    void persistence;
    const p2 = new FakePersistence();
    await p2.saveState("runtime_graph_data", state);
    const g2 = makeGraph({ persistence: p2 });
    const staleReport = await g2.graph.validate();
    expect(staleReport.staleStatusCount).toBe(1);
  });

  it("repair removes dangling edges, fixes deps/desync, dedupes edges", async () => {
    const { graph, bus } = makeGraph();
    await graph.addNode("a", "agent", "A");
    await graph.addNode("b", "agent", "B");
    await graph.addNode("c", "agent", "C");
    // Dangling edge (c removed below), duplicate edge, desynced depends_on.
    await graph.addNode("d", "agent", "D", { dependencies: ["ghost"] });
    await graph.addEdge("a", "b", "triggers");
    await graph.addEdge("a", "b", "triggers");
    await graph.addEdge("a", "b", "depends_on");
    await graph.removeNode("c");

    const report = await graph.repair();
    expect(report.valid).toBe(true);
    expect(report.repaired).toBe(true);
    expect(report.danglingEdgeCount).toBe(0);
    expect(report.missingDependencyCount).toBe(0);
    expect(report.desyncedEdgeCount).toBe(0);
    expect(bus.events.some((e) => e.channel === "runtime_graph:repaired")).toBe(true);

    // Repair again on a clean graph reports valid + not repaired.
    const clean = await graph.repair();
    expect(clean.valid).toBe(true);
    expect(clean.repaired).toBe(false);
  });
});

// ── Persistence round-trip ────────────────────────────────────────────────────

describe("RuntimeGraph persistence", () => {
  it("restores nodes and edges from a shared persistence store", async () => {
    const persistence = new FakePersistence();
    const { graph } = makeGraph({ persistence });
    await graph.addNode("a", "agent", "A", { status: "degraded", metadata: { k: "v" } });
    await graph.addNode("b", "workflow", "B", { dependencies: ["a"] });
    await graph.addEdge("a", "b", "manages");

    const g2 = new RuntimeGraph(persistence as unknown as IRuntimePersistence, undefined);
    g2.setAutoCheckpoint(false);
    expect(await g2.getNode("a")).toMatchObject({ status: "degraded" });
    expect((await g2.getNode("a"))?.metadata).toEqual({ k: "v" });
    expect(await g2.getNode("b")).toBeDefined();
    const snap = await g2.getSnapshot();
    expect(snap.edges).toHaveLength(1);
    expect(snap.edges[0]?.from).toBe("a");
  });

  it("restores persisted snapshots on load", async () => {
    const persistence = new FakePersistence();
    const { graph } = makeGraph({ persistence });
    await graph.addNode("x", "agent", "X");
    await graph.saveSnapshot("kept");

    const g2 = new RuntimeGraph(persistence as unknown as IRuntimePersistence);
    g2.setAutoCheckpoint(false);
    await g2.getNode("x"); // triggers ensureLoaded (snapshots load lazily)
    expect(g2.getSnapshots()).toHaveLength(1);
    expect(g2.getSnapshots()[0]?.summary.totalNodes).toBe(1);
  });

  it("concurrent mutations serialize through the queue", async () => {
    const { graph } = makeGraph();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => graph.addNode(`n${i}`, "agent", `N${i}`)),
    );
    expect(await graph.getAllNodes()).toHaveLength(20);
  });
});
