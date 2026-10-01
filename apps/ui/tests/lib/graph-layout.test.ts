// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { layoutGraph } from "~/lib/graph-layout";

const dist = (p: Float32Array, a: number, b: number) =>
  Math.hypot(p[a * 3]! - p[b * 3]!, p[a * 3 + 1]! - p[b * 3 + 1]!, p[a * 3 + 2]! - p[b * 3 + 2]!);

describe("layoutGraph", () => {
  it("gives every node finite coordinates, and none of them share a spot", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
    const edges = ids.slice(1).map((id, i) => ({ subjectId: ids[i]!, objectId: id }));
    const p = layoutGraph(ids, edges);
    expect(p.length).toBe(90);
    expect([...p].every(Number.isFinite)).toBe(true);
    for (let a = 0; a < 30; a++)
      for (let b = a + 1; b < 30; b++) expect(dist(p, a, b)).toBeGreaterThan(0.05);
  });

  it("pulls linked nodes closer than unlinked ones", () => {
    // Two triangles with no link between them.
    const ids = ["a", "b", "c", "x", "y", "z"];
    const edges = [
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
      ["x", "y"],
      ["y", "z"],
      ["x", "z"],
    ].map(([subjectId, objectId]) => ({ subjectId: subjectId!, objectId: objectId! }));
    const p = layoutGraph(ids, edges);
    const within =
      (dist(p, 0, 1) +
        dist(p, 1, 2) +
        dist(p, 0, 2) +
        dist(p, 3, 4) +
        dist(p, 4, 5) +
        dist(p, 3, 5)) /
      6;
    const across = [0, 1, 2].flatMap((i) => [3, 4, 5].map((j) => dist(p, i, j)));
    expect(within).toBeLessThan(across.reduce((s, d) => s + d, 0) / across.length);
  });

  it("settles into the same shape every time and copes with no nodes", () => {
    const ids = ["a", "b", "c"];
    const edges = [{ subjectId: "a", objectId: "b" }];
    expect([...layoutGraph(ids, edges)]).toEqual([...layoutGraph(ids, edges)]);
    expect(layoutGraph([], []).length).toBe(0);
  });

  it("ignores edges to nodes that are not drawn", () => {
    const p = layoutGraph(["a", "b"], [{ subjectId: "a", objectId: "ghost" }]);
    expect([...p].every(Number.isFinite)).toBe(true);
  });
});
