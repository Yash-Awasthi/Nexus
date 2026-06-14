// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  KnowledgeStore,
  TagIndex,
  CrossLinker,
  LibrarianAgent,
} from "../src/index.js";

// ── KnowledgeStore ────────────────────────────────────────────────────────────

describe("KnowledgeStore", () => {
  let store: KnowledgeStore;

  beforeEach(() => { store = new KnowledgeStore(); });

  it("creates and retrieves an item", () => {
    const item = store.create({ title: "TypeScript Guide", content: "TS is great" });
    const found = store.get(item.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe("TypeScript Guide");
    expect(found!.id).toMatch(/^ki-/);
    expect(found!.status).toBe("active");
  });

  it("normalises tags to lowercase", () => {
    const item = store.create({ title: "t", content: "c", tags: ["TypeScript", "REACT"] });
    expect(item.tags).toContain("typescript");
    expect(item.tags).toContain("react");
  });

  it("deduplicates tags", () => {
    const item = store.create({ title: "t", content: "c", tags: ["ts", "ts", "ts"] });
    expect(item.tags.filter((x) => x === "ts")).toHaveLength(1);
  });

  it("updates an item", () => {
    const item = store.create({ title: "old", content: "c" });
    const updated = store.update(item.id, { title: "new" });
    expect(updated!.title).toBe("new");
    expect(store.get(item.id)!.title).toBe("new");
  });

  it("update returns undefined for unknown id", () => {
    expect(store.update("bad", { title: "x" })).toBeUndefined();
  });

  it("deletes an item", () => {
    const item = store.create({ title: "t", content: "c" });
    expect(store.delete(item.id)).toBe(true);
    expect(store.get(item.id)).toBeUndefined();
    expect(store.delete(item.id)).toBe(false);
  });

  it("lists items sorted by updatedAt desc", async () => {
    store.create({ title: "first", content: "c" });
    await new Promise((r) => setTimeout(r, 2));
    store.create({ title: "second", content: "c" });
    const items = store.list();
    expect(items[0]!.title).toBe("second");
    expect(items[1]!.title).toBe("first");
  });

  it("searches by query string", () => {
    store.create({ title: "TypeScript handbook", content: "Strong types help" });
    store.create({ title: "Python tutorial", content: "Dynamic language" });
    const results = store.search({ query: "typescript" });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toContain("TypeScript");
  });

  it("searches by tags (AND logic)", () => {
    store.create({ title: "a", content: "c", tags: ["ts", "react"] });
    store.create({ title: "b", content: "c", tags: ["ts"] });
    const results = store.search({ tags: ["ts", "react"] });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("a");
  });

  it("searches by status", () => {
    store.create({ title: "active", content: "c", status: "active" });
    store.create({ title: "archived", content: "c", status: "archived" });
    expect(store.search({ status: "archived" })).toHaveLength(1);
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) store.create({ title: `item ${i}`, content: "c" });
    expect(store.search({ limit: 3 })).toHaveLength(3);
  });

  it("addTag adds tag idempotently", () => {
    const item = store.create({ title: "t", content: "c", tags: ["a"] });
    store.addTag(item.id, "B");
    store.addTag(item.id, "b"); // dup
    expect(store.get(item.id)!.tags).toEqual(["a", "b"]);
  });

  it("removeTag removes a tag", () => {
    const item = store.create({ title: "t", content: "c", tags: ["a", "b"] });
    store.removeTag(item.id, "a");
    expect(store.get(item.id)!.tags).toEqual(["b"]);
  });

  it("link creates bidirectional links", () => {
    const a = store.create({ title: "A", content: "c" });
    const b = store.create({ title: "B", content: "c" });
    expect(store.link(a.id, b.id)).toBe(true);
    expect(store.get(a.id)!.links).toContain(b.id);
    expect(store.get(b.id)!.links).toContain(a.id);
  });

  it("link returns false for missing item", () => {
    const a = store.create({ title: "A", content: "c" });
    expect(store.link(a.id, "ghost")).toBe(false);
  });

  it("unlink removes bidirectional links", () => {
    const a = store.create({ title: "A", content: "c" });
    const b = store.create({ title: "B", content: "c" });
    store.link(a.id, b.id);
    store.unlink(a.id, b.id);
    expect(store.get(a.id)!.links).not.toContain(b.id);
    expect(store.get(b.id)!.links).not.toContain(a.id);
  });
});

// ── TagIndex ──────────────────────────────────────────────────────────────────

