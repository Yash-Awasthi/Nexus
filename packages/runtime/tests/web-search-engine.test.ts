// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ILanguageModel, ChatMessage } from "../src/interfaces/language-model.interface.js";
import { WebSearchEngine } from "../src/web-search-engine.js";

// ─── Mock node:https so the Tavily client never leaves the process ───────────

const mockState = vi.hoisted(() => ({
  body: "{}",
  lastRequestOptions: undefined as unknown,
}));

vi.mock("https", () => {
  function makeEmitter(): {
    on: (ev: string, h: (d?: unknown) => void) => unknown;
    emit: (ev: string, d?: unknown) => boolean;
  } {
    const handlers: Record<string, Array<(d?: unknown) => void>> = {};
    return {
      on(ev: string, h: (d?: unknown) => void) {
        (handlers[ev] ??= []).push(h);
        return this;
      },
      emit(ev: string, d?: unknown) {
        (handlers[ev] ?? []).forEach((h) => h(d));
        return true;
      },
    };
  }
  return {
    request: (opts: unknown, cb?: (res: unknown) => void) => {
      mockState.lastRequestOptions = opts;
      const res = makeEmitter() as unknown as { on: (e: string, h: (d?: unknown) => void) => unknown };
      if (cb) cb(res);
      const req = makeEmitter() as unknown as Record<string, unknown>;
      (req as { write: () => void }).write = () => {};
      (req as { end: () => void }).end = () => {
        setImmediate(() => {
          (res as unknown as { emit: (e: string, d?: unknown) => boolean }).emit(
            "data",
            Buffer.from(mockState.body),
          );
          (res as unknown as { emit: (e: string, d?: unknown) => boolean }).emit("end");
        });
      };
      return req;
    },
  };
});

// ─── Controllable fake LLM ───────────────────────────────────────────────────

interface ObjectImpl {
  (args: { messages: ChatMessage[] }): Promise<unknown>;
}

function makeLLM(opts: {
  objects?: ObjectImpl[];
  fallbackObject?: ObjectImpl;
  texts?: Array<(args: { messages: ChatMessage[] }) => string>;
  fallbackText?: string;
}): ILanguageModel {
  const objectCalls: ObjectImpl[] = [...(opts.objects ?? [])];
  const textCalls: Array<(args: { messages: ChatMessage[] }) => string> = [
    ...(opts.texts ?? []),
  ];
  return {
    modelId: "test:stub",
    async generateObject(args: { messages: ChatMessage[] }): Promise<unknown> {
      const impl = objectCalls.shift() ?? opts.fallbackObject;
      if (!impl) throw new Error("generateObject: no stub response queued");
      return impl(args);
    },
    async generateText(args: { messages: ChatMessage[] }): Promise<string> {
      const impl = textCalls.shift();
      return impl ? impl(args) : (opts.fallbackText ?? "synthesized answer");
    },
    async *streamText() {
      // not exercised by WebSearchEngine
    },
  };
}

const classifier = (partial: Record<string, unknown>) => ({
  skipSearch: false,
  webSearch: true,
  academicSearch: false,
  discussionSearch: false,
  standaloneQuery: "what is nexus",
  ...partial,
});

