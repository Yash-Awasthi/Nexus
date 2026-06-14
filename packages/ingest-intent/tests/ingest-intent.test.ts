// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  DocumentChunker,
  TermNormalizer,
  BoundedTermExtractor,
  MockLlmDistiller,
  IntentDistiller,
  DistillPipeline,
} from "../src/index.js";

// ── DocumentChunker ───────────────────────────────────────────────────────────

describe("DocumentChunker", () => {
  const chunker = new DocumentChunker();

  it("returns full text when under cap", () => {
    const r = chunker.cap("short text", 20_000);
    expect(r.text).toBe("short text");
    expect(r.truncated).toBe(false);
  });

  it("truncates to maxChars", () => {
    const long = "x".repeat(100);
    const r = chunker.cap(long, 50);
    expect(r.text).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it("exactly at cap is not truncated", () => {
    const text = "a".repeat(10);
    const r = chunker.cap(text, 10);
    expect(r.truncated).toBe(false);
  });
});

// ── TermNormalizer ────────────────────────────────────────────────────────────

describe("TermNormalizer", () => {
  const n = new TermNormalizer();

  it("lowercases terms", () => {
    const terms = n.normalize("Hello World", 100);
    expect(terms).toContain("hello");
    expect(terms).toContain("world");
  });

  it("removes stop words", () => {
    const terms = n.normalize("the quick brown fox", 100);
    expect(terms).not.toContain("the");
    expect(terms).toContain("quick");
  });

  it("deduplicates terms", () => {
    const terms = n.normalize("cat cat dog dog", 100);
    expect(terms.filter((t) => t === "cat")).toHaveLength(1);
  });

  it("respects maxTerms limit", () => {
    const text = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    const terms = n.normalize(text, 10);
    expect(terms).toHaveLength(10);
  });

  it("filters very short tokens", () => {
    const terms = n.normalize("a b hi there", 100);
    expect(terms).not.toContain("a");
    expect(terms).not.toContain("b");
    expect(terms).toContain("hi");
  });

  it("removes punctuation", () => {
    const terms = n.normalize("hello, world! foo.bar", 100);
    expect(terms.every((t) => /^[a-z0-9-]+$/.test(t))).toBe(true);
  });
});

// ── BoundedTermExtractor ──────────────────────────────────────────────────────

describe("BoundedTermExtractor", () => {
  const extractor = new BoundedTermExtractor();

  it("extracts terms from text", () => {
    const result = extractor.extract("machine learning neural network classification");
    expect(result.query).not.toBeNull();
    expect(result.termCount).toBeGreaterThan(0);
    expect(result.source).toBe("fallback");
  });

  it("respects maxTerms", () => {
    const text = Array.from({ length: 300 }, (_, i) => `term${i}`).join(" ");
    const result = extractor.extract(text, 50);
    expect(result.termCount).toBeLessThanOrEqual(50);
  });

  it("truncates text at 20K chars", () => {
    const long = "word ".repeat(10_000); // 50K chars
    const result = extractor.extract(long);
    expect(result.truncated).toBe(true);
    expect(result.inputChars).toBeLessThanOrEqual(20_000);
  });

  it("returns null query for empty text", () => {
    const result = extractor.extract("");
    expect(result.query).toBeNull();
  });
});

// ── MockLlmDistiller ──────────────────────────────────────────────────────────

describe("MockLlmDistiller", () => {
  it("asFn() returns LLM response", async () => {
    const mock = new MockLlmDistiller();
    mock.setResponse("machine learning neural network");
    const fn = mock.asFn();
    const result = await fn("some prompt");
    expect(result).toBe("machine learning neural network");
  });

  it("asFn() throws when configured to", async () => {
    const mock = new MockLlmDistiller();
    mock.setThrows("LLM timeout");
    await expect(mock.asFn()("prompt")).rejects.toThrow("LLM timeout");
  });

  it("records calls", async () => {
    const mock = new MockLlmDistiller();
    mock.setResponse("terms");
    await mock.asFn()("prompt A");
    await mock.asFn()("prompt B");
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]).toBe("prompt A");
  });
});

// ── IntentDistiller ───────────────────────────────────────────────────────────

describe("IntentDistiller", () => {
  it("without LLM uses deterministic fallback", async () => {
    const distiller = new IntentDistiller();
    const result = await distiller.distill("machine learning neural network");
    expect(result.source).toBe("fallback");
    expect(result.query).not.toBeNull();
  });

  it("with LLM uses LLM output", async () => {
    const distiller = new IntentDistiller();
    const mock = new MockLlmDistiller();
    mock.setResponse("quantum computing physics");
    distiller.inject(mock.asFn());
    const result = await distiller.distill("long document about quantum physics");
    expect(result.source).toBe("llm");
    expect(result.query).toContain("quantum");
  });

  it("fails open when LLM throws", async () => {
    const distiller = new IntentDistiller({ failOpen: true });
    const mock = new MockLlmDistiller();
    mock.setThrows("timeout");
    distiller.inject(mock.asFn());
    const result = await distiller.distill("document");
    expect(result.query).toBeNull();
    expect(result.source).toBe("null");
  });

  it("falls back to extractor when failOpen=false and LLM throws", async () => {
    const distiller = new IntentDistiller({ failOpen: false });
    const mock = new MockLlmDistiller();
    mock.setThrows("error");
    distiller.inject(mock.asFn());
    const result = await distiller.distill("machine learning document");
    expect(result.source).toBe("fallback");
  });

  it("returns null when LLM returns empty string (fail open)", async () => {
    const distiller = new IntentDistiller({ failOpen: true });
    const mock = new MockLlmDistiller();
    mock.setResponse("  ");
    distiller.inject(mock.asFn());
    const result = await distiller.distill("document");
    expect(result.query).toBeNull();
    expect(result.source).toBe("null");
  });

  it("respects maxOutputTerms", async () => {
    const distiller = new IntentDistiller({ maxOutputTerms: 5 });
    const mock = new MockLlmDistiller();
    mock.setResponse("one two three four five six seven eight nine ten");
    distiller.inject(mock.asFn());
    const result = await distiller.distill("document");
    if (result.query) {
      expect(result.termCount).toBeLessThanOrEqual(5);
    }
  });

  it("truncates input to maxInputChars", async () => {
    const distiller = new IntentDistiller({ maxInputChars: 100 });
    const mock = new MockLlmDistiller();
    mock.setResponse("terms");
    distiller.inject(mock.asFn());
    const long = "word ".repeat(1_000);
    const result = await distiller.distill(long);
    expect(result.truncated).toBe(true);
    expect(result.inputChars).toBeLessThanOrEqual(100);
  });
});

// ── DistillPipeline ───────────────────────────────────────────────────────────

describe("DistillPipeline", () => {
  it("passes through LLM result when non-null", async () => {
    const distiller = new IntentDistiller();
    const mock = new MockLlmDistiller();
    mock.setResponse("valid terms here");
    distiller.inject(mock.asFn());
    const pipeline = new DistillPipeline(distiller);
    const result = await pipeline.run("document about valid terms");
    expect(result.source).toBe("llm");
    expect(result.query).not.toBeNull();
  });

  it("falls back to BoundedTermExtractor when distiller returns null", async () => {
    const distiller = new IntentDistiller({ failOpen: true });
    const mock = new MockLlmDistiller();
    mock.setThrows("error");
    distiller.inject(mock.asFn());
    const pipeline = new DistillPipeline(distiller);
    const result = await pipeline.run("machine learning document with many terms");
    expect(result.source).toBe("fallback");
    expect(result.query).not.toBeNull();
  });
});
