// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  MockCorpusSearchBackend,
  CorpusBuilder,
  CorpusStore,
  CorpusRenderer,
  KnowledgeAgent,
  type Corpus,
  type CorpusDocument,
} from "../src/index.js";

// ── MockCorpusSearchBackend ───────────────────────────────────────────────────

describe("MockCorpusSearchBackend", () => {
  it("returns default documents", async () => {
    const backend = new MockCorpusSearchBackend();
    const result = await backend.search("AI");
    expect(result.documents.length).toBeGreaterThan(0);
    expect(result.query).toBe("AI");
  });

  it("records query calls", async () => {
    const backend = new MockCorpusSearchBackend();
    await backend.search("a");
    await backend.search("b");
    expect(backend.calls).toEqual(["a", "b"]);
  });

  it("filters by topics", async () => {
    const backend = new MockCorpusSearchBackend();
    const result = await backend.search("ml", { topics: ["ml"] });
    expect(result.documents.every((d) => d.topics.includes("ml"))).toBe(true);
  });

  it("filters by sources", async () => {
    const backend = new MockCorpusSearchBackend();
    const result = await backend.search("q", { sources: ["pdf"] });
    expect(result.documents.every((d) => d.source === "pdf")).toBe(true);
  });

  it("filters by minWordCount", async () => {
    const backend = new MockCorpusSearchBackend();
    const result = await backend.search("q", { minWordCount: 13 });
    expect(result.documents.every((d) => d.wordCount >= 13)).toBe(true);
  });

  it("filters by minScore", async () => {
    const backend = new MockCorpusSearchBackend();
    const result = await backend.search("q", { minScore: 0.85 });
    expect(result.documents.every((d) => (d.score ?? 0) >= 0.85)).toBe(true);
  });

  it("respects maxDocuments", async () => {
    const backend = new MockCorpusSearchBackend();
    const result = await backend.search("q", { maxDocuments: 1 });
    expect(result.documents).toHaveLength(1);
  });

  it("accepts custom documents", async () => {
    const docs: CorpusDocument[] = [
      { id: "custom-1", title: "Custom", content: "Content", source: "mock", topics: [], wordCount: 1 },
    ];
    const backend = new MockCorpusSearchBackend(docs);
    const result = await backend.search("q");
    expect(result.documents[0]!.id).toBe("custom-1");
  });
});

// ── CorpusBuilder ─────────────────────────────────────────────────────────────

describe("CorpusBuilder", () => {
  it("build returns a corpus with documents", async () => {
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    const corpus = await builder.build("AI research");
    expect(corpus.id).toMatch(/^corpus-/);
    expect(corpus.query).toBe("AI research");
    expect(corpus.documents.length).toBeGreaterThan(0);
    expect(corpus.builtAt).toBeDefined();
  });

  it("corpus totalWords sums document words", async () => {
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    const corpus = await builder.build("q");
    const expected = corpus.documents.reduce((s, d) => s + d.wordCount, 0);
    expect(corpus.totalWords).toBe(expected);
  });

  it("build passes filter to backend", async () => {
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    const corpus = await builder.build("q", { sources: ["web"] });
    expect(corpus.filter.sources).toEqual(["web"]);
    expect(corpus.documents.every((d) => d.source === "web")).toBe(true);
  });

  it("each corpus gets unique id", async () => {
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    const c1 = await builder.build("q1");
    const c2 = await builder.build("q2");
    expect(c1.id).not.toBe(c2.id);
  });
});

// ── CorpusStore ───────────────────────────────────────────────────────────────

describe("CorpusStore", () => {
  it("save and get works", async () => {
    const store = new CorpusStore();
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    const corpus = await builder.build("test");
    store.save(corpus);
    expect(store.get(corpus.id)).toBe(corpus);
  });

  it("has returns correct boolean", () => {
    const store = new CorpusStore();
    expect(store.has("nonexistent")).toBe(false);
  });

  it("list returns all corpora", async () => {
    const store = new CorpusStore();
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    store.save(await builder.build("q1"));
    store.save(await builder.build("q2"));
    expect(store.list()).toHaveLength(2);
  });

  it("delete removes corpus", async () => {
    const store = new CorpusStore();
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    const corpus = await builder.build("q");
    store.save(corpus);
    expect(store.delete(corpus.id)).toBe(true);
    expect(store.has(corpus.id)).toBe(false);
  });

  it("findByQuery locates by query string", async () => {
    const store = new CorpusStore();
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    const corpus = await builder.build("unique query");
    store.save(corpus);
    expect(store.findByQuery("unique query")).toBe(corpus);
    expect(store.findByQuery("other")).toBeUndefined();
  });

  it("clear empties store", () => {
    const store = new CorpusStore();
    // just testing the method doesn't throw
    store.clear();
    expect(store.count()).toBe(0);
  });
});

// ── CorpusRenderer ────────────────────────────────────────────────────────────

describe("CorpusRenderer", () => {
  async function buildCorpus(): Promise<Corpus> {
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    return builder.build("AI");
  }

  it("renderMarkdown includes title and document headings", async () => {
    const renderer = new CorpusRenderer();
    const corpus = await buildCorpus();
    const md = renderer.renderMarkdown(corpus);
    expect(md).toContain("# Corpus: AI");
    expect(md).toContain("## Introduction to AI");
  });

  it("renderText includes corpus and document content", async () => {
    const renderer = new CorpusRenderer();
    const corpus = await buildCorpus();
    const text = renderer.renderText(corpus);
    expect(text).toContain("CORPUS: AI");
    expect(text).toContain("Introduction to AI");
  });

  it("render dispatches to correct format", async () => {
    const renderer = new CorpusRenderer();
    const corpus = await buildCorpus();
    expect(renderer.render(corpus, "markdown")).toContain("#");
    expect(renderer.render(corpus, "text")).toContain("CORPUS:");
  });
});

// ── KnowledgeAgent ────────────────────────────────────────────────────────────

describe("KnowledgeAgent", () => {
  it("answer returns response with source documents", async () => {
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    const agent = new KnowledgeAgent(builder, async (q, ctx) => `Answer to: ${q}`);
    const result = await agent.answer("What is AI?");
    expect(result.question).toBe("What is AI?");
    expect(result.answer).toContain("What is AI?");
    expect(result.sourceDocuments.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.corpusId).toMatch(/^corpus-/);
  });

  it("confidence is low when no documents found", async () => {
    const backend = new MockCorpusSearchBackend([]);
    const builder = new CorpusBuilder(backend);
    const agent = new KnowledgeAgent(builder, async () => "empty");
    const result = await agent.answer("q");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("passes filter to corpus builder", async () => {
    const backend = new MockCorpusSearchBackend();
    const builder = new CorpusBuilder(backend);
    const agent = new KnowledgeAgent(builder, async () => "ok");
    await agent.answer("q", { sources: ["web"] });
    expect(backend.calls).toHaveLength(1);
  });
});
