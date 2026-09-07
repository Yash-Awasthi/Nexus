// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";

import { getSharedKV } from "../../src/lib/shared-kv.js";
import {
  appendGraphEvent,
  getSessionGraph,
  listSessionGraphs,
} from "../../src/lib/session-graph.js";

// No REDIS_URL / UPSTASH env in tests → getSharedKV() falls back to the
// in-process MemoryKVStore. Clear it before every test so cases are isolated.
beforeEach(async () => {
  await getSharedKV().clear();
});

describe("session-graph", () => {
  it("appends nodes and edges in order with the last-node sentinel", async () => {
    await appendGraphEvent("u1", "research:j1", "research", {
      title: "What is RAG?",
      node: { id: "user", kind: "user", label: "Research query" },
    });
    await appendGraphEvent("u1", "research:j1", "research", {
      node: { id: "phase:planning:start", kind: "phase", label: "Planning" },
      edge: { from: "last", to: "phase:planning:start" },
    });
    await appendGraphEvent("u1", "research:j1", "research", {
      node: { id: "done", kind: "milestone", label: "Research complete" },
      edge: { from: "last", to: "done" },
    });

    const g = await getSessionGraph("u1", "research:j1");
    expect(g).toBeDefined();
    expect(g!.title).toBe("What is RAG?");
    expect(g!.kind).toBe("research");
    expect(g!.nodes.map((n) => n.id)).toEqual(["user", "phase:planning:start", "done"]);
    expect(g!.edges).toEqual([
      { from: "user", to: "phase:planning:start", kind: "next" },
      { from: "phase:planning:start", to: "done", kind: "next" },
    ]);
    // ts is stamped by the store, never by the caller.
    expect(g!.nodes.every((n) => !Number.isNaN(new Date(n.ts).getTime()))).toBe(true);
  });

  it("the first node of a graph never self-links via the last sentinel", async () => {
    // A mission's first event carries an edge from "last" on an empty graph.
    // It must record the node with NO edge (there is no previous node), not a
    // self-edge {from: id, to: id}.
    await appendGraphEvent("u1", "mission:m1", "mission", {
      node: { id: "m1:skill:1:start", kind: "skill", label: "bootstrap" },
      edge: { from: "last", to: "m1:skill:1:start", kind: "skill" },
    });
    const g = await getSessionGraph("u1", "mission:m1");
    expect(g!.nodes).toHaveLength(1);
    expect(g!.edges).toHaveLength(0);
    // A second event still chains to the first.
    await appendGraphEvent("u1", "mission:m1", "mission", {
      node: { id: "m1:phase:started", kind: "phase", label: "started" },
      edge: { from: "last", to: "m1:phase:started", kind: "phase" },
    });
    const g2 = await getSessionGraph("u1", "mission:m1");
    expect(g2!.edges).toEqual([{ from: "m1:skill:1:start", to: "m1:phase:started", kind: "phase" }]);
  });

  it("dedupes by node id — re-appends never duplicate a node", async () => {
    for (let i = 0; i < 3; i++) {
      await appendGraphEvent("u1", "research:j1", "research", {
        node: { id: "user", kind: "user", label: "Research query" },
      });
    }
    const g = await getSessionGraph("u1", "research:j1");
    expect(g!.nodes).toHaveLength(1);
  });

  it("drops dangling edges when the from-node does not exist", async () => {
    await appendGraphEvent("u1", "research:j1", "research", {
      node: { id: "report", kind: "report", label: "Report" },
      edge: { from: "missing", to: "report" },
    });
    const g = await getSessionGraph("u1", "research:j1");
    expect(g!.edges).toHaveLength(0);
  });

  it("isolates sessions per user — cross-user reads are undefined", async () => {
    await appendGraphEvent("u1", "research:j1", "research", {
      node: { id: "user", kind: "user", label: "q" },
    });
    expect(await getSessionGraph("u2", "research:j1")).toBeUndefined();
    const u1 = await listSessionGraphs("u1");
    const u2 = await listSessionGraphs("u2");
    expect(u1).toHaveLength(1);
    expect(u2).toHaveLength(0);
  });

  it("lists newest session first via the id index", async () => {
    await appendGraphEvent("u1", "research:j1", "research", {
      title: "first",
      node: { id: "user", kind: "user", label: "q" },
    });
    await appendGraphEvent("u1", "research:j2", "research", {
      title: "second",
      node: { id: "user", kind: "user", label: "q" },
    });
    const list = await listSessionGraphs("u1");
    expect(list.map((g) => g.sessionId)).toEqual(["research:j2", "research:j1"]);
  });
});
