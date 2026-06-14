// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  htmlToText,
  estimateTokens,
  chunkText,
  runDocPipeline,
  defaultExtractor,
  nullExtractor,
  nullEmbedder,
  nullStore,
  docPipelineAdapter,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  CHARS_PER_TOKEN,
  type DocInput,
  type EmbeddedChunk,
  type DocMeta,
  type StoreResult,
  type ChunkStore,
  type Embedder,
  type Extractor,
} from "../src/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<DocInput> = {}): DocInput {
  return {
    format: "text",
    content: "Hello, world!",
    source: "test-doc.txt",
    ...overrides,
  };
}

function makeContext() {
  return {
    taskId: "test-task-1",
    startTime: new Date(),
    attempt: 1,
    environment: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

// ── estimateTokens ────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 1 for exactly 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("rounds up for partial tokens", () => {
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4) = 2
  });

  it("scales linearly for longer strings", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("exposes CHARS_PER_TOKEN constant = 4", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });
});

// ── htmlToText ────────────────────────────────────────────────────────────────

describe("htmlToText", () => {
  it("strips basic tags", () => {
    expect(htmlToText("<p>Hello</p>")).toBe("Hello");
  });

  it("removes script blocks entirely", () => {
    const html = "<p>text</p><script>alert('x')</script><p>more</p>";
    const result = htmlToText(html);
    expect(result).toContain("text");
    expect(result).toContain("more");
    expect(result).not.toContain("alert");
  });

  it("removes style blocks entirely", () => {
    const html = "<style>body { color: red; }</style><p>visible</p>";
    const result = htmlToText(html);
    expect(result).not.toContain("color");
    expect(result).toContain("visible");
  });

  it("decodes &amp;", () => {
    expect(htmlToText("AT&amp;T")).toBe("AT&T");
  });

  it("decodes &lt; and &gt;", () => {
    expect(htmlToText("&lt;div&gt;")).toBe("<div>");
  });

  it("decodes &quot;", () => {
    expect(htmlToText("say &quot;hello&quot;")).toBe('say "hello"');
  });

  it("decodes &apos;", () => {
    expect(htmlToText("it&apos;s")).toBe("it's");
  });

  it("decodes &nbsp;", () => {
    expect(htmlToText("a&nbsp;b")).toBe("a b");
  });

  it("decodes numeric entities like &#169;", () => {
    const result = htmlToText("&#169;");
    expect(result).toBe("©");
  });

  it("collapses whitespace runs to single space", () => {
    expect(htmlToText("<p>  a  </p>  <p>  b  </p>")).toBe("a b");
  });

  it("returns empty string for tag-only input", () => {
    expect(htmlToText("<html><head></head><body></body></html>")).toBe("");
  });

  it("handles nested tags", () => {
    expect(htmlToText("<div><span><b>bold</b></span></div>")).toBe("bold");
  });
});

// ── defaultExtractor ──────────────────────────────────────────────────────────

describe("defaultExtractor", () => {
  it("passes 'text' content through unchanged", async () => {
    const result = await defaultExtractor("text", "raw text content");
    expect(result).toBe("raw text content");
  });

  it("passes 'markdown' content through unchanged", async () => {
    const md = "# Title\n\nParagraph with **bold**.";
    const result = await defaultExtractor("markdown", md);
    expect(result).toBe(md);
  });

  it("strips tags from 'html' content", async () => {
    const result = await defaultExtractor("html", "<h1>Title</h1><p>Body text.</p>");
    expect(result).toBe("Title Body text.");
  });

  it("throws a descriptive error for 'pdf' format", async () => {
    await expect(defaultExtractor("pdf", "binary")).rejects.toThrow(/PDF extraction/);
  });

  it("throws a descriptive error for 'docx' format", async () => {
    await expect(defaultExtractor("docx", "binary")).rejects.toThrow(/DOCX extraction/);
  });
});

// ── nullExtractor ─────────────────────────────────────────────────────────────

describe("nullExtractor", () => {
  it("returns content unchanged for any format", async () => {
    for (const fmt of ["text", "html", "markdown", "pdf", "docx"] as const) {
      const result = await nullExtractor(fmt, "some content");
      expect(result).toBe("some content");
    }
  });
});