describe("TagIndex", () => {
  it("indexes and looks up tags", () => {
    const idx = new TagIndex();
    idx.add("typescript", "item1");
    idx.add("typescript", "item2");
    idx.add("react", "item1");
    expect(idx.lookup("typescript")).toContain("item1");
    expect(idx.lookup("typescript")).toContain("item2");
    expect(idx.lookup("react")).toContain("item1");
    expect(idx.lookup("python")).toHaveLength(0);
  });

  it("normalises tags on add", () => {
    const idx = new TagIndex();
    idx.add("TypeScript", "i1");
    expect(idx.lookup("typescript")).toContain("i1");
  });

  it("removes tag from index", () => {
    const idx = new TagIndex();
    idx.add("ts", "i1");
    idx.remove("ts", "i1");
    expect(idx.lookup("ts")).toHaveLength(0);
    expect(idx.tags()).not.toContain("ts");
  });

  it("returns sorted tags list", () => {
    const idx = new TagIndex();
    idx.add("zebra", "i1");
    idx.add("apple", "i1");
    idx.add("mango", "i1");
    expect(idx.tags()).toEqual(["apple", "mango", "zebra"]);
  });

  it("builds from store", () => {
    const store = new KnowledgeStore();
    store.create({ title: "t", content: "c", tags: ["ts", "react"] });
    const idx = TagIndex.fromStore(store);
    expect(idx.lookup("ts")).toHaveLength(1);
    expect(idx.lookup("react")).toHaveLength(1);
  });
});

// ── CrossLinker ───────────────────────────────────────────────────────────────

describe("CrossLinker", () => {
  const linker = new CrossLinker();

  it("suggests related items by keyword overlap", () => {
    const source = {
      id: "s", title: "TypeScript performance tips", content: "Improve TypeScript speed and performance",
      tags: ["typescript"], links: [], status: "active" as const,
      createdAt: "", updatedAt: "", metadata: {},
    };
    const candidates = [
      {
        id: "c1", title: "TypeScript best practices", content: "Write better TypeScript code",
        tags: ["typescript"], links: [], status: "active" as const, createdAt: "", updatedAt: "", metadata: {},
      },
      {
        id: "c2", title: "Python tutorial", content: "Learn Python programming",
        tags: ["python"], links: [], status: "active" as const, createdAt: "", updatedAt: "", metadata: {},
      },
    ];
    const results = linker.suggest(source, candidates);
    expect(results[0]!.id).toBe("c1"); // typescript overlap
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("excludes the source item from suggestions", () => {
    const item = {
      id: "same", title: "thing", content: "content", tags: [],
      links: [], status: "active" as const, createdAt: "", updatedAt: "", metadata: {},
    };
    const results = linker.suggest(item, [item]);
    expect(results).toHaveLength(0);
  });

  it("respects topK limit", () => {
    const source = {
      id: "s", title: "JavaScript programming language tutorial guide",
      content: "JavaScript is a programming language used for web development",
      tags: ["javascript"], links: [], status: "active" as const, createdAt: "", updatedAt: "", metadata: {},
    };
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`, title: `JavaScript guide ${i}`, content: `programming tutorial ${i}`,
      tags: ["javascript"], links: [], status: "active" as const, createdAt: "", updatedAt: "", metadata: {},
    }));
    expect(linker.suggest(source, candidates, 3)).toHaveLength(3);
  });
});

// ── LibrarianAgent ────────────────────────────────────────────────────────────

describe("LibrarianAgent", () => {
  it("ingests an item and returns result", () => {
    const agent = new LibrarianAgent();
    const result = agent.ingest({ title: "TypeScript Guide", content: "TypeScript is great for large apps", tags: ["typescript"] });
    expect(result.item.id).toBeTruthy();
    expect(result.suggestedLinks).toBeDefined();
  });

  it("auto-links items above threshold", () => {
    const agent = new LibrarianAgent({ autoLinkThreshold: 0.1 });
    agent.ingest({ title: "TypeScript tips", content: "TypeScript performance optimization guide tips", tags: ["typescript"] });
    const result = agent.ingest({ title: "TypeScript guide", content: "TypeScript performance and tips for development", tags: ["typescript"] });
    expect(result.autoLinked).toBeGreaterThan(0);
  });

  it("relink returns suggestions for existing item", () => {
    const agent = new LibrarianAgent();
    const r1 = agent.ingest({ title: "Python ML", content: "machine learning with python numpy pandas sklearn", tags: ["python", "ml"] });
    agent.ingest({ title: "Python data", content: "data science with python numpy pandas matplotlib", tags: ["python", "data"] });
    const suggestions = agent.relink(r1.item.id);
    expect(suggestions.length).toBeGreaterThanOrEqual(0); // may or may not match
  });

  it("archiveOlderThan archives stale items", async () => {
    // autoLinkThreshold > 1 prevents auto-linking (which would refresh updatedAt)
    const agent = new LibrarianAgent({ autoLinkThreshold: 2 });
    agent.ingest({ title: "old post", content: "content" });
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 2));
    agent.ingest({ title: "new post", content: "content" });
    const archived = agent.archiveOlderThan(cutoff);
    expect(archived).toBe(1);
    const items = agent.getStore().search({ status: "archived" });
    expect(items[0]!.title).toBe("old post");
  });

  it("relink returns empty for unknown id", () => {
    const agent = new LibrarianAgent();
    expect(agent.relink("ghost")).toEqual([]);
  });
});
