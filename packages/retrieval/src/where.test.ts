// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  validateWhere,
  validateWhereDocument,
  whereMatches,
  whereDocumentMatches,
  InMemoryRagtimeStore,
  type MemoryFilter,
} from "./index.js";

describe("whereMatches — comparison operators", () => {
  const md = { status: "active", score: 0.75, rank: 2, tags: ["a", "b"], enabled: true };

  it("shorthand equality matches scalar fields", () => {
    expect(whereMatches(md, { status: "active" })).toBe(true);
    expect(whereMatches(md, { status: "inactive" })).toBe(false);
    expect(whereMatches(md, { missing: "x" })).toBe(false);
  });

  it("$eq matches present fields, never absent ones", () => {
    expect(whereMatches(md, { status: { $eq: "active" } })).toBe(true);
    expect(whereMatches(md, { rank: { $eq: 2 } })).toBe(true);
    expect(whereMatches(md, { missing: { $eq: 1 } })).toBe(false);
  });

  it("$ne matches absent fields and differing values (chroma semantics)", () => {
    expect(whereMatches(md, { status: { $ne: "inactive" } })).toBe(true);
    expect(whereMatches(md, { missing: { $ne: 1 } })).toBe(true); // absent → matches
    expect(whereMatches(md, { status: { $ne: "active" } })).toBe(false);
  });

  it("numbers compare by value across int/float (chroma unions columns)", () => {
    expect(whereMatches(md, { rank: { $eq: 2.0 } })).toBe(true);
    expect(whereMatches(md, { score: { $gte: 0.75 } })).toBe(true);
    expect(whereMatches(md, { rank: { $gt: 1 } })).toBe(true);
    expect(whereMatches(md, { score: { $lt: 1 } })).toBe(true);
    expect(whereMatches(md, { rank: { $lte: 2 } })).toBe(true);
  });

  it("ordered comparisons exclude absent and non-numeric fields", () => {
    expect(whereMatches(md, { missing: { $gt: 1 } })).toBe(false);
    expect(whereMatches(md, { status: { $gt: 1 } })).toBe(false); // string field
  });

  it("strict typing: string '2' does not equal number 2", () => {
    expect(whereMatches({ v: "2" }, { v: { $eq: 2 } })).toBe(false);
    expect(whereMatches({ v: true }, { v: { $eq: 1 } })).toBe(false);
    expect(whereMatches({ v: 1 }, { v: { $eq: true } })).toBe(false);
    expect(whereMatches({ v: 1 }, { v: { $eq: 1 } })).toBe(true);
  });
});

describe("whereMatches — $in/$nin/$contains/$and/$or", () => {
  const md = { status: "active", score: 0.75, tags: ["a", "b", "c"] };

  it("$in requires a present field with a listed value", () => {
    expect(whereMatches(md, { status: { $in: ["active", "pending"] } })).toBe(true);
    expect(whereMatches(md, { status: { $in: ["closed"] } })).toBe(false);
    expect(whereMatches(md, { missing: { $in: [1, 2] } })).toBe(false);
  });

  it("$nin matches absent fields (chroma semantics)", () => {
    expect(whereMatches(md, { status: { $nin: ["closed"] } })).toBe(true);
    expect(whereMatches(md, { missing: { $nin: [1, 2] } })).toBe(true);
    expect(whereMatches(md, { status: { $nin: ["active"] } })).toBe(false);
  });

  it("$contains/$not_contains test array membership on metadata fields", () => {
    expect(whereMatches(md, { tags: { $contains: "a" } })).toBe(true);
    expect(whereMatches(md, { tags: { $contains: "z" } })).toBe(false);
    expect(whereMatches(md, { missing: { $contains: "a" } })).toBe(false);
    expect(whereMatches(md, { tags: { $not_contains: "z" } })).toBe(true);
    expect(whereMatches(md, { tags: { $not_contains: "a" } })).toBe(false);
    expect(whereMatches(md, { missing: { $not_contains: "a" } })).toBe(true);
  });

  it("$and requires all clauses; $or requires any", () => {
    expect(whereMatches(md, { $and: [{ status: "active" }, { score: { $gte: 0.5 } }] })).toBe(true);
    expect(whereMatches(md, { $and: [{ status: "active" }, { score: { $lt: 0.5 } }] })).toBe(false);
    expect(whereMatches(md, { $or: [{ status: "closed" }, { score: { $gte: 0.5 } }] })).toBe(true);
    expect(whereMatches(md, { $or: [{ status: "closed" }, { score: { $lt: 0.1 } }] })).toBe(false);
  });

  it("composes nested logical clauses", () => {
    const clause = {
      $or: [{ $and: [{ status: "active" }, { score: { $gte: 0.9 } }] }, { status: "pending" }],
    };
    expect(whereMatches(md, clause)).toBe(false);
    expect(whereMatches({ status: "pending" }, clause)).toBe(true);
  });
});

