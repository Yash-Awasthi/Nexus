// SPDX-License-Identifier: Apache-2.0
/**
 * Weighted-alpha fusion (Timescale weighted-hybrid pattern) — focused tests.
 * All expectations are hand-computed from the documented formula
 * `score = alpha × maxNorm(dense) + (1 − alpha) × maxNorm(sparse)`.
 */
import { describe, expect, it } from "vitest";
import {
  HybridSearchEngine,
  weightedAlphaFusion,
  type HybridSearchResult,
  type SearchHit,
  type VectorSearchAdapter,
} from "../src/index.js";

const hit = (id: string, score: number, text = ""): SearchHit => ({ id, score, text });

describe("weightedAlphaFusion", () => {
  const dense = [hit("d1", 0.9, "dense text"), hit("d2", 0.5, "d2 dense text")];
  const sparse = [hit("d2", 0.8, "sparse text"), hit("d3", 0.4, "sparse text")];

  it("blends max-normalized scores at alpha 0.5 and sorts descending", () => {
    // normDense: d1 = 1, d2 = 5/9 · normSparse: d2 = 1, d3 = 0.5
    // d1 = 0.5, d2 = 0.5·5/9 + 0.5 = 7/9, d3 = 0.25
    const r = weightedAlphaFusion(dense, sparse, { alpha: 0.5 });
    expect(r.map((h) => h.id)).toEqual(["d2", "d1", "d3"]);
    expect(r[0]!.score).toBeCloseTo(7 / 9);
    expect(r[1]!.score).toBeCloseTo(0.5);
    expect(r[2]!.score).toBeCloseTo(0.25);
  });

  it("shifts toward the dense side as alpha rises", () => {
    const denseBias = weightedAlphaFusion(dense, sparse, { alpha: 0.8 });
    // d1 = 0.8 · d2 = 0.8·5/9 + 0.2 = 0.6444 → d1 leads
    expect(denseBias[0]!.id).toBe("d1");

    const pureDense = weightedAlphaFusion(dense, sparse, { alpha: 1 });
    expect(pureDense.map((h) => h.id)).toEqual(["d1", "d2", "d3"]); // d3 (sparse-only) scores 0
    expect(pureDense[2]!.id).toBe("d3"); // present-only docs are kept, not dropped
    expect(pureDense[2]!.score).toBeCloseTo(0);
  });

  it("keeps documents present in only one list", () => {
    const r = weightedAlphaFusion(dense, sparse, { alpha: 0.5 });
    expect(r.map((h) => h.id).sort()).toEqual(["d1", "d2", "d3"]);
  });

  it("normalization matters when list scales differ wildly", () => {
    const bigSparseDense = [hit("A", 0.9), hit("B", 0.1)];
    const bigSparse = [hit("B", 1000), hit("C", 999)];
    // max-normalized: B = 0.5·0.111 + 0.5 = 0.556 tops; C ≈ 0.5; A = 0.5.
    const normalized = weightedAlphaFusion(bigSparseDense, bigSparse, { alpha: 0.5 });
    expect(normalized[0]!.id).toBe("B");
    expect(normalized[2]!.id).toBe("C");
    // raw scores: B = 0.05 + 500 dominates; C = 499.5; A = 0.45 sinks to last.
    const raw = weightedAlphaFusion(bigSparseDense, bigSparse, {
      alpha: 0.5,
      normalize: "none",
    });
    expect(raw.map((h) => h.id)).toEqual(["B", "C", "A"]);
  });

  it("prefers the dense hit's metadata on duplicates", () => {
    const r = weightedAlphaFusion(dense, sparse, { alpha: 0.5 });
    expect(r.find((h) => h.id === "d2")!.text).toBe("d2 dense text"); // both sides have d2
    expect(r.find((h) => h.id === "d3")!.text).toBe("sparse text"); // d3 sparse-only
    const both = weightedAlphaFusion([hit("x", 1, "dense")], [hit("x", 0.9, "sparse")]);
    expect(both[0]!.text).toBe("dense");
  });
});

describe("HybridSearchEngine fusion modes", () => {
  const vector: VectorSearchAdapter = {
    search: async () => [hit("v1", 0.9), hit("v2", 0.5)],
  };
  const bm25 = {
    search: async () => [hit("v2", 0.8), hit("k1", 0.4)],
  };

  it("uses alpha-weighted fusion when fusion: 'alpha'", async () => {
    const engine = new HybridSearchEngine(vector, bm25);
    const res = await engine.search({
      query: "q",
      limit: 10,
      fusion: "alpha",
      vectorWeight: 1, // pure dense: order v1, v2, k1(last, score 0)
    });
    expect(res.hits.map((h) => h.id)).toEqual(["v1", "v2", "k1"]);
  });

  it("defaults to RRF (unchanged behavior)", async () => {
    const engine = new HybridSearchEngine(vector, bm25);
    const res: HybridSearchResult = await engine.search({ query: "q", limit: 10 });
    // v2 appears in both lists → boosted above v1 under RRF.
    expect(res.hits[0]!.id).toBe("v2");
  });
});