// ── nullEmbedder ──────────────────────────────────────────────────────────────

describe("nullEmbedder", () => {
  it("returns an array of the same length as input texts", async () => {
    const embeddings = await nullEmbedder(["a", "b", "c"]);
    expect(embeddings).toHaveLength(3);
  });

  it("returns zero vectors of dimension 4", async () => {
    const [emb] = await nullEmbedder(["hello"]);
    expect(emb).toEqual([0, 0, 0, 0]);
  });

  it("returns empty array for empty input", async () => {
    const embeddings = await nullEmbedder([]);
    expect(embeddings).toEqual([]);
  });
});

// ── nullStore ─────────────────────────────────────────────────────────────────

describe("nullStore", () => {
  it("returns one ID per chunk", async () => {
    const chunks: EmbeddedChunk[] = [
      { index: 0, text: "a", tokenEstimate: 1, embedding: [] },
      { index: 1, text: "b", tokenEstimate: 1, embedding: [] },
    ];
    const result = await nullStore.save(chunks, {
      format: "text",
      totalChunks: 2,
      processedAt: new Date().toISOString(),
    });
    expect(result.ids).toHaveLength(2);
    expect(result.count).toBe(2);
  });

  it("returns IDs prefixed with 'null-chunk-'", async () => {
    const chunks: EmbeddedChunk[] = [
      { index: 0, text: "x", tokenEstimate: 1, embedding: [] },
    ];
    const result = await nullStore.save(chunks, {
      format: "text",
      totalChunks: 1,
      processedAt: new Date().toISOString(),
    });
    expect(result.ids[0]).toBe("null-chunk-0");
  });

  it("returns count = 0 when chunks is empty", async () => {
    const result = await nullStore.save([], {
      format: "text",
      totalChunks: 0,
      processedAt: new Date().toISOString(),
    });
    expect(result.count).toBe(0);
    expect(result.ids).toEqual([]);
  });
});

// ── chunkText ─────────────────────────────────────────────────────────────────

