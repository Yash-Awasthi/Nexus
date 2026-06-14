// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AgentError,
  LibrarianAgent,
  ResearcherAgent,
  FileExplorerAgent,
  type AgentMemory,
  type AgentMemorySearchResult,
  type AgentKG,
  type AgentKGNode,
  type AgentHooks,
  type ResearchRunner,
  type ResearchRunResult,
  type AgentFileSystem,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMemoryResult(text: string, score: number): AgentMemorySearchResult {
  return {
    entry: { id: `id-${text.slice(0, 4)}`, text, metadata: {}, createdAt: 1000 },
    score,
  };
}

function makeNode(name: string, type = "PERSON", confidence = 0.9): AgentKGNode {
  return { id: `n-${name}`, name, type, confidence, sources: ["doc1"] };
}

function makeHooks(aborted = false): AgentHooks {
  return {
    emit: vi.fn().mockResolvedValue({ handled: 1, aborted, errors: [] }),
  };
}

function makeMemory(results: AgentMemorySearchResult[] = []): AgentMemory {
  return {
    recall: vi.fn().mockResolvedValue(results),
    remember: vi.fn().mockResolvedValue(undefined),
  };
}

function makeKG(nodes: AgentKGNode[] = []): AgentKG {
  return {
    queryNodes: vi.fn().mockResolvedValue(nodes),
    ingest: vi.fn().mockResolvedValue({ nodes: 0, edges: 0 }),
  };
}