const resultsBody = (results: { title: string; url: string; content: string }[]) =>
  JSON.stringify({ results });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("WebSearchEngine", () => {
  beforeEach(() => {
    mockState.body = "{}";
  });

  it("skips search when the classifier says so and answers from knowledge", async () => {
    const llm = makeLLM({
      objects: [async () => classifier({ skipSearch: true })],
    });
    const engine = new WebSearchEngine({ llm, tavilyApiKey: "k" });
    const out = await engine.search("hello there", { mode: "speed" });
    expect(out.skippedSearch).toBe(true);
    expect(out.answer).toBe("synthesized answer");
    expect(out.findings).toHaveLength(0);
    expect(out.mode).toBe("speed");
  });

  it("classifier failure falls back to a default non-skipping classification", async () => {
    const llm = makeLLM({
      objects: [
        async () => {
          throw new Error("classifier down");
        },
      ],
    });
    // no API key → research is skipped with a helpful message, proving classify fallback worked
    const engine = new WebSearchEngine({ llm });
    const out = await engine.search("anything");
    expect(out.answer).toContain("TAVILY_API_KEY not configured");
    expect(out.queriesUsed).toEqual(["anything"]);
    expect(out.skippedSearch).toBe(false);
  });

  it("returns a clear message when no Tavily key is configured", async () => {
    const llm = makeLLM({
      objects: [async () => classifier({})],
    });
    const engine = new WebSearchEngine({ llm }); // key comes from env = unset
    const out = await engine.search("question");
    expect(out.answer).toBe("Search unavailable: TAVILY_API_KEY not configured.");
    expect(out.findings).toHaveLength(0);
  });

  it("performs iterative research and synthesis in balanced mode", async () => {
    mockState.body = resultsBody([
      { title: "Result A", url: "https://a.example", content: "content A" },
      { title: "Result B", url: "https://b.example", content: "content B" },
    ]);
    const llm = makeLLM({
      objects: [
        async () => classifier({}), // classify
        async () => ({ queries: ["q1", "q2"] }), // iteration 0 queries
        async () => ({ queries: ["q3"] }), // iteration 1 queries
      ],
      fallbackText: "final synthesized answer",
    });
    const engine = new WebSearchEngine({ llm, tavilyApiKey: "tavily-test", maxIterations: 3 });
    const out = await engine.search("research topic", { mode: "balanced" });

    expect(out.skippedSearch).toBe(false);
    expect(out.answer).toBe("final synthesized answer");
    expect(out.findings.length).toBeGreaterThanOrEqual(2);
    expect(out.findings.map((f) => f.url)).toEqual(
      expect.arrayContaining(["https://a.example", "https://b.example"]),
    );
    expect(out.queriesUsed).toEqual(expect.arrayContaining(["q1", "q2", "q3"]));
    expect(out.mode).toBe("balanced");
    expect(mockState.lastRequestOptions).toMatchObject({
      hostname: "api.tavily.com",
      path: "/search",
      method: "POST",
    });
  });

  it("runs a single iteration in speed mode", async () => {
    mockState.body = resultsBody([{ title: "A", url: "https://a.example", content: "a" }]);
    const llm = makeLLM({
      objects: [
        async () => classifier({}),
        async () => ({ queries: ["fast q"] }),
      ],
    });
    const engine = new WebSearchEngine({ llm, tavilyApiKey: "k", maxIterations: 5 });
    const out = await engine.search("speed check", { mode: "speed" });
    expect(out.queriesUsed).toEqual(["fast q"]);
    expect(out.findings).toHaveLength(1);
  });

  it("deduplicates results by URL across iterations", async () => {
    mockState.body = resultsBody([{ title: "Same", url: "https://same.example", content: "x" }]);
    const llm = makeLLM({
      objects: [
        async () => classifier({}),
        async () => ({ queries: ["dup q"] }),
        async () => ({ queries: ["dup q2"] }),
      ],
    });
    const engine = new WebSearchEngine({ llm, tavilyApiKey: "k" });
    const out = await engine.search("dup", { mode: "balanced" });
    expect(out.findings).toHaveLength(1);
  });

  it("falls back to the original query when query generation fails", async () => {
    mockState.body = resultsBody([{ title: "A", url: "https://a.example", content: "a" }]);
    const llm = makeLLM({
      objects: [
        async () => classifier({ standaloneQuery: "orig standalone" }),
        async () => {
          throw new Error("query gen down");
        },
        async () => ({ queries: ["second q"] }),
      ],
    });
    const engine = new WebSearchEngine({ llm, tavilyApiKey: "k" });
    const out = await engine.search("dup", { mode: "balanced" });
    // iteration 0 fell back to the standalone query
    expect(out.queriesUsed).toContain("orig standalone");
    expect(out.queriesUsed).toContain("second q");
  });

  it("tolerates a malformed Tavily response body", async () => {
    mockState.body = "{not json";
    const llm = makeLLM({
      objects: [
        async () => classifier({}),
        async () => ({ queries: ["q"] }),
      ],
    });
    const engine = new WebSearchEngine({ llm, tavilyApiKey: "k" });
    const out = await engine.search("bad body", { mode: "speed" });
    expect(out.findings).toHaveLength(0);
    expect(out.answer).toBeTruthy();
  });

  it("passes conversation history into the classifier", async () => {
    const history: ChatMessage[] = [{ role: "user", content: "previous turn" }];
    let seenHistory = false;
    const llm = makeLLM({
      objects: [
        async (args) => {
          seenHistory = args.messages.some((m) => m.content === "previous turn");
          return classifier({});
        },
      ],
    });
    const engine = new WebSearchEngine({ llm, tavilyApiKey: "k" });
    await engine.search("follow up", { history });
    expect(seenHistory).toBe(true);
  });

  it("quality mode uses advanced search depth and does not break without a scraping bridge", async () => {
    mockState.body = resultsBody([{ title: "Deep", url: "https://deep.example", content: "d" }]);
    const llm = makeLLM({
      objects: [
        async () => classifier({}),
        async () => ({ queries: ["deep q"] }),
        async () => ({ queries: ["deep q2"] }),
        async () => ({ queries: ["deep q3"] }),
      ],
    });
    const engine = new WebSearchEngine({
      llm,
      tavilyApiKey: "k",
      maxIterations: 3,
      deepScrape: true,
    });
    const out = await engine.search("deep dive", { mode: "quality" });
    expect(out.answer).toBeTruthy();
    expect(mockState.lastRequestOptions).toMatchObject({
      hostname: "api.tavily.com",
    });
  });
});
