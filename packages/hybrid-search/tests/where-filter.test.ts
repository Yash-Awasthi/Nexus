// SPDX-License-Identifier: Apache-2.0
// Hybrid single-query where-filter seam (weaviate/pgvectorscale parity, pass 51):
// HybridSearchEngine now accepts chroma/weaviate-grammar `where`/`whereDocument`
// clauses (pass-50 @nexus/retrieval vocabulary) and filters each leg's
// candidates BEFORE fusion. These tests pin the filter seam across both fusion
// modes, the chroma missing-key semantics, and the legacy no-filter path.
import { describe, it, expect } from "vitest";
import {
  HybridSearchEngine,
  InMemoryBM25,
  type VectorSearchAdapter,
  type SearchHit,
} from "../src/index.js";

interface Doc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

// One shared document universe so dense + sparse legs both index the same four
// docs; the dense adapter ranks by fixed priority (a first), BM25 scores text.
const DOCS: Doc[] = [
  {
    id: "a",
    text: "token refresh authentication session",
    metadata: { tenant: "acme", env: "prod", tags: ["auth", "core"], priority: 1 },
  },
  {
    id: "b",
    text: "token refresh authentication session",
    metadata: { tenant: "globex", env: "prod", tags: ["auth"], priority: 2 },
  },
  {
    id: "c",
    text: "billing invoice totals monthly",
    metadata: { tenant: "acme", env: "dev", tags: ["billing"], priority: 3 },
  },
  // d deliberately has NO tenant key (chroma $ne/$nin/$not_contains match missing keys)
  {
    id: "d",
    text: "onboarding guide welcome screens",
    metadata: { env: "dev", tags: ["docs"], priority: 4 },
  },
];

class PriorityDense implements VectorSearchAdapter {
  constructor(private readonly docs: Doc[]) {}
  async search(query: string, limit: number): Promise<SearchHit[]> {
    return this.docs.slice(0, limit).map((d, i) => ({
      id: d.id,
      score: 1 - i * 0.01,
      text: d.text,
      metadata: d.metadata,
    }));
  }
}

function makeEngine(): HybridSearchEngine {
  const bm25 = new InMemoryBM25();
  bm25.index(DOCS.map((d) => ({ id: d.id, text: d.text, metadata: d.metadata })));
  return new HybridSearchEngine(new PriorityDense(DOCS), bm25);
}

const ids = (hits: SearchHit[]): string[] => hits.map((h) => h.id);

describe("HybridSearchEngine single-query where filter (rrf)", () => {
  it("$eq where restricts both legs before fusion", async () => {
    const r = await makeEngine().search({ query: "token refresh", where: { tenant: "acme" } });
    const got = ids(r.hits);
    expect(got).toEqual(expect.arrayContaining(["a", "c"]));
    expect(got).not.toContain("b"); // globex
    expect(got).not.toContain("d"); // missing tenant key fails $eq
  });

  it("$ne where matches missing keys (chroma semantics)", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      where: { tenant: { $ne: "acme" } },
    });
    const got = ids(r.hits);
    expect(got).toEqual(expect.arrayContaining(["b", "d"]));
    expect(got).not.toContain("a");
    expect(got).not.toContain("c");
  });

  it("$and/$or composition narrows correctly", async () => {
    const and = await makeEngine().search({
      query: "token refresh",
      where: { $and: [{ tenant: { $ne: "globex" } }, { env: "prod" }] },
    });
    expect(ids(and.hits)).toEqual(["a"]);

    const or = await makeEngine().search({
      query: "token refresh",
      where: { $or: [{ tenant: "globex" }, { env: "dev" }] },
    });
    const got = ids(or.hits);
    expect(got).toEqual(expect.arrayContaining(["b", "c", "d"]));
    expect(got).not.toContain("a");
  });

  it("metadata $contains is array membership", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      where: { tags: { $contains: "auth" } },
    });
    const got = ids(r.hits);
    expect(got).toEqual(expect.arrayContaining(["a", "b"]));
    expect(got).not.toContain("c");
    expect(got).not.toContain("d");
  });

  it("$in accepts a like-typed list and excludes missing keys", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      where: { tenant: { $in: ["acme", "globex"] } },
    });
    const got = ids(r.hits);
    expect(got).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(got).not.toContain("d");
  });

  it("numeric comparison operators are range-correct", async () => {
    const gte = await makeEngine().search({
      query: "token refresh",
      where: { priority: { $gte: 3 } },
    });
    expect(ids(gte.hits).sort()).toEqual(["c", "d"]);
    const lt = await makeEngine().search({
      query: "token refresh",
      where: { priority: { $lt: 2 } },
    });
    expect(ids(lt.hits)).toEqual(["a"]);
    const eq = await makeEngine().search({ query: "token refresh", where: { priority: 2 } });
    expect(ids(eq.hits)).toEqual(["b"]);
  });

  it("one-sided leg survives when the other is filtered empty", async () => {
    const r = await makeEngine().search({ query: "token refresh", where: { env: "prod" } });
    const got = ids(r.hits);
    // a + b carry env prod in BOTH legs — fused result is exactly those two
    expect(got.sort()).toEqual(["a", "b"]);
  });

  it("returns no hits when the filter matches nothing", async () => {
    const r = await makeEngine().search({ query: "token refresh", where: { tenant: "ghost" } });
    expect(r.hits).toEqual([]);
    expect(r.vectorHits).toEqual([]);
    expect(r.bm25Hits).toEqual([]);
  });
});

describe("HybridSearchEngine single-query document filter", () => {
  it("whereDocument $contains filters on text across legs", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      whereDocument: { $contains: "billing" },
    });
    expect(ids(r.hits)).toEqual(["c"]);
  });

  it("whereDocument $not_contains on the empty/unmatched side", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      whereDocument: { $not_contains: "token" },
    });
    const got = ids(r.hits);
    expect(got).toEqual(expect.arrayContaining(["c", "d"]));
    expect(got).not.toContain("a");
    expect(got).not.toContain("b");
  });

  it("combines where + whereDocument", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      where: { tenant: "acme" },
      whereDocument: { $contains: "billing" },
    });
    expect(ids(r.hits)).toEqual(["c"]);
  });

  it("leg result arrays reflect the filter", async () => {
    const r = await makeEngine().search({ query: "token refresh", where: { tenant: "acme" } });
    expect(ids(r.vectorHits).sort()).toEqual(["a", "c"]);
    expect(ids(r.bm25Hits).sort()).toEqual(["a", "c"]);
  });
});

describe("HybridSearchEngine where filter across fusion modes", () => {
  it("alpha fusion honors where", async () => {
    const r = await makeEngine().search({
      query: "token refresh",
      fusion: "alpha",
      where: { tenant: "acme" },
    });
    const got = ids(r.hits);
    expect(got).toEqual(expect.arrayContaining(["a", "c"]));
    expect(got).not.toContain("b");
    expect(got).not.toContain("d");
  });

  it("legacy no-filter path is unchanged", async () => {
    const r = await makeEngine().search({ query: "token refresh" });
    expect(r.hits).toHaveLength(4);
    expect(r.hits[0]!.id).toBe("a"); // present in both legs → highest RRF score
    expect(ids(r.hits).sort()).toEqual(["a", "b", "c", "d"]);
  });
});
