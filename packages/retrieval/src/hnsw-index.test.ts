// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { BFIndex, HNSWIndex, makeDistance, type HnswSpace } from "./hnsw-index.js";

/** Deterministic pseudo-random vectors (mulberry32) so tests are stable. */
function seededVectors(count: number, dim: number, seed = 7): number[][] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => Array.from({ length: dim }, () => rnd() * 2 - 1));
}

function labelsOf(count: number, start = 0): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

function assertSameSet(a: number[], b: number[]): void {
  expect([...a].sort((x, y) => x - y)).toEqual([...b].sort((x, y) => x - y));
}

function recallFraction(
  index: HNSWIndex,
  vectors: number[][],
  queries: number[][],
  k: number,
  exact: BFIndex,
): number {
  let hits = 0;
  for (const q of queries) {
    const got = new Set(index.searchKnn(q, k).map((h) => h.label));
    const want = new Set(exact.searchKnn(q, k).map((h) => h.label));
    for (const l of want) if (got.has(l)) hits++;
  }
  return hits / (queries.length * k);
}

describe("hnsw-index distance spaces", () => {
  it("l2 is squared euclidean (hnswlib L2Sqr convention)", () => {
    const d = makeDistance("l2");
    expect(d([0, 0], [3, 4])).toBe(25); // 3² + 4², no sqrt
  });

  it("cosine ignores magnitude (hnswlib normalizes then 1 − dot)", () => {
    const d = makeDistance("cosine");
    expect(d([1, 0], [0, 1])).toBeCloseTo(1);
    expect(d([2, 0], [3, 0])).toBeCloseTo(0);
  });

  it("ip is 1 − inner product (hnswlib InnerProductDistance)", () => {
    const d = makeDistance("ip");
    expect(d([1, 2], [3, 4])).toBeCloseTo(1 - (3 + 8));
  });
});

describe("BFIndex (hnswlib bruteforce reference)", () => {
  const vectors = seededVectors(30, 8);
  const bf = new BFIndex("l2", 8);
  bf.addItems(vectors, labelsOf(30));

  it("returns the exact top-k for l2", () => {
    const hits = bf.searchKnn([0.1, -0.2, 0.3, 0, 0.5, -0.1, 0.2, -0.4], 5);
    expect(hits).toHaveLength(5);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].distance).toBeGreaterThanOrEqual(hits[i - 1].distance);
    }
    // Brute force of the brute force: identical result to a manual scan.
    const manual = vectors
      .map((v, i) => ({
        label: i,
        distance: makeDistance("l2")([0.1, -0.2, 0.3, 0, 0.5, -0.1, 0.2, -0.4], v),
      }))
      .sort((a, b) => a.distance - b.distance || a.label - b.label)
      .slice(0, 5)
      .map((h) => h.label);
    assertSameSet(
      hits.map((h) => h.label),
      manual,
    );
  });

  it("honors the label filter", () => {
    const hits = bf.searchKnn(seededVectors(1, 8)[0], 10, (l) => l % 2 === 0);
    expect(hits.every((h) => h.label % 2 === 0)).toBe(true);
    expect(hits.length).toBeLessThanOrEqual(15);
  });
});