describe("validateWhere / validateWhereDocument — grammar checks", () => {
  it("accepts valid metadata clauses", () => {
    expect(() => validateWhere({ status: "active" })).not.toThrow();
    expect(() => validateWhere({ rank: { $gt: 1 } })).not.toThrow();
    expect(() => validateWhere({ tags: { $in: ["a", "b"] } })).not.toThrow();
    expect(() => validateWhere({ $and: [{ a: 1 }, { b: 2 }] })).not.toThrow();
  });

  it("rejects malformed clauses", () => {
    expect(() => validateWhere({})).toThrow(/exactly one/);
    expect(() => validateWhere({ a: 1, b: 2 })).toThrow(/exactly one/);
    expect(() => validateWhere({ $and: [{ a: 1 }] })).toThrow(/at least two/);
    expect(() => validateWhere({ a: { $bogus: 1 } })).toThrow(/Unknown where operator/);
    expect(() => validateWhere({ a: { $gt: "x" } })).toThrow(/number/);
    expect(() => validateWhere({ a: { $in: [] } })).toThrow(/non-empty/);
    expect(() => validateWhere({ $contains: "x" })).toThrow(/metadata field or \$and\/\$or/);
  });

  it("rejects malformed where_document clauses", () => {
    expect(() => validateWhereDocument({ $contains: "cat" })).not.toThrow();
    expect(() => validateWhereDocument({ $not_contains: "cat" })).not.toThrow();
    expect(() => validateWhereDocument({ $contains: "" })).toThrow(/non-empty/);
    expect(() => validateWhereDocument({ $bogus: "cat" })).toThrow(/Unknown where_document/);
  });
});

describe("whereDocumentMatches — document text", () => {
  it("$contains is a substring test; $not_contains excludes", () => {
    expect(whereDocumentMatches("the cat sat", { $contains: "cat" })).toBe(true);
    expect(whereDocumentMatches("the dog sat", { $contains: "cat" })).toBe(false);
    expect(whereDocumentMatches("the dog sat", { $not_contains: "cat" })).toBe(true);
    expect(whereDocumentMatches("the cat sat", { $not_contains: "cat" })).toBe(false);
  });

  it("empty documents never contain and always not-contain", () => {
    expect(whereDocumentMatches("", { $contains: "x" })).toBe(false);
    expect(whereDocumentMatches(undefined, { $contains: "x" })).toBe(false);
    expect(whereDocumentMatches("", { $not_contains: "x" })).toBe(true);
  });

  it("$and/$or compose document clauses", () => {
    const doc = "monads are hard but useful";
    expect(
      whereDocumentMatches(doc, { $and: [{ $contains: "monads" }, { $contains: "useful" }] }),
    ).toBe(true);
    expect(
      whereDocumentMatches(doc, { $and: [{ $contains: "monads" }, { $contains: "cats" }] }),
    ).toBe(false);
    expect(
      whereDocumentMatches(doc, { $or: [{ $contains: "cats" }, { $contains: "useful" }] }),
    ).toBe(true);
  });
});

describe("store integration — MemoryFilter where/whereDocument on InMemoryRagtimeStore", () => {
  async function seed(): Promise<InMemoryRagtimeStore> {
    const store = new InMemoryRagtimeStore();
    await store.save({
      id: "a",
      text: "active deployment notes",
      embedding: [1, 0],
      metadata: { status: "active", priority: 3, tags: ["infra"] },
      createdAt: 100,
    });
    await store.save({
      id: "b",
      text: "closed incident report",
      embedding: [0, 1],
      metadata: { status: "closed", priority: 1 },
      createdAt: 200,
    });
    await store.save({
      id: "c",
      text: "active roadmap draft",
      embedding: [1, 1],
      metadata: { status: "active", priority: 5, tags: ["product", "infra"] },
      createdAt: 300,
    });
    return store;
  }

  it("filters list() by where clause", async () => {
    const store = await seed();
    const all = await store.list();
    expect(all.map((e) => e.id).sort()).toEqual(["a", "b", "c"]);

    const f: MemoryFilter = { where: { status: "active" } };
    expect((await store.list(f)).map((e) => e.id).sort()).toEqual(["a", "c"]);

    const f2: MemoryFilter = { where: { priority: { $gte: 3 } } };
    expect((await store.list(f2)).map((e) => e.id).sort()).toEqual(["a", "c"]);

    const f3: MemoryFilter = { where: { tags: { $contains: "product" } } };
    expect((await store.list(f3)).map((e) => e.id)).toEqual(["c"]);
  });

  it("filters by $ne including records missing the field", async () => {
    const store = await seed();
    const f: MemoryFilter = { where: { status: { $ne: "closed" } } };
    const ids = (await store.list(f)).map((e) => e.id).sort();
    expect(ids).toEqual(["a", "c"]);
  });

  it("filters by whereDocument over entry text", async () => {
    const store = await seed();
    const f: MemoryFilter = { whereDocument: { $contains: "active" } };
    expect((await store.list(f)).map((e) => e.id).sort()).toEqual(["a", "c"]);
  });

  it("combines legacy metadata equality with where/whereDocument (AND)", async () => {
    const store = await seed();
    const f: MemoryFilter = {
      metadata: { status: "active" },
      whereDocument: { $not_contains: "roadmap" },
    };
    expect((await store.list(f)).map((e) => e.id)).toEqual(["a"]);
  });

  it("search() honors where filters", async () => {
    const store = await seed();
    const f: MemoryFilter = { where: { status: "active" } };
    const hits = await store.search([1, 1], 10, f);
    expect(hits.map((h) => h.entry.id).sort()).toEqual(["a", "c"]);
  });
});
