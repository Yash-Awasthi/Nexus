// SPDX-License-Identifier: Apache-2.0
// Chroma-shaped collection facade (pass 76, row 60): add/query/get/count/delete
// over the retrieval store + embedder with chroma's include projection and
// parallel-array query envelope. The FixedRagtimeEmbedder keeps vectors
// deterministic: docs are space-free with disjoint letter buckets (a/b vs c/d
// vs a/c), so ordering and distance assertions are exact (space-free matters —
// a space char would bucket into a shared slot and break orthogonality).
import { describe, expect, it } from "vitest";

import { FixedRagtimeEmbedder, VectorCollection } from "./index.js";

function makeCollection() {
  return new VectorCollection({ embedder: new FixedRagtimeEmbedder() });
}

const DOCS: { id: string; text: string; meta: Record<string, unknown> }[] = [
  { id: "id-a", text: "aaaabbbb", meta: { tier: "gold" } }, // a×4, b×4
  { id: "id-b", text: "ccccdddd", meta: { tier: "free" } }, // c×4, d×4 (orthogonal to a/b)
  { id: "id-c", text: "aaaacccc", meta: { tier: "gold" } }, // shares a with a, c with b
];

async function seed(c: VectorCollection): Promise<void> {
  await c.add({
    ids: DOCS.map((d) => d.id),
    documents: DOCS.map((d) => d.text),
    metadatas: DOCS.map((d) => d.meta),
  });
}

describe("VectorCollection (chroma-shaped facade)", () => {
  it("adds documents and reports them via count and get-by-ids", async () => {
    const c = makeCollection();
    await seed(c);
    expect(await c.count()).toBe(3);

    const got = await c.get({ ids: ["id-a", "id-c"] });
    expect(got.ids).toEqual(["id-a", "id-c"]);
    expect(got.documents).toEqual(["aaaabbbb", "aaaacccc"]);
    expect(got.metadatas).toEqual([{ tier: "gold" }, { tier: "gold" }]);
  });

  it("queries with chroma's parallel-array envelope: nearest doc first with distances", async () => {
    const c = makeCollection();
    await seed(c);
    const rows = await c.query(["aaaabbbb"]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ids).toEqual(["id-a", "id-c", "id-b"]);
    expect(row.documents).toHaveLength(3);
    expect(row.metadatas).toHaveLength(3);
    expect(row.distances).toHaveLength(3);
    // cosine = 1 for the identical doc → distance 0; orthogonal doc → distance 1.
    expect(row.distances[0]).toBeCloseTo(0, 5);
    expect(row.distances[2]).toBeCloseTo(1, 5);
    expect(row.distances[0]!).toBeLessThan(row.distances[1]!);
    // embeddings only populated when included.
    expect(row.embeddings).toEqual([]);
  });

  it("honors the include projection", async () => {
    const c = makeCollection();
    await seed(c);
    const docsOnly = await c.query(["aaaa"], { include: ["documents"] });
    expect(docsOnly[0]!.metadatas).toEqual([]);
    expect(docsOnly[0]!.distances).toEqual([]);
    expect(docsOnly[0]!.embeddings).toEqual([]);
    expect(docsOnly[0]!.documents.length).toBeGreaterThan(0);

    const withEmbeddings = await c.query(["aaaa"], {
      include: ["documents", "embeddings"],
    });
    expect(withEmbeddings[0]!.embeddings.length).toBeGreaterThan(0);
    expect(withEmbeddings[0]!.embeddings[0]!.length).toBe(32); // FixedRagtimeEmbedder dims
  });

  it("filters by the pass-50 where vocabulary and whereDocument", async () => {
    const c = makeCollection();
    await seed(c);
    const gold = await c.query(["aaaa"], { where: { tier: "gold" } });
    expect(gold[0]!.ids.sort()).toEqual(["id-a", "id-c"]);
    expect(gold[0]!.ids).not.toContain("id-b");

    const free = await c.get({ where: { tier: { $ne: "gold" } } });
    expect(free.ids).toEqual(["id-b"]);

    const contains = await c.get({ whereDocument: { $contains: "dddd" } });
    expect(contains.ids).toEqual(["id-b"]);
  });

  it("returns one envelope row per query text", async () => {
    const c = makeCollection();
    await seed(c);
    const rows = await c.query(["aaaabbbb", "ccccdddd"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ids[0]).toBe("id-a");
    expect(rows[1]!.ids[0]).toBe("id-b"); // pure c/d letters rank docB highest
  });

  it("deletes by id and removes the document from results", async () => {
    const c = makeCollection();
    await seed(c);
    await c.delete(["id-b"]);
    expect(await c.count()).toBe(2);
    expect((await c.get({})).ids.sort()).toEqual(["id-a", "id-c"]);
    const rows = await c.query(["cccc"]);
    expect(rows[0]!.ids[0]).toBe("id-c"); // id-b is gone; id-a is orthogonal
    // deleting an unknown id is a no-op
    await c.delete(["ghost"]);
    expect(await c.count()).toBe(2);
  });

  it("validates input lengths and rejects empty documents", async () => {
    const c = makeCollection();
    await expect(c.add({ ids: ["a", "b"], documents: ["only-one"] })).rejects.toThrow(
      /lengths differ/,
    );
    await expect(c.add({ ids: ["a"], documents: ["   "] })).rejects.toThrow(/empty/);
  });
});