describe("HNSWIndex matches the brute-force reference", () => {
  it("top-k sets agree with BFIndex across l2/cosine/ip", () => {
    for (const space of ["l2", "cosine", "ip"] as HnswSpace[]) {
      const n = 250;
      const dim = 12;
      const vectors = seededVectors(n, dim, space.length * 100 + 3);
      const index = new HNSWIndex(space, dim);
      index.initIndex(n + 10, { M: 16, efConstruction: 200, randomSeed: 11 });
      index.addItems(vectors, labelsOf(n));
      index.setEf(120);
      const exact = new BFIndex(space, dim);
      exact.addItems(vectors, labelsOf(n));
      const queries = seededVectors(10, dim, 999);
      const recall = recallFraction(index, vectors, queries, 5, exact);
      expect(recall).toBe(1);
    }
  });

  it("deterministic: same seed + same insert order rebuilds an identical index", () => {
    const build = () => {
      const vectors = seededVectors(120, 8, 42);
      const index = new HNSWIndex("l2", 8);
      index.initIndex(200, { M: 12, efConstruction: 100, randomSeed: 5 });
      index.addItems(vectors, labelsOf(120));
      return index;
    };
    const a = build();
    const b = build();
    for (const q of seededVectors(8, 8, 77)) {
      const aLabels = a.searchKnn(q, 8).map((h) => h.label);
      const bLabels = b.searchKnn(q, 8).map((h) => h.label);
      expect([...aLabels].sort((x, y) => x - y)).toEqual([...bLabels].sort((x, y) => x - y));
    }
  });

  it("upsert: re-adding a label moves it next to its new vector", () => {
    const index = new HNSWIndex("l2", 4);
    index.initIndex(100, { M: 16, efConstruction: 100 });
    const data = [
      [1, 0, 0, 0],
      [0.95, 0.1, 0, 0],
      [0, 1, 0, 0],
      [-1, 0, 0, 0],
    ];
    index.addItems(data, [10, 20, 30, 40]);
    index.setEf(50);
    // Relocate label 20 from near 10 to near 30.
    index.addItems([[0.05, 0.99, 0, 0]], [20]);
    const top = index.searchKnn([0, 1, 0, 0], 3).map((h) => h.label);
    expect(top[0]).toBe(30);
    expect(top).toContain(20);
  });

  it("markDeleted removes a label from results; unmarkDeleted restores it", () => {
    const n = 60;
    const vectors = seededVectors(n, 6, 3);
    const index = new HNSWIndex("l2", 6);
    index.initIndex(100, { efConstruction: 200 });
    index.addItems(vectors, labelsOf(n));
    index.setEf(100);
    const q = vectors[0]; // exact stored vector ⇒ label 0 is the nearest neighbor
    expect(index.searchKnn(q, 5).map((h) => h.label)).toContain(0);
    index.markDeleted(0);
    expect(index.searchKnn(q, 5).map((h) => h.label)).not.toContain(0);
    index.unmarkDeleted(0);
    expect(index.searchKnn(q, 5).map((h) => h.label)).toContain(0);
  });

  it("searchKnn supports a label filter and batch queries", () => {
    const n = 80;
    const vectors = seededVectors(n, 6, 21);
    const index = new HNSWIndex("l2", 6);
    index.initIndex(100, { efConstruction: 150 });
    index.addItems(vectors, labelsOf(n));
    index.setEf(80);
    const q = seededVectors(1, 6, 22)[0];
    const even = index.searchKnn(q, 10, (l) => l % 2 === 0);
    expect(even.length).toBeGreaterThan(0);
    expect(even.every((h) => h.label % 2 === 0)).toBe(true);
    const batch = index.searchKnnBatch([q, seededVectors(1, 6, 23)[0]], 5);
    expect(batch).toHaveLength(2);
    expect(batch[0]).toHaveLength(5);
  });

  it("capacity: addItems past maxElements throws; resizeIndex raises it", () => {
    const index = new HNSWIndex("l2", 2);
    index.initIndex(5);
    index.addItems(
      [
        [1, 0],
        [0, 1],
        [0.5, 0.5],
        [1, 1],
        [0, 0],
      ],
      [0, 1, 2, 3, 4],
    );
    expect(() => index.addItems([[2, 2]], [5])).toThrow(/full/);
    index.resizeIndex(10);
    expect(() => index.addItems([[2, 2]], [5])).not.toThrow();
    expect(index.currentCount).toBe(6);
    expect(index.capacity).toBe(10);
  });

  it("mass deletion (33%): no deleted label ever leaks; recall still 1.0", () => {
    // Pins the behavior measured for the module header: deletions are marks
    // without graph repair (upstream hnswlib semantics) — the invariant is
    // that a deleted label can never appear in results.
    const n = 800;
    const dim = 16;
    const vectors = seededVectors(n, dim, 99);
    const index = new HNSWIndex("l2", dim);
    index.initIndex(n + 10, { M: 16, efConstruction: 200, randomSeed: 3 });
    index.addItems(vectors, labelsOf(n));
    index.setEf(100);
    const exact = new BFIndex("l2", dim);
    exact.addItems(vectors, labelsOf(n));
    const queries = seededVectors(25, dim, 77);
    const delCount = Math.round(0.33 * n);
    for (let i = 0; i < delCount; i++) index.markDeleted(i);
    let hits = 0;
    for (const q of queries) {
      const got = index.searchKnn(q, 10);
      expect(got.every((h) => h.label >= delCount)).toBe(true); // never leak
      const want = exact.searchKnn(q, 10, (l) => l >= delCount).map((h) => h.label);
      for (const h of got) if (want.includes(h.label)) hits++;
    }
    expect(hits / (queries.length * 10)).toBe(1); // recall unaffected at 33%
  });

  it("extreme deletion (90%): still no leak; fragmenting recall recovers with higher ef", () => {
    const n = 800;
    const dim = 16;
    const vectors = seededVectors(n, dim, 99);
    const index = new HNSWIndex("l2", dim);
    index.initIndex(n + 10, { M: 16, efConstruction: 200, randomSeed: 3 });
    index.addItems(vectors, labelsOf(n));
    const exact = new BFIndex("l2", dim);
    exact.addItems(vectors, labelsOf(n));
    const queries = seededVectors(25, dim, 876);
    const delCount = Math.round(0.9 * n);
    for (let i = 0; i < delCount; i++) index.markDeleted(i);
    const recallAt = (ef: number): number => {
      index.setEf(ef);
      let hits = 0;
      for (const q of queries) {
        const got = index.searchKnn(q, 10);
        expect(got.every((h) => h.label >= delCount)).toBe(true); // never leak
        const want = exact.searchKnn(q, 10, (l) => l >= delCount).map((h) => h.label);
        for (const h of got) if (want.includes(h.label)) hits++;
      }
      return hits / (queries.length * 10);
    };
    expect(recallAt(100)).toBeGreaterThanOrEqual(0.8); // degraded, not broken
    expect(recallAt(200)).toBe(1); // ef bump restores full recall
  });

  it("approximation still holds recall at larger scale", () => {
    const n = 1500;
    const dim = 16;
    const vectors = seededVectors(n, dim, 31337);
    const index = new HNSWIndex("cosine", dim);
    index.initIndex(n + 100, { M: 16, efConstruction: 200, randomSeed: 1 });
    index.addItems(vectors, labelsOf(n));
    index.setEf(60);
    const exact = new BFIndex("cosine", dim);
    exact.addItems(vectors, labelsOf(n));
    const queries = seededVectors(15, dim, 555);
    const recall = recallFraction(index, vectors, queries, 10, exact);
    expect(recall).toBeGreaterThanOrEqual(0.95);
  });
});
