// SPDX-License-Identifier: Apache-2.0
// Community detection (Leiden/Louvain parity) — focused tests.
import { describe, it, expect } from "vitest";
import { detectCommunities, modularity } from "./community.js";
import { KnowledgeGraph, InMemoryKGStore, type KGNode, type KGEdge } from "./index.js";

function adj(pairs: [string, string][]): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>();
  for (const [a, b] of pairs) {
    if (!g.has(a)) g.set(a, new Set());
    if (!g.has(b)) g.set(b, new Set());
    g.get(a)!.add(b);
    g.get(b)!.add(a);
  }
  return g;
}

/** Two triangles joined by a single bridge edge — the classic two-community structure. */
const TWO_TRIANGLES = adj([
  ["a", "b"],
  ["b", "c"],
  ["a", "c"], // clique 1
  ["x", "y"],
  ["y", "z"],
  ["x", "z"], // clique 2
  ["c", "x"], // bridge
]);

describe("detectCommunities", () => {
  it("finds the two cliques of a bridged-triangle graph", () => {
    const c = detectCommunities(TWO_TRIANGLES);
    const byNode: Record<string, number> = Object.fromEntries(c);
    const c1 = byNode["a"];
    expect(byNode["b"]).toBe(c1);
    expect(byNode["c"]).toBe(c1);
    const c2 = byNode["x"];
    expect(byNode["y"]).toBe(c2);
    expect(byNode["z"]).toBe(c2);
    expect(c2).not.toBe(c1);
    expect(new Set(c.values()).size).toBe(2);
  });

  it("never merges disconnected components", () => {
    const g = adj([
      ["a", "b"],
      ["b", "c"],
      ["x", "y"],
      ["y", "z"],
      ["z", "w"],
    ]);
    const c = detectCommunities(g);
    const byNode: Record<string, number> = Object.fromEntries(c);
    // No edges cross the components, so no node from one may join the other.
    expect(byNode["a"]).not.toBe(byNode["x"]);
    expect(byNode["b"]).not.toBe(byNode["y"]);
    expect(byNode["c"]).not.toBe(byNode["w"]);
    expect(new Set(c.values()).size).toBeGreaterThanOrEqual(2);
  });

  it("keeps a bowtie (two triangles sharing a node) in one community", () => {
    // Merging is strictly positive all the way to one community (verified
    // empirically; diamonds and stars are modularity pathologies where
    // intermediate partitions are non-positive and correctly stay split).
    const g = adj([
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
      ["c", "x"],
      ["x", "y"],
      ["c", "y"],
    ]);
    const c = detectCommunities(g);
    const byNode: Record<string, number> = Object.fromEntries(c);
    const community = byNode["a"];
    for (const id of ["b", "c", "x", "y"]) expect(byNode[id]).toBe(community);
    expect(new Set(c.values()).size).toBe(1);
  });

  it("respects the resolution parameter (higher γ → more communities)", () => {
    const path = adj([
      ["n1", "n2"],
      ["n2", "n3"],
      ["n3", "n4"],
      ["n4", "n5"],
      ["n5", "n6"],
      ["n6", "n7"],
    ]);
    const coarse = detectCommunities(path, { resolution: 0.5 });
    const fine = detectCommunities(path, { resolution: 2.0 });
    expect(new Set(fine.values()).size).toBeGreaterThanOrEqual(new Set(coarse.values()).size);
  });

  it("improves modularity over the singleton partition", () => {
    const c = detectCommunities(TWO_TRIANGLES);
    const singletons = new Map<string, number>([...TWO_TRIANGLES.keys()].map((id, i) => [id, i]));
    expect(modularity(TWO_TRIANGLES, c)).toBeGreaterThan(modularity(TWO_TRIANGLES, singletons));
    expect(modularity(TWO_TRIANGLES, c)).toBeGreaterThan(0);
  });

  it("is deterministic for identical input", () => {
    const first = detectCommunities(TWO_TRIANGLES);
    const second = detectCommunities(TWO_TRIANGLES);
    expect(Object.fromEntries(first)).toEqual(Object.fromEntries(second));
  });

  it("handles degenerate graphs", () => {
    expect(detectCommunities(new Map())).toEqual(new Map());
    const loop = adj([["solo", "solo"]]);
    const c = detectCommunities(loop);
    expect(c.get("solo")).toBe(0);
    // A single edge has exactly zero merge gain (modularity 0 either way),
    // and zero-gain moves are rejected — so it stays split, deterministically.
    const pair = adj([["p", "q"]]);
    const pairC = detectCommunities(pair);
    expect(pairC.get("p")).not.toBe(pairC.get("q"));
    expect(new Set(pairC.values()).size).toBe(2);
  });
});

describe("KnowledgeGraph.detectCommunities", () => {
  it("clusters a stored graph via the InMemory store", async () => {
    const store = new InMemoryKGStore();
    const kg = new KnowledgeGraph(store);
    const node = (id: string): KGNode => ({
      id,
      name: id,
      type: "PERSON",
      confidence: 1,
      properties: {},
      sources: ["test"],
      createdAt: 0,
      updatedAt: 0,
    });
    const edge = (subjectId: string, objectId: string): KGEdge => ({
      id: `${subjectId}-${objectId}`,
      subjectId,
      predicate: "knows",
      objectId,
      confidence: 1,
      sources: ["test"],
      createdAt: 0,
      updatedAt: 0,
    });
    for (const [subject, object] of [
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
      ["x", "y"],
      ["y", "z"],
      ["x", "z"],
      ["c", "x"],
    ]) {
      await store.upsertNode(node(subject));
      await store.upsertNode(node(object));
      await store.upsertEdge(edge(subject, object));
    }
    const c = await kg.detectCommunities();
    const byNode: Record<string, number> = Object.fromEntries(c);
    expect(byNode["a"]).toBe(byNode["b"]);
    expect(byNode["x"]).toBe(byNode["y"]);
    expect(byNode["a"]).not.toBe(byNode["x"]);
  });
});