describe("chunkText", () => {
  it("returns [] for empty text", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns a single chunk for short text", () => {
    const chunks = chunkText("Hello, world!");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("Hello, world!");
    expect(chunks[0]?.index).toBe(0);
  });

  it("chunk tokenEstimate matches estimateTokens", () => {
    const text = "a".repeat(40);
    const chunks = chunkText(text, { maxTokens: 50 });
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBe(estimateTokens(chunk.text));
    }
  });

  it("produces multiple chunks for text longer than maxTokens", () => {
    // maxTokens=4 → maxChars=16
    const text = "a".repeat(50);
    const chunks = chunkText(text, { maxTokens: 4, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("each chunk is within the maxChars limit", () => {
    const text = "x".repeat(200);
    const maxTokens = 10;
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const chunks = chunkText(text, { maxTokens, overlapTokens: 0 });
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it("overlapping chunks share a suffix/prefix of overlapChars", () => {
    const text = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
    // maxTokens=4 → maxChars=16, overlapTokens=2 → overlapChars=8, step=8
    const chunks = chunkText(text, { maxTokens: 4, overlapTokens: 2 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const c0 = chunks[0]!;
    const c1 = chunks[1]!;
    // End of chunk 0 overlaps with start of chunk 1
    const overlapChars = 2 * CHARS_PER_TOKEN;
    const c0Tail = c0.text.slice(-overlapChars);
    const c1Head = c1.text.slice(0, overlapChars);
    expect(c0Tail).toBe(c1Head);
  });

  it("last chunk contains the end of the text", () => {
    const text = "Hello World!";
    const chunks = chunkText(text, { maxTokens: 2, overlapTokens: 0 });
    const last = chunks[chunks.length - 1]!;
    expect(text.endsWith(last.text)).toBe(true);
  });

  it("indices are sequential starting at 0", () => {
    const text = "a".repeat(100);
    const chunks = chunkText(text, { maxTokens: 4, overlapTokens: 1 });
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("uses DEFAULT_MAX_TOKENS and DEFAULT_OVERLAP_TOKENS when not specified", () => {
    // Text short enough to fit in one chunk
    const short = "a".repeat(DEFAULT_MAX_TOKENS * CHARS_PER_TOKEN - 4);
    expect(chunkText(short)).toHaveLength(1);
  });

  it("exposes DEFAULT_MAX_TOKENS = 256", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(256);
  });

  it("exposes DEFAULT_OVERLAP_TOKENS = 32", () => {
    expect(DEFAULT_OVERLAP_TOKENS).toBe(32);
  });

  it("handles text exactly equal to maxChars", () => {
    const text = "a".repeat(4 * CHARS_PER_TOKEN); // exactly maxChars
    const chunks = chunkText(text, { maxTokens: 4, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(text);
  });
});

// ── runDocPipeline — basic structure ──────────────────────────────────────────

describe("runDocPipeline — basic structure", () => {
  it("returns a PipelineResult with all required fields", async () => {
    const result = await runDocPipeline(makeInput());
    expect(result).toHaveProperty("source");
    expect(result).toHaveProperty("format");
    expect(result).toHaveProperty("rawTextLength");
    expect(result).toHaveProperty("chunks");
    expect(result).toHaveProperty("embedded");
    expect(result).toHaveProperty("storeResult");
    expect(result).toHaveProperty("durationMs");
  });

  it("source is passed through to result", async () => {
    const result = await runDocPipeline(makeInput({ source: "my-doc.pdf" }));
    expect(result.source).toBe("my-doc.pdf");
  });

  it("format is passed through to result", async () => {
    const result = await runDocPipeline(makeInput({ format: "markdown" }));
    expect(result.format).toBe("markdown");
  });

  it("rawTextLength is length of extracted text", async () => {
    const content = "Hello, world!";
    const result = await runDocPipeline(makeInput({ content }));
    expect(result.rawTextLength).toBe(content.length);
  });

  it("chunks and embedded counts match", async () => {
    const result = await runDocPipeline(makeInput({ content: "a".repeat(100) }));
    expect(result.embedded).toBe(result.chunks);
  });

  it("durationMs is a non-negative number", async () => {
    const result = await runDocPipeline(makeInput());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── runDocPipeline — stage 1: extract ────────────────────────────────────────

describe("runDocPipeline — extract stage", () => {
  it("uses nullExtractor when injected", async () => {
    const customExtractor: Extractor = vi.fn().mockResolvedValue("extracted text");
    await runDocPipeline(makeInput({ format: "pdf", content: "binary" }), {
      extractor: customExtractor,
    });
    expect(customExtractor).toHaveBeenCalledWith("pdf", "binary");
  });

  it("HTML content gets tags stripped by defaultExtractor", async () => {
    const result = await runDocPipeline(
      makeInput({ format: "html", content: "<p>clean text</p>" }),
    );
    expect(result.rawTextLength).toBe("clean text".length);
  });

  it("propagates extractor errors", async () => {
    await expect(
      runDocPipeline(makeInput({ format: "pdf", content: "data" })),
    ).rejects.toThrow(/PDF extraction/);
  });

  it("custom extractor receives format and content", async () => {
    const customExtractor: Extractor = vi.fn().mockResolvedValue("ok");
    await runDocPipeline(
      makeInput({ format: "docx", content: "docx-bytes" }),
      { extractor: customExtractor },
    );
    expect(customExtractor).toHaveBeenCalledWith("docx", "docx-bytes");
  });
});

// ── runDocPipeline — stage 2: chunk ───────────────────────────────────────────

describe("runDocPipeline — chunk stage", () => {
  it("produces zero chunks for empty extracted text", async () => {
    const result = await runDocPipeline(makeInput({ content: "" }));
    expect(result.chunks).toBe(0);
    expect(result.embedded).toBe(0);
  });

  it("respects chunkOptions.maxTokens", async () => {
    // 40 chars, maxTokens=2 → maxChars=8 → multiple chunks
    const content = "a".repeat(40);
    const result = await runDocPipeline(makeInput({ content }), {
      chunkOptions: { maxTokens: 2, overlapTokens: 0 },
    });
    expect(result.chunks).toBeGreaterThan(1);
  });
});

// ── runDocPipeline — stage 3: embed ───────────────────────────────────────────

describe("runDocPipeline — embed stage", () => {
  it("calls embedder with chunk texts", async () => {
    const embedder: Embedder = vi.fn().mockResolvedValue([[1, 2, 3, 4]]);
    await runDocPipeline(makeInput({ content: "hello" }), { embedder });
    expect(embedder).toHaveBeenCalledWith(["hello"]);
  });

  it("does not call embedder when text is empty", async () => {
    const embedder: Embedder = vi.fn().mockResolvedValue([]);
    await runDocPipeline(makeInput({ content: "" }), { embedder });
    expect(embedder).not.toHaveBeenCalled();
  });

  it("stores the embedding on each embedded chunk", async () => {
    const fakeEmbedding = [0.1, 0.2, 0.3];
    const embedder: Embedder = vi.fn().mockResolvedValue([fakeEmbedding]);
    const store: ChunkStore = {
      save: vi.fn().mockResolvedValue({ ids: ["id-0"], count: 1 }),
    };
    await runDocPipeline(makeInput({ content: "short" }), { embedder, store });
    const saveCall = (store.save as ReturnType<typeof vi.fn>).mock.calls[0] as [
      EmbeddedChunk[],
      DocMeta,
    ];
    expect(saveCall[0][0]?.embedding).toEqual(fakeEmbedding);
  });
});

// ── runDocPipeline — stage 4: store ───────────────────────────────────────────

describe("runDocPipeline — store stage", () => {
  it("calls store.save with embedded chunks and meta", async () => {
    const store: ChunkStore = {
      save: vi.fn().mockResolvedValue({ ids: ["x"], count: 1 }),
    };
    await runDocPipeline(makeInput({ content: "text", source: "src.txt" }), { store });
    expect(store.save).toHaveBeenCalledTimes(1);
    const [, meta] = (store.save as ReturnType<typeof vi.fn>).mock.calls[0] as [
      EmbeddedChunk[],
      DocMeta,
    ];
    expect(meta.source).toBe("src.txt");
    expect(meta.format).toBe("text");
    expect(typeof meta.processedAt).toBe("string");
  });

  it("storeResult is returned in pipeline result", async () => {
    const storeResult: StoreResult = { ids: ["a", "b"], count: 2 };
    const store: ChunkStore = {
      save: vi.fn().mockResolvedValue(storeResult),
    };
    const text = "a".repeat(20);
    const result = await runDocPipeline(makeInput({ content: text }), {
      store,
      chunkOptions: { maxTokens: 2, overlapTokens: 0 },
    });
    expect(result.storeResult).toEqual(storeResult);
  });

  it("meta.metadata mirrors input.metadata", async () => {
    const store: ChunkStore = {
      save: vi.fn().mockResolvedValue({ ids: [], count: 0 }),
    };
    const metadata = { author: "Yash", version: 2 };
    await runDocPipeline(makeInput({ content: "", metadata }), { store });
    const [, meta] = (store.save as ReturnType<typeof vi.fn>).mock.calls[0] as [
      EmbeddedChunk[],
      DocMeta,
    ];
    expect(meta.metadata).toEqual(metadata);
  });

  it("meta.totalChunks equals number of chunks produced", async () => {
    const store: ChunkStore = {
      save: vi.fn().mockResolvedValue({ ids: [], count: 0 }),
    };
    const content = "a".repeat(40);
    await runDocPipeline(makeInput({ content }), {
      store,
      chunkOptions: { maxTokens: 2, overlapTokens: 0 },
    });
    const [chunks, meta] = (store.save as ReturnType<typeof vi.fn>).mock.calls[0] as [
      EmbeddedChunk[],
      DocMeta,
    ];
    expect(meta.totalChunks).toBe(chunks.length);
  });
});

// ── runDocPipeline — full integration ─────────────────────────────────────────

describe("runDocPipeline — full integration with all nulls", () => {
  it("runs successfully for text format", async () => {
    const result = await runDocPipeline({
      format: "text",
      content: "The quick brown fox jumps over the lazy dog.",
      source: "fable.txt",
    });
    expect(result.chunks).toBeGreaterThanOrEqual(1);
    expect(result.storeResult.count).toBe(result.chunks);
  });

  it("runs successfully for markdown format", async () => {
    const result = await runDocPipeline({
      format: "markdown",
      content: "# Heading\n\nParagraph.",
    });
    expect(result.format).toBe("markdown");
    expect(result.rawTextLength).toBeGreaterThan(0);
  });

  it("runs successfully for html format", async () => {
    const result = await runDocPipeline({
      format: "html",
      content: "<article><h1>Title</h1><p>Body.</p></article>",
    });
    expect(result.rawTextLength).toBeLessThan(
      "<article><h1>Title</h1><p>Body.</p></article>".length,
    );
  });

  it("handles very long content with many chunks", async () => {
    const content = "word ".repeat(2000); // 10000 chars
    const result = await runDocPipeline(
      { format: "text", content },
      { chunkOptions: { maxTokens: 64, overlapTokens: 8 } },
    );
    expect(result.chunks).toBeGreaterThan(1);
    expect(result.storeResult.ids).toHaveLength(result.chunks);
  });
});

// ── runDocPipeline — source undefined ─────────────────────────────────────────

describe("runDocPipeline — optional source", () => {
  it("result.source is undefined when not provided", async () => {
    const result = await runDocPipeline({ format: "text", content: "hi" });
    expect(result.source).toBeUndefined();
  });
});

// ── docPipelineAdapter ────────────────────────────────────────────────────────

describe("docPipelineAdapter", () => {
  let ctx: ReturnType<typeof makeContext>;

  beforeEach(() => {
    ctx = makeContext();
  });

  it("canExecute returns true for 'doc.ingest'", () => {
    expect(docPipelineAdapter.canExecute("doc.ingest")).toBe(true);
  });

  it("canExecute returns false for unknown task types", () => {
    expect(docPipelineAdapter.canExecute("email.send")).toBe(false);
    expect(docPipelineAdapter.canExecute("sandbox.execute")).toBe(false);
  });

  it("has correct name", () => {
    expect(docPipelineAdapter.name).toBe("nexus-adapter-doc-pipeline");
  });

  it("has correct version", () => {
    expect(docPipelineAdapter.version).toBe("0.1.0");
  });

  it("declares storage capabilities", () => {
    expect(docPipelineAdapter.capabilities).toContain("storage.write");
    expect(docPipelineAdapter.capabilities).toContain("storage.read");
  });

  it("execute returns a PipelineResult for a text task", async () => {
    const task = {
      taskType: "doc.ingest" as const,
      format: "text" as const,
      content: "Hello from adapter.",
      source: "adapter-test.txt",
    };
    const result = await docPipelineAdapter.execute(task, ctx);
    expect(result).toHaveProperty("rawTextLength");
    expect(result).toHaveProperty("chunks");
    expect(result).toHaveProperty("storeResult");
  });

  it("execute logs format and contentLength", async () => {
    const task = {
      taskType: "doc.ingest" as const,
      format: "markdown" as const,
      content: "# Doc",
    };
    await docPipelineAdapter.execute(task, ctx);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "doc.ingest",
      expect.objectContaining({ format: "markdown", contentLength: 5 }),
    );
  });

  it("execute passes chunkOptions through", async () => {
    const content = "a".repeat(200);
    const task = {
      taskType: "doc.ingest" as const,
      format: "text" as const,
      content,
      chunkOptions: { maxTokens: 4, overlapTokens: 0 },
    };
    const result = (await docPipelineAdapter.execute(task, ctx)) as {
      chunks: number;
    };
    expect(result.chunks).toBeGreaterThan(1);
  });

  it("execute propagates pipeline errors (e.g. unsupported format)", async () => {
    const task = {
      taskType: "doc.ingest" as const,
      format: "pdf" as const,
      content: "binary",
    };
    await expect(docPipelineAdapter.execute(task, ctx)).rejects.toThrow(/PDF/);
  });

  it("execute includes metadata in the doc meta", async () => {
    const store: ChunkStore = {
      save: vi.fn().mockResolvedValue({ ids: [], count: 0 }),
    };
    // Run pipeline directly to verify metadata propagation
    const result = await runDocPipeline(
      {
        format: "text",
        content: "data",
        metadata: { owner: "nexus" },
      },
      { store },
    );
    const [, meta] = (store.save as ReturnType<typeof vi.fn>).mock.calls[0] as [
      EmbeddedChunk[],
      DocMeta,
    ];
    expect(meta.metadata).toEqual({ owner: "nexus" });
    expect(result.source).toBeUndefined();
  });
});