function makeFS(
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
): AgentFileSystem {
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn(async (d: string) => dirs[d] ?? []),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentError
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentError", () => {
  it("is an Error instance with correct name", () => {
    const e = new AgentError("RECALL_FAILED", "oops");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AgentError");
  });

  it("exposes code and message", () => {
    const e = new AgentError("FILE_READ_FAILED", "not found");
    expect(e.code).toBe("FILE_READ_FAILED");
    expect(e.message).toBe("not found");
  });

  it("stores optional context", () => {
    const e = new AgentError("RESEARCH_FAILED", "err", { query: "q" });
    expect(e.context).toEqual({ query: "q" });
  });

  it("context is undefined when not provided", () => {
    const e = new AgentError("INGEST_FAILED", "err");
    expect(e.context).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LibrarianAgent
// ─────────────────────────────────────────────────────────────────────────────

describe("LibrarianAgent", () => {
  let memory: AgentMemory;
  let kg: AgentKG;
  let hooks: AgentHooks;

  beforeEach(() => {
    memory = makeMemory([
      makeMemoryResult("Alice works at Nexus", 0.9),
      makeMemoryResult("Bob is the CTO", 0.7),
    ]);
    kg = makeKG([makeNode("Alice"), makeNode("Nexus", "ORG", 0.85)]);
    hooks = makeHooks();
  });

  it("returns memories sorted as provided by the store", async () => {
    const agent = new LibrarianAgent({ memory });
    const result = await agent.recall("Alice");
    expect(result.memories).toHaveLength(2);
    expect(result.memories[0]!.score).toBe(0.9);
  });

  it("returns KG entities sorted by descending confidence", async () => {
    const agent = new LibrarianAgent({ memory, kg });
    const result = await agent.recall("Alice");
    expect(result.entities[0]!.name).toBe("Alice");
    expect(result.entities[1]!.name).toBe("Nexus");
  });

  it("contextText includes ## Relevant Memories section", async () => {
    const agent = new LibrarianAgent({ memory });
    const result = await agent.recall("Alice");
    expect(result.contextText).toContain("## Relevant Memories");
    expect(result.contextText).toContain("Alice works at Nexus");
  });

  it("contextText includes ## Known Entities section when KG wired", async () => {
    const agent = new LibrarianAgent({ memory, kg });
    const result = await agent.recall("query");
    expect(result.contextText).toContain("## Known Entities");
    expect(result.contextText).toContain("Alice");
  });

  it("contextText includes score annotation for memories", async () => {
    const agent = new LibrarianAgent({ memory });
    const result = await agent.recall("Alice");
    expect(result.contextText).toContain("[score: 0.900]");
  });

  it("contextText includes confidence annotation for entities", async () => {
    const agent = new LibrarianAgent({ memory, kg });
    const result = await agent.recall("query");
    expect(result.contextText).toContain("confidence: 0.90");
  });

  it("emits agent.observe events twice (start + done)", async () => {
    const agent = new LibrarianAgent({ memory, hooks });
    await agent.recall("test");
    expect(hooks.emit).toHaveBeenCalledTimes(2);
  });

  it("first emit has action recall.start", async () => {
    const agent = new LibrarianAgent({ memory, hooks });
    await agent.recall("test");
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      action: "recall.start",
      query: "test",
    });
  });

  it("second emit has action recall.done with counts", async () => {
    const agent = new LibrarianAgent({ memory, hooks });
    await agent.recall("test");
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[1]![1]).toMatchObject({
      action: "recall.done",
      memoriesReturned: 2,
    });
  });

  it("does not throw when hooks is undefined", async () => {
    const agent = new LibrarianAgent({ memory });
    await expect(agent.recall("test")).resolves.toBeDefined();
  });

  it("does not throw when KG is undefined", async () => {
    const agent = new LibrarianAgent({ memory });
    const result = await agent.recall("test");
    expect(result.entities).toHaveLength(0);
  });

  it("filters memories below minScore", async () => {
    const agent = new LibrarianAgent({ memory });
    const result = await agent.recall("test", { minScore: 0.8 });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.score).toBe(0.9);
  });

  it("respects limit option passed to memory.recall", async () => {
    const agent = new LibrarianAgent({ memory });
    await agent.recall("q", { limit: 3 });
    expect(memory.recall).toHaveBeenCalledWith("q", 3, undefined);
  });

  it("passes filter option to memory.recall", async () => {
    const agent = new LibrarianAgent({ memory });
    const filter = { agentId: "lib-1" };
    await agent.recall("q", { filter });
    expect(memory.recall).toHaveBeenCalledWith("q", expect.any(Number), filter);
  });

  it("respects nodeLimit option passed to kg.queryNodes", async () => {
    const agent = new LibrarianAgent({ memory, kg });
    await agent.recall("q", { nodeLimit: 3 });
    expect(kg.queryNodes).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 }),
    );
  });

  it("passes query as nameContains to kg.queryNodes", async () => {
    const agent = new LibrarianAgent({ memory, kg });
    await agent.recall("Alice");
    expect(kg.queryNodes).toHaveBeenCalledWith(
      expect.objectContaining({ nameContains: "Alice" }),
    );
  });

  it("KG failure is non-fatal, returns empty entities", async () => {
    kg.queryNodes = vi.fn().mockRejectedValue(new Error("KG down"));
    const agent = new LibrarianAgent({ memory, kg });
    const result = await agent.recall("q");
    expect(result.entities).toHaveLength(0);
    // memories still returned
    expect(result.memories).toHaveLength(2);
  });

  it("throws AgentError RECALL_FAILED when memory throws", async () => {
    memory.recall = vi.fn().mockRejectedValue(new Error("store error"));
    const agent = new LibrarianAgent({ memory });
    await expect(agent.recall("q")).rejects.toMatchObject({
      code: "RECALL_FAILED",
    });
  });

  it("hook errors are non-fatal", async () => {
    hooks.emit = vi.fn().mockRejectedValue(new Error("hook err"));
    const agent = new LibrarianAgent({ memory, hooks });
    await expect(agent.recall("q")).resolves.toBeDefined();
  });

  it("contextText is empty string when no memories and no entities", async () => {
    memory = makeMemory([]);
    const agent = new LibrarianAgent({ memory });
    const result = await agent.recall("q");
    expect(result.contextText).toBe("");
  });

  it("contextText token budget is respected — long memories are truncated", async () => {
    const longText = "A".repeat(500);
    memory = makeMemory([
      makeMemoryResult(longText, 0.9),
      makeMemoryResult(longText, 0.8),
      makeMemoryResult(longText, 0.7),
    ]);
    // 64 tokens ≈ 256 chars — only header + first entry should fit
    const agent = new LibrarianAgent({ memory });
    const result = await agent.recall("q", { maxContextTokens: 64 });
    expect(result.contextText).toContain("## Relevant Memories");
    // Should not contain all three entries
    const count = (result.contextText.match(/score:/g) ?? []).length;
    expect(count).toBeLessThan(3);
  });

  it("uses configured name in hook payloads", async () => {
    const agent = new LibrarianAgent({ memory, hooks, name: "my-lib" });
    await agent.recall("q");
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      agent: "my-lib",
    });
  });

  it("defaultRecallLimit is respected when no limit provided", async () => {
    const agent = new LibrarianAgent({ memory, defaultRecallLimit: 7 });
    await agent.recall("q");
    expect(memory.recall).toHaveBeenCalledWith("q", 7, undefined);
  });

  // ── KG error exposure ──────────────────────────────────────────────────────

  it("kgError is undefined on successful recall", async () => {
    const agent = new LibrarianAgent({ memory, kg });
    const result = await agent.recall("Alice");
    expect(result.kgError).toBeUndefined();
  });

  it("kgError is undefined when no KG is wired", async () => {
    const agent = new LibrarianAgent({ memory });
    const result = await agent.recall("Alice");
    expect(result.kgError).toBeUndefined();
  });

  it("kgError is set when KG throws, memories still populated", async () => {
    kg.queryNodes = vi.fn().mockRejectedValue(new Error("KG down"));
    const agent = new LibrarianAgent({ memory, kg });
    const result = await agent.recall("Alice");
    expect(result.kgError).toContain("KG down");
    expect(result.memories).toHaveLength(2);
    expect(result.entities).toHaveLength(0);
  });

  it("kgError message is the stringified Error", async () => {
    const err = new Error("graph timeout");
    kg.queryNodes = vi.fn().mockRejectedValue(err);
    const agent = new LibrarianAgent({ memory, kg });
    const result = await agent.recall("q");
    expect(result.kgError).toBe(String(err));
  });

  // ── keywordSearch ──────────────────────────────────────────────────────────

  it("keywordSearch returns a LibrarianRecallResult", async () => {
    const agent = new LibrarianAgent({ memory });
    const result = await agent.keywordSearch("Alice");
    expect(result).toHaveProperty("memories");
    expect(result).toHaveProperty("entities");
    expect(result).toHaveProperty("contextText");
  });

  it("keywordSearch re-ranks memories by TF score (term frequency)", async () => {
    // "Alice" appears twice in first entry, once in second
    const mem = makeMemory([
      makeMemoryResult("Bob is the CTO at Bob Corp", 0.95),  // high semantic, no 'alice'
      makeMemoryResult("Alice works with Alice at Nexus", 0.6), // low semantic, 2× 'alice'
      makeMemoryResult("Alice is a developer", 0.7),           // 1× 'alice'
    ]);
    const agent = new LibrarianAgent({ memory: mem, defaultRecallLimit: 3 });
    const result = await agent.keywordSearch("alice");
    // Entry with 2× 'alice' should rank first
    expect(result.memories[0]!.entry.text).toContain("Alice works with Alice");
    // Entry with 1× 'alice' should rank second
    expect(result.memories[1]!.entry.text).toContain("Alice is a developer");
  });

  it("keywordSearch uses semantic score as tie-breaker when TF scores are equal", async () => {
    const mem = makeMemory([
      makeMemoryResult("Alice low score", 0.5),   // 1× alice, score 0.5
      makeMemoryResult("Alice high score", 0.9),  // 1× alice, score 0.9
    ]);
    const agent = new LibrarianAgent({ memory: mem, defaultRecallLimit: 2 });
    const result = await agent.keywordSearch("alice");
    // Higher semantic score wins on tie
    expect(result.memories[0]!.entry.text).toContain("high score");
  });

  it("keywordSearch respects limit option", async () => {
    const agent = new LibrarianAgent({ memory, defaultRecallLimit: 10 });
    const result = await agent.keywordSearch("q", { limit: 1 });
    expect(result.memories.length).toBeLessThanOrEqual(1);
  });

  it("keywordSearch includes KG entities when KG is wired", async () => {
    const agent = new LibrarianAgent({ memory, kg });
    const result = await agent.keywordSearch("Alice");
    expect(result.entities).toHaveLength(2);
  });

  it("keywordSearch assembles contextText", async () => {
    const agent = new LibrarianAgent({ memory });
    const result = await agent.keywordSearch("Alice");
    expect(result.contextText).toContain("## Relevant Memories");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ResearcherAgent
// ─────────────────────────────────────────────────────────────────────────────

describe("ResearcherAgent", () => {
  let runner: ResearchRunner;
  let memory: AgentMemory;
  let kg: AgentKG;
  let hooks: AgentHooks;
  const mockResult: ResearchRunResult = {
    ok: true,
    report: "# Report\nSome findings.",
    sources: ["https://example.com"],
    latencyMs: 500,
  };

  beforeEach(() => {
    runner = vi.fn().mockResolvedValue(mockResult);
    memory = makeMemory();
    kg = makeKG();
    hooks = makeHooks();
  });

  it("calls runner with the query", async () => {
    const agent = new ResearcherAgent({ runner });
    await agent.research("AI trends");
    expect(runner).toHaveBeenCalledWith("AI trends", expect.any(Object));
  });

  it("returns query, report, sources and latencyMs", async () => {
    const agent = new ResearcherAgent({ runner });
    const result = await agent.research("AI trends");
    expect(result.query).toBe("AI trends");
    expect(result.report).toBe(mockResult.report);
    expect(result.sources).toEqual(mockResult.sources);
    expect(result.latencyMs).toBe(500);
  });

  it("result.ok reflects runner ok status", async () => {
    const agent = new ResearcherAgent({ runner });
    const result = await agent.research("q");
    expect(result.ok).toBe(true);
  });

  it("stores report in memory when memory.remember is wired", async () => {
    const agent = new ResearcherAgent({ runner, memory });
    const result = await agent.research("AI trends");
    expect(memory.remember).toHaveBeenCalledWith(
      mockResult.report,
      expect.objectContaining({ query: "AI trends" }),
    );
    expect(result.storedInMemory).toBe(true);
  });

  it("does not store in memory when skipMemory is true", async () => {
    const agent = new ResearcherAgent({ runner, memory });
    const result = await agent.research("q", { skipMemory: true });
    expect(memory.remember).not.toHaveBeenCalled();
    expect(result.storedInMemory).toBe(false);
  });

  it("does not store in memory when runner returns ok:false", async () => {
    runner = vi.fn().mockResolvedValue({ ...mockResult, ok: false, error: "timeout" });
    const agent = new ResearcherAgent({ runner, memory });
    const result = await agent.research("q");
    expect(memory.remember).not.toHaveBeenCalled();
    expect(result.storedInMemory).toBe(false);
  });

  it("storedInMemory is false when no memory wired", async () => {
    const agent = new ResearcherAgent({ runner });
    const result = await agent.research("q");
    expect(result.storedInMemory).toBe(false);
  });

  it("ingests report into KG when kg.ingest is wired", async () => {
    const agent = new ResearcherAgent({ runner, kg });
    const result = await agent.research("q");
    expect(kg.ingest).toHaveBeenCalledWith(mockResult.report, { source: "q" });
    expect(result.ingestedIntoKG).toBe(true);
  });

  it("does not ingest into KG when skipKG is true", async () => {
    const agent = new ResearcherAgent({ runner, kg });
    const result = await agent.research("q", { skipKG: true });
    expect(kg.ingest).not.toHaveBeenCalled();
    expect(result.ingestedIntoKG).toBe(false);
  });

  it("ingestedIntoKG is false when no KG wired", async () => {
    const agent = new ResearcherAgent({ runner });
    const result = await agent.research("q");
    expect(result.ingestedIntoKG).toBe(false);
  });

  it("emits agent.observe start and done", async () => {
    const agent = new ResearcherAgent({ runner, hooks });
    await agent.research("q");
    expect(hooks.emit).toHaveBeenCalledTimes(2);
    const calls = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1]).toMatchObject({ action: "research.start", query: "q" });
    expect(calls[1]![1]).toMatchObject({ action: "research.done", ok: true });
  });

  it("emits done payload with storedInMemory and ingestedIntoKG", async () => {
    const agent = new ResearcherAgent({ runner, memory, kg, hooks });
    await agent.research("q");
    const done = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls[1]![1];
    expect(done).toMatchObject({ storedInMemory: true, ingestedIntoKG: true });
  });

  it("passes maxIterations and resultsPerQuery to runner", async () => {
    const agent = new ResearcherAgent({ runner });
    await agent.research("q", { maxIterations: 3, resultsPerQuery: 10 });
    expect(runner).toHaveBeenCalledWith(
      "q",
      expect.objectContaining({ maxIterations: 3, resultsPerQuery: 10 }),
    );
  });

  it("forwards extra metadata to memory.remember", async () => {
    const agent = new ResearcherAgent({ runner, memory });
    await agent.research("q", { metadata: { sessionId: "s1" } });
    expect(memory.remember).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionId: "s1" }),
    );
  });

  it("throws AgentError RESEARCH_FAILED when runner throws", async () => {
    runner = vi.fn().mockRejectedValue(new Error("runner crash"));
    const agent = new ResearcherAgent({ runner });
    await expect(agent.research("q")).rejects.toMatchObject({
      code: "RESEARCH_FAILED",
    });
  });

  it("memory failure is non-fatal — result returned with storedInMemory false", async () => {
    memory.remember = vi.fn().mockRejectedValue(new Error("db down"));
    const agent = new ResearcherAgent({ runner, memory });
    const result = await agent.research("q");
    expect(result.ok).toBe(true);
    expect(result.storedInMemory).toBe(false);
  });

  it("KG failure is non-fatal — result returned with ingestedIntoKG false", async () => {
    kg.ingest = vi.fn().mockRejectedValue(new Error("kg down"));
    const agent = new ResearcherAgent({ runner, kg });
    const result = await agent.research("q");
    expect(result.ok).toBe(true);
    expect(result.ingestedIntoKG).toBe(false);
  });

  it("hook errors are non-fatal", async () => {
    hooks.emit = vi.fn().mockRejectedValue(new Error("hook down"));
    const agent = new ResearcherAgent({ runner, hooks });
    await expect(agent.research("q")).resolves.toBeDefined();
  });

  it("does not emit when hooks is undefined", async () => {
    const agent = new ResearcherAgent({ runner });
    await expect(agent.research("q")).resolves.toBeDefined();
  });

  it("uses custom agent name in hook payloads", async () => {
    const agent = new ResearcherAgent({ runner, hooks, name: "deep-r" });
    await agent.research("q");
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      agent: "deep-r",
    });
  });

  it("latencyMs falls back to elapsed time when runner omits it", async () => {
    const resultNoLatency: ResearchRunResult = { ok: true, report: "r", sources: [] };
    runner = vi.fn().mockResolvedValue(resultNoLatency);
    const agent = new ResearcherAgent({ runner });
    const result = await agent.research("q");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("result.error is propagated from runner", async () => {
    runner = vi.fn().mockResolvedValue({ ...mockResult, ok: false, error: "timeout" });
    const agent = new ResearcherAgent({ runner });
    const result = await agent.research("q");
    expect(result.error).toBe("timeout");
    expect(result.ok).toBe(false);
  });

  it("memory is not called when memory has no remember method", async () => {
    const memNoRemember: AgentMemory = { recall: vi.fn().mockResolvedValue([]) };
    const agent = new ResearcherAgent({ runner, memory: memNoRemember });
    const result = await agent.research("q");
    expect(result.storedInMemory).toBe(false);
  });

  it("KG is not called when kg has no ingest method", async () => {
    const kgNoIngest: AgentKG = { queryNodes: vi.fn().mockResolvedValue([]) };
    const agent = new ResearcherAgent({ runner, kg: kgNoIngest });
    const result = await agent.research("q");
    expect(result.ingestedIntoKG).toBe(false);
  });

  // ── Dedup before KG ingest ─────────────────────────────────────────────────

  it("ingests first call for a query into KG", async () => {
    const agent = new ResearcherAgent({ runner, kg });
    const result = await agent.research("ai-ethics");
    expect(result.ingestedIntoKG).toBe(true);
    expect(kg.ingest).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-ingest same query into KG on second call", async () => {
    const agent = new ResearcherAgent({ runner, kg });
    await agent.research("ai-ethics");
    const second = await agent.research("ai-ethics");
    expect(kg.ingest).toHaveBeenCalledTimes(1); // only once
    expect(second.ingestedIntoKG).toBe(false);
  });

  it("ingests different queries independently (no cross-query dedup)", async () => {
    const agent = new ResearcherAgent({ runner, kg });
    await agent.research("ai-ethics");
    await agent.research("ml-ops");
    expect(kg.ingest).toHaveBeenCalledTimes(2);
  });

  it("dedup is scoped to agent instance — new instance re-ingests", async () => {
    const agent1 = new ResearcherAgent({ runner, kg });
    const agent2 = new ResearcherAgent({ runner, kg });
    await agent1.research("ai-ethics");
    const result = await agent2.research("ai-ethics");
    expect(kg.ingest).toHaveBeenCalledTimes(2);
    expect(result.ingestedIntoKG).toBe(true);
  });

  it("dedup respects skipKG — skipped calls do not mark query as ingested", async () => {
    const agent = new ResearcherAgent({ runner, kg });
    await agent.research("ai-ethics", { skipKG: true });
    // Next call without skipKG should ingest since the skipped one wasn't tracked
    const result = await agent.research("ai-ethics");
    expect(result.ingestedIntoKG).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FileExplorerAgent
// ─────────────────────────────────────────────────────────────────────────────

describe("FileExplorerAgent", () => {
  let fs: AgentFileSystem;
  let hooks: AgentHooks;

  beforeEach(() => {
    fs = makeFS(
      { "/project/src/index.ts": 'export const x = 1;' },
      { "/project/src": ["/project/src/index.ts", "/project/src/utils.ts"] },
    );
    hooks = makeHooks(false);
  });

  // ── readFile ───────────────────────────────────────────────────────────────

  it("readFile returns file content", async () => {
    const agent = new FileExplorerAgent({ fs });
    const content = await agent.readFile("/project/src/index.ts");
    expect(content).toBe("export const x = 1;");
  });

  it("readFile throws AgentError FILE_READ_FAILED on fs error", async () => {
    const agent = new FileExplorerAgent({ fs });
    await expect(agent.readFile("/missing/file.ts")).rejects.toMatchObject({
      code: "FILE_READ_FAILED",
    });
  });

  it("readFile error context includes path", async () => {
    const agent = new FileExplorerAgent({ fs });
    let caught: AgentError | undefined;
    try {
      await agent.readFile("/missing.ts");
    } catch (e) {
      caught = e as AgentError;
    }
    expect(caught?.context).toEqual({ path: "/missing.ts" });
  });

  // ── editFile ───────────────────────────────────────────────────────────────

  it("editFile writes content to fs", async () => {
    const agent = new FileExplorerAgent({ fs });
    await agent.editFile("/project/src/new.ts", "const y = 2;");
    expect(fs.writeFile).toHaveBeenCalledWith("/project/src/new.ts", "const y = 2;");
  });

  it("editFile returns ok:true with path and bytesWritten", async () => {
    const agent = new FileExplorerAgent({ fs });
    const result = await agent.editFile("/project/src/new.ts", "hello");
    expect(result.ok).toBe(true);
    expect(result.path).toBe("/project/src/new.ts");
    expect(result.bytesWritten).toBe(Buffer.byteLength("hello", "utf8"));
  });

  it("editFile emits file.before_edit before writing", async () => {
    const agent = new FileExplorerAgent({ fs, hooks });
    await agent.editFile("/f.ts", "content");
    const emitCalls = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(emitCalls[0]![0]).toBe("file.before_edit");
    // write should have been called after before_edit
    expect(fs.writeFile).toHaveBeenCalled();
  });

  it("before_edit payload includes agent name, path, and newSize", async () => {
    const agent = new FileExplorerAgent({ fs, hooks, name: "explorer" });
    await agent.editFile("/f.ts", "abc");
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      agent: "explorer",
      path: "/f.ts",
      newSize: 3,
    });
  });

  it("editFile emits file.after_edit after successful write", async () => {
    const agent = new FileExplorerAgent({ fs, hooks });
    await agent.editFile("/f.ts", "content");
    const emitCalls = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(emitCalls[1]![0]).toBe("file.after_edit");
  });

  it("after_edit payload includes bytesWritten", async () => {
    const agent = new FileExplorerAgent({ fs, hooks });
    await agent.editFile("/f.ts", "hello");
    const afterPayload = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls[1]![1];
    expect(afterPayload).toMatchObject({ bytesWritten: expect.any(Number) });
  });

  it("editFile aborts when before_edit hook returns aborted:true", async () => {
    hooks = makeHooks(true);
    const agent = new FileExplorerAgent({ fs, hooks });
    const result = await agent.editFile("/f.ts", "content");
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("abort result has path set", async () => {
    hooks = makeHooks(true);
    const agent = new FileExplorerAgent({ fs, hooks });
    const result = await agent.editFile("/f.ts", "content");
    expect(result.path).toBe("/f.ts");
  });

  it("after_edit is NOT emitted when write is aborted", async () => {
    hooks = makeHooks(true);
    const agent = new FileExplorerAgent({ fs, hooks });
    await agent.editFile("/f.ts", "c");
    const calls = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls;
    const afterCalls = calls.filter((c) => c[0] === "file.after_edit");
    expect(afterCalls).toHaveLength(0);
  });

  it("editFile works without hooks — no emit errors", async () => {
    const agent = new FileExplorerAgent({ fs });
    const result = await agent.editFile("/f.ts", "content");
    expect(result.ok).toBe(true);
  });

  it("editFile throws AgentError FILE_WRITE_FAILED on fs.writeFile error", async () => {
    fs.writeFile = vi.fn().mockRejectedValue(new Error("disk full"));
    const agent = new FileExplorerAgent({ fs });
    await expect(agent.editFile("/f.ts", "x")).rejects.toMatchObject({
      code: "FILE_WRITE_FAILED",
    });
  });

  it("editFile throws AgentError HOOK_EMIT_FAILED when before_edit emit throws", async () => {
    hooks.emit = vi.fn().mockRejectedValue(new Error("hook crash"));
    const agent = new FileExplorerAgent({ fs, hooks });
    await expect(agent.editFile("/f.ts", "x")).rejects.toMatchObject({
      code: "HOOK_EMIT_FAILED",
    });
  });

  it("after_edit failure is non-fatal — ok:true still returned", async () => {
    let callCount = 0;
    hooks.emit = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error("after-edit err");
      return { handled: 1, aborted: false, errors: [] };
    });
    const agent = new FileExplorerAgent({ fs, hooks });
    const result = await agent.editFile("/f.ts", "data");
    expect(result.ok).toBe(true);
  });

  // ── listFiles ──────────────────────────────────────────────────────────────

  it("listFiles returns FileInfo array for directory", async () => {
    const agent = new FileExplorerAgent({ fs });
    const files = await agent.listFiles("/project/src");
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ path: "/project/src/index.ts", name: "index.ts" });
  });

  it("listFiles returns empty array for empty directory", async () => {
    fs = makeFS({}, { "/empty": [] });
    const agent = new FileExplorerAgent({ fs });
    const files = await agent.listFiles("/empty");
    expect(files).toHaveLength(0);
  });

  it("listFiles pattern filter is case-insensitive", async () => {
    const agent = new FileExplorerAgent({ fs });
    const files = await agent.listFiles("/project/src", { pattern: "INDEX" });
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("index.ts");
  });

  it("listFiles pattern filters by name segment only", async () => {
    const agent = new FileExplorerAgent({ fs });
    const files = await agent.listFiles("/project/src", { pattern: "utils" });
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("utils.ts");
  });

  it("listFiles with no pattern returns all entries", async () => {
    const agent = new FileExplorerAgent({ fs });
    const files = await agent.listFiles("/project/src");
    expect(files).toHaveLength(2);
  });

  it("listFiles name is last path segment", async () => {
    fs = makeFS({}, { "/": ["a/b/c.ts"] });
    const agent = new FileExplorerAgent({ fs });
    const files = await agent.listFiles("/");
    expect(files[0]!.name).toBe("c.ts");
  });

  it("listFiles throws AgentError FILE_LIST_FAILED on fs.listDir error", async () => {
    fs.listDir = vi.fn().mockRejectedValue(new Error("permission denied"));
    const agent = new FileExplorerAgent({ fs });
    await expect(agent.listFiles("/secret")).rejects.toMatchObject({
      code: "FILE_LIST_FAILED",
    });
  });

  it("listFiles error context includes dir", async () => {
    fs.listDir = vi.fn().mockRejectedValue(new Error("denied"));
    const agent = new FileExplorerAgent({ fs });
    let caught: AgentError | undefined;
    try {
      await agent.listFiles("/secret");
    } catch (e) {
      caught = e as AgentError;
    }
    expect(caught?.context).toEqual({ dir: "/secret" });
  });

  it("sequential edits both emit hooks in correct order", async () => {
    const agent = new FileExplorerAgent({ fs, hooks });
    await agent.editFile("/a.ts", "a");
    await agent.editFile("/b.ts", "b");
    const calls = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toBe("file.before_edit");
    expect(calls[1]![0]).toBe("file.after_edit");
    expect(calls[2]![0]).toBe("file.before_edit");
    expect(calls[3]![0]).toBe("file.after_edit");
  });

  it("uses default name 'file-explorer' in hook payload", async () => {
    const agent = new FileExplorerAgent({ fs, hooks });
    await agent.editFile("/f.ts", "x");
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      agent: "file-explorer",
    });
  });

  it("uses custom name in hook payload", async () => {
    const agent = new FileExplorerAgent({ fs, hooks, name: "fe-custom" });
    await agent.editFile("/f.ts", "x");
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      agent: "fe-custom",
    });
  });

  // ── TF-scored ranking via ListOptions.query ────────────────────────────────

  it("listFiles with query returns FileInfo with score field", async () => {
    const agentFs = makeFS(
      {},
      { "/src": ["/src/auth.ts", "/src/index.ts", "/src/auth-utils.ts"] },
    );
    const agent = new FileExplorerAgent({ fs: agentFs });
    const files = await agent.listFiles("/src", { query: "auth" });
    expect(files.every((f) => f.score !== undefined)).toBe(true);
  });

  it("listFiles with query ranks by TF score descending", async () => {
    const agentFs = makeFS(
      {},
      {
        "/src": [
          "/src/index.ts",          // no 'auth' — score 0
          "/src/auth.ts",           // 'auth' appears once — score 1
          "/src/auth-utils.ts",     // 'auth' appears twice (auth + utils split) — score higher
        ],
      },
    );
    const agent = new FileExplorerAgent({ fs: agentFs });
    const files = await agent.listFiles("/src", { query: "auth" });
    // Files with 'auth' in the name should rank above index.ts
    const scores = files.map((f) => f.score ?? 0);
    // Sorted descending
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]!).toBeGreaterThanOrEqual(scores[i + 1]!);
    }
    // index.ts (no 'auth') should be last
    expect(files[files.length - 1]!.name).toBe("index.ts");
  });

  it("listFiles without query returns FileInfo without score field", async () => {
    const agent = new FileExplorerAgent({ fs });
    const files = await agent.listFiles("/project/src");
    expect(files.every((f) => f.score === undefined)).toBe(true);
  });

  it("listFiles query can be combined with pattern filter", async () => {
    const agentFs = makeFS(
      {},
      {
        "/src": [
          "/src/auth.ts",
          "/src/auth-service.ts",
          "/src/user.ts",           // passes pattern 'ts' but not related to 'auth'
        ],
      },
    );
    const agent = new FileExplorerAgent({ fs: agentFs });
    // pattern filters to .ts files only, then query ranks by 'auth' TF
    const files = await agent.listFiles("/src", { pattern: "auth", query: "auth" });
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.name.includes("auth"))).toBe(true);
    expect(files.every((f) => (f.score ?? 0) > 0)).toBe(true);
  });

  it("listFiles query with no matching terms gives score 0 for all", async () => {
    const agent = new FileExplorerAgent({ fs });
    const files = await agent.listFiles("/project/src", { query: "zzz" });
    expect(files.every((f) => f.score === 0)).toBe(true);
  });

  it("listFiles query with empty directory returns empty array", async () => {
    const agentFs = makeFS({}, { "/empty": [] });
    const agent = new FileExplorerAgent({ fs: agentFs });
    const files = await agent.listFiles("/empty", { query: "anything" });
    expect(files).toHaveLength(0);
  });
});
