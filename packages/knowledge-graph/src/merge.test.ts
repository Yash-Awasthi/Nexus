// SPDX-License-Identifier: Apache-2.0
/**
 * The merge is only useful if it is a real join. These assert the three CRDT
 * laws directly — commutative, associative, idempotent — because that is what
 * lets two peers exchange snapshots in any order and end up equal.
 */
import { describe, it, expect } from "vitest";

import { InMemoryKGStore, type KGEdge, type KGNode } from "./index.js";
import {
  mergeEdge,
  mergeNode,
  mergeSnapshots,
  removeNodeProperty,
  type KGSnapshot,
} from "./merge.js";

function node(over: Partial<KGNode> = {}): KGNode {
  return {
    id: "n1",
    name: "Acme Corp",
    type: "ORG",
    confidence: 0.5,
    properties: {},
    sources: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

function edge(over: Partial<KGEdge> = {}): KGEdge {
  return {
    id: "e1",
    subjectId: "n1",
    predicate: "works at",
    objectId: "n2",
    confidence: 0.5,
    sources: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

describe("mergeNode", () => {
  const a = node({
    confidence: 0.9,
    sources: ["doc-b", "doc-a"],
    properties: { sector: "mining", staff: 10 },
    createdAt: 500,
    updatedAt: 2_000,
  });
  const b = node({
    confidence: 0.4,
    sources: ["doc-c"],
    properties: { staff: 40, country: "AU" },
    createdAt: 900,
    updatedAt: 3_000,
  });

  it("takes the strongest confidence, the union of sources, and the outer time bounds", () => {
    const m = mergeNode(a, b);

    expect(m.confidence).toBe(0.9);
    expect(m.sources).toEqual(["doc-a", "doc-b", "doc-c"]);
    expect(m.createdAt).toBe(500);
    expect(m.updatedAt).toBe(3_000);
  });

  it("settles a contested property on the later write and keeps the rest", () => {
    const m = mergeNode(a, b);

    expect(m.properties).toEqual({ sector: "mining", staff: 40, country: "AU" });
  });

  it("is commutative", () => {
    expect(mergeNode(a, b)).toEqual(mergeNode(b, a));
  });

  it("is associative", () => {
    const c = node({ confidence: 0.6, sources: ["doc-d"], updatedAt: 2_500 });

    expect(mergeNode(mergeNode(a, b), c)).toEqual(mergeNode(a, mergeNode(b, c)));
  });

  it("is idempotent", () => {
    const m = mergeNode(a, b);

    expect(mergeNode(m, m)).toEqual(m);
    expect(mergeNode(m, a)).toEqual(m);
  });

  it("breaks a same-millisecond tie the same way whichever side asks", () => {
    const x = node({ properties: { staff: 10 }, updatedAt: 5_000 });
    const y = node({ properties: { staff: 40 }, updatedAt: 5_000 });

    expect(mergeNode(x, y).properties).toEqual(mergeNode(y, x).properties);
  });

  it("refuses to merge two different nodes", () => {
    expect(() => mergeNode(node({ id: "n1" }), node({ id: "n2" }))).toThrow(/different nodes/);
  });
});

describe("mergeEdge", () => {
  it("is commutative and takes the union of sources", () => {
    const a = edge({ confidence: 0.3, sources: ["doc-a"], createdAt: 400 });
    const b = edge({ confidence: 0.8, sources: ["doc-b"], updatedAt: 9_000 });

    expect(mergeEdge(a, b)).toEqual(mergeEdge(b, a));
    expect(mergeEdge(a, b)).toMatchObject({
      confidence: 0.8,
      sources: ["doc-a", "doc-b"],
      createdAt: 400,
      updatedAt: 9_000,
    });
  });
});

describe("mergeSnapshots", () => {
  const peerA: KGSnapshot = {
    nodes: [node({ id: "n1", sources: ["a"] }), node({ id: "n2", name: "Alice", type: "PERSON" })],
    edges: [edge({ id: "e1", sources: ["a"] })],
  };
  const peerB: KGSnapshot = {
    nodes: [node({ id: "n1", sources: ["b"], confidence: 0.99 }), node({ id: "n3", name: "Bob" })],
    edges: [edge({ id: "e2", predicate: "knows" })],
  };

  it("converges: both peers hold the same graph after one exchange", () => {
    expect(mergeSnapshots(peerA, peerB)).toEqual(mergeSnapshots(peerB, peerA));
  });

  it("keeps every distinct fact and joins the shared ones", () => {
    const m = mergeSnapshots(peerA, peerB);

    expect(m.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(m.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(m.nodes[0]!.sources).toEqual(["a", "b"]);
    expect(m.nodes[0]!.confidence).toBe(0.99);
  });

  it("re-applying a peer's snapshot changes nothing", () => {
    const once = mergeSnapshots(peerA, peerB);

    expect(mergeSnapshots(once, peerB)).toEqual(once);
  });
});

describe("InMemoryKGStore.upsert", () => {
  it("no longer depends on the order the same two facts arrive in", async () => {
    const early = node({ properties: { staff: 10 }, createdAt: 500, updatedAt: 1_000 });
    const late = node({ properties: { staff: 40 }, createdAt: 900, updatedAt: 2_000 });

    const forward = new InMemoryKGStore();
    await forward.upsertNode(early);
    await forward.upsertNode(late);

    const backward = new InMemoryKGStore();
    await backward.upsertNode(late);
    await backward.upsertNode(early);

    expect(await forward.getNode("n1")).toEqual(await backward.getNode("n1"));
    expect((await forward.getNode("n1"))!.createdAt).toBe(500);
  });
});

describe("property tombstones", () => {
  const base = node({ properties: { sector: "mining", staff: 10 }, updatedAt: 1_000 });
  /** The peer that never heard about the delete and still carries the value. */
  const stale = node({ properties: { sector: "mining", staff: 10 }, updatedAt: 1_000 });

  it("keeps a deleted property deleted when a stale peer still has it", () => {
    const deleted = removeNodeProperty(base, "sector", 2_000);

    expect(mergeNode(deleted, stale).properties).toEqual({ staff: 10 });
    expect(mergeNode(stale, deleted).properties).toEqual({ staff: 10 });
  });

  it("lets a later write bring the property back", () => {
    const deleted = removeNodeProperty(base, "sector", 2_000);
    const rewritten = node({
      properties: { sector: "energy" },
      propertyClocks: { sector: 3_000 },
      updatedAt: 3_000,
    });

    expect(mergeNode(deleted, rewritten).properties.sector).toBe("energy");
  });

  it("gives the delete the same-clock tie so a concurrent write cannot undo it", () => {
    const deleted = removeNodeProperty(base, "sector", 2_000);
    const written = node({
      properties: { sector: "energy" },
      propertyClocks: { sector: 2_000 },
      updatedAt: 2_000,
    });

    expect(mergeNode(deleted, written).properties).toEqual(mergeNode(written, deleted).properties);
    expect(mergeNode(deleted, written).properties.sector).toBeUndefined();
  });

  it("does not treat a key a peer never saw as a delete", () => {
    const withKey = node({ properties: { staff: 10 }, updatedAt: 5_000 });
    const without = node({ properties: {}, updatedAt: 9_000 });

    expect(mergeNode(withKey, without).properties).toEqual({ staff: 10 });
  });

  it("carries the tombstone through a snapshot exchange, in both directions", () => {
    const deleted = removeNodeProperty(base, "sector", 2_000);
    const mine: KGSnapshot = { nodes: [deleted], edges: [] };
    const theirs: KGSnapshot = { nodes: [stale], edges: [] };

    expect(mergeSnapshots(mine, theirs)).toEqual(mergeSnapshots(theirs, mine));
    expect(mergeSnapshots(mine, theirs).nodes[0]!.properties).toEqual({ staff: 10 });
  });

  it("stays a join once tombstones are in play", () => {
    const deleted = removeNodeProperty(base, "sector", 2_000);
    const other = node({ properties: { country: "AU" }, updatedAt: 2_500 });

    expect(mergeNode(mergeNode(deleted, stale), other)).toEqual(
      mergeNode(deleted, mergeNode(stale, other)),
    );
    const m = mergeNode(deleted, stale);
    expect(mergeNode(m, m)).toEqual(m);
  });
});

describe("InMemoryKGStore with tombstones", () => {
  it("does not resurrect a deleted property when the stale peer upserts after it", async () => {
    const store = new InMemoryKGStore();
    const original = node({ properties: { sector: "mining" }, updatedAt: 1_000 });

    await store.upsertNode(removeNodeProperty(original, "sector", 2_000));
    await store.upsertNode(original);

    expect((await store.getNode("n1"))!.properties).toEqual({});
  });
});
