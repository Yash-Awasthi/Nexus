// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock global fetch ─────────────────────────────────────────────────────────

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// ── Imports ───────────────────────────────────────────────────────────────────

import { runDeepResearch } from "../src/index.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const GROQ_KEY = "gsk_test";
const TAVILY_KEY = "tvly_test";

/** Build a Groq API response with the given content string */
function groqResp(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  };
}

/** Build a Tavily search response with n dummy results */
function tavilyResp(n: number, urlPrefix = "https://example.com/") {
  return {
    ok: true,
    json: async () => ({
      results: Array.from({ length: n }, (_, i) => ({
        title: `Result ${i + 1}`,
        url: `${urlPrefix}${i + 1}`,
        content: `Snippet content for result ${i + 1} about the topic in detail.`,
        score: 0.9 - i * 0.05,
      })),
    }),
  };
}

/** Standard pipeline mock sequence:
 *  1 x Groq (planner) → "1. query one\n2. query two"
 *  2 x Tavily (initial searches for 2 queries)
 *  1 x Groq (gap evaluator) → "No gaps."
 *  1 x Groq (synthesizer) → "## Report\n..."
 */
function mockStandardPipeline() {
  fetchMock
    // Planner
    .mockResolvedValueOnce(groqResp("1. query one\n2. query two"))
    // Initial search — query one
    .mockResolvedValueOnce(tavilyResp(3, "https://a.com/"))
    // Initial search — query two
    .mockResolvedValueOnce(tavilyResp(2, "https://b.com/"))
    // Gap evaluator
    .mockResolvedValueOnce(groqResp("No gaps."))
    // Synthesizer
    .mockResolvedValueOnce(groqResp("## Report\n\nSynthesized content [1][2][3]."));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runDeepResearch — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:true with report and citations", async () => {
    mockStandardPipeline();
    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "quantum computing applications" },
      GROQ_KEY,
      TAVILY_KEY,
    );
    expect(result.ok).toBe(true);
    expect(result.report).toContain("## Report");
    expect(result.citations.length).toBe(5); // 3 + 2 unique sources
  });

  it("citations have correct 1-based index, title, url, snippet", async () => {
    mockStandardPipeline();
    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "test topic" },
      GROQ_KEY,
      TAVILY_KEY,
    );
    expect(result.citations[0]).toMatchObject({
      index: 1,
      title: "Result 1",
      url: "https://a.com/1",
    });
    expect(result.citations[0]?.snippet.length).toBeGreaterThan(0);
    expect(result.citations[4]).toMatchObject({
      index: 5,
      url: "https://b.com/2",
    });
  });

  it("accumulates token usage across all LLM calls", async () => {
    mockStandardPipeline();
    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "topic" },
      GROQ_KEY,
      TAVILY_KEY,
    );
    // 3 Groq calls × (10 prompt + 20 completion) = 30 prompt / 60 completion
    expect(result.tokenUsage.promptTokens).toBe(30);
    expect(result.tokenUsage.completionTokens).toBe(60);
  });

  it("records iteration 0 with initial query list", async () => {
    mockStandardPipeline();
    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "topic" },
      GROQ_KEY,
      TAVILY_KEY,
    );
    expect(result.iterations[0]).toMatchObject({
      iteration: 0,
      queries: ["query one", "query two"],
      newSourceCount: 5,
    });
  });

  it("totalLatencyMs is a positive number", async () => {
    mockStandardPipeline();
    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "topic" },
      GROQ_KEY,
      TAVILY_KEY,
    );
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("totalSources equals citations length", async () => {
    mockStandardPipeline();
    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "topic" },
      GROQ_KEY,
      TAVILY_KEY,
    );
    expect(result.totalSources).toBe(result.citations.length);
  });
});

describe("runDeepResearch — gap iterations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fires a follow-up search when evaluator returns gap queries", async () => {
    fetchMock
      // Planner
      .mockResolvedValueOnce(groqResp("1. initial query"))
      // Initial search
      .mockResolvedValueOnce(tavilyResp(2, "https://init.com/"))
      // Gap evaluator — returns 1 gap
      .mockResolvedValueOnce(groqResp("1. gap follow-up query"))
      // Gap search
      .mockResolvedValueOnce(tavilyResp(2, "https://gap.com/"))
      // Second gap eval (maxIterations=1 so only 1 round)
      // Synthesizer
      .mockResolvedValueOnce(groqResp("## Gap Report\n\nExtended content [1]-[4]."));

    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "topic", maxIterations: 1 },
      GROQ_KEY,
      TAVILY_KEY,
    );

    expect(result.iterations).toHaveLength(2); // iter 0 + iter 1
    expect(result.iterations[1]).toMatchObject({
      iteration: 1,
      queries: ["gap follow-up query"],
      newSourceCount: 2,
    });
    expect(result.totalSources).toBe(4);
  });

  it("deduplicates sources by URL across iterations", async () => {
    fetchMock
      // Planner
      .mockResolvedValueOnce(groqResp("1. query A"))
      // Initial search — returns urls a.com/1 and a.com/2
      .mockResolvedValueOnce(tavilyResp(2, "https://a.com/"))
      // Gap eval
      .mockResolvedValueOnce(groqResp("1. gap query"))
      // Gap search — returns a.com/1 (duplicate) and a.com/3 (new)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { title: "Result 1", url: "https://a.com/1", content: "dup", score: 0.9 },
            { title: "Result 3", url: "https://a.com/3", content: "new", score: 0.8 },
          ],
        }),
      })
      // Synthesizer
      .mockResolvedValueOnce(groqResp("## Dedup Report"));

    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "dedup topic", maxIterations: 1 },
      GROQ_KEY,
      TAVILY_KEY,
    );

    // Should have 3 unique sources: a.com/1, a.com/2, a.com/3
    expect(result.totalSources).toBe(3);
    expect(result.iterations[1]?.newSourceCount).toBe(1); // only a.com/3 is new
  });

  it("stops early when maxIterations=0 (no gap rounds)", async () => {
    fetchMock
      // Planner
      .mockResolvedValueOnce(groqResp("1. only query"))
      // Initial search
      .mockResolvedValueOnce(tavilyResp(3, "https://only.com/"))
      // Synthesizer — no gap eval call expected
      .mockResolvedValueOnce(groqResp("## Zero Iter Report"));

    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "topic", maxIterations: 0 },
      GROQ_KEY,
      TAVILY_KEY,
    );

    expect(result.iterations).toHaveLength(1); // only iter 0
    expect(result.totalSources).toBe(3);
    // Only 2 Groq calls: planner + synthesizer (no evaluator)
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 planner + 1 tavily + 1 synth
  });

  it("respects resultsPerQuery cap of 10", async () => {
    fetchMock
      .mockResolvedValueOnce(groqResp("1. single query"))
      .mockResolvedValueOnce(tavilyResp(5))
      .mockResolvedValueOnce(groqResp("No gaps."))
      .mockResolvedValueOnce(groqResp("## Report"));

    await runDeepResearch(
      { taskType: "deep-research.run", query: "topic", resultsPerQuery: 999 },
      GROQ_KEY,
      TAVILY_KEY,
    );

    // Check the Tavily request body for max_results
    const tavilyCallBody = JSON.parse(
      (fetchMock.mock.calls[1] as [string, { body: string }])[1].body,
    ) as { max_results: number };
    expect(tavilyCallBody.max_results).toBe(10); // capped at 10
  });
});

describe("runDeepResearch — error handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws when Groq planner call returns non-OK", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "rate limit exceeded",
    });

    await expect(
      runDeepResearch({ taskType: "deep-research.run", query: "topic" }, GROQ_KEY, TAVILY_KEY),
    ).rejects.toThrow(/Groq API error 429/);
  });

  it("throws AdapterHttpError when Tavily search returns non-OK", async () => {
    fetchMock
      // Planner succeeds
      .mockResolvedValueOnce(groqResp("1. query"))
      // Tavily fails
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      });

    await expect(
      runDeepResearch({ taskType: "deep-research.run", query: "topic" }, GROQ_KEY, TAVILY_KEY),
    ).rejects.toThrow();
  });

  it("throws when synthesizer Groq call returns non-OK", async () => {
    fetchMock
      .mockResolvedValueOnce(groqResp("1. q"))
      .mockResolvedValueOnce(tavilyResp(1))
      .mockResolvedValueOnce(groqResp("No gaps."))
      // Synthesizer fails
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "service unavailable",
      });

    await expect(
      runDeepResearch({ taskType: "deep-research.run", query: "topic" }, GROQ_KEY, TAVILY_KEY),
    ).rejects.toThrow(/Groq API error 503/);
  });
});

describe("runDeepResearch — query and gap parsing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("strips leading numbering and period/paren from planner output", async () => {
    fetchMock
      // Planner returns mixed numbering styles
      .mockResolvedValueOnce(groqResp("1. first query\n2) second query\n3. third"))
      .mockResolvedValueOnce(tavilyResp(1, "https://r1.com/"))
      .mockResolvedValueOnce(tavilyResp(1, "https://r2.com/"))
      .mockResolvedValueOnce(tavilyResp(1, "https://r3.com/"))
      .mockResolvedValueOnce(groqResp("No gaps."))
      .mockResolvedValueOnce(groqResp("## Report"));

    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "topic" },
      GROQ_KEY,
      TAVILY_KEY,
    );
    expect(result.iterations[0]?.queries).toEqual(["first query", "second query", "third"]);
  });

  it("handles empty Tavily results array gracefully", async () => {
    fetchMock
      .mockResolvedValueOnce(groqResp("1. query"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      })
      .mockResolvedValueOnce(groqResp("No gaps."))
      .mockResolvedValueOnce(groqResp("## Empty Report"));

    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "niche topic" },
      GROQ_KEY,
      TAVILY_KEY,
    );
    expect(result.totalSources).toBe(0);
    expect(result.citations).toEqual([]);
  });

  it("treats various 'no gap' phrasings as early-stop signal", async () => {
    const phrasings = ["No gaps.", "None found.", "Evidence is sufficient.", "Already covered."];

    for (const phrasing of phrasings) {
      vi.clearAllMocks();
      fetchMock
        .mockResolvedValueOnce(groqResp("1. q"))
        .mockResolvedValueOnce(tavilyResp(1))
        .mockResolvedValueOnce(groqResp(phrasing))
        .mockResolvedValueOnce(groqResp("## Report"));

      const result = await runDeepResearch(
        { taskType: "deep-research.run", query: "t", maxIterations: 3 },
        GROQ_KEY,
        TAVILY_KEY,
      );
      // Stopped after first gap eval — no gap iteration record
      expect(result.iterations).toHaveLength(1);
    }
  });

  it("caps planner output to 8 queries maximum", async () => {
    const manyQueries = Array.from({ length: 12 }, (_, i) => `${i + 1}. query ${i + 1}`).join("\n");
    // Planner returns 12 queries; should be capped to 8 Tavily calls
    fetchMock.mockResolvedValueOnce(groqResp(manyQueries));
    for (let i = 0; i < 8; i++) fetchMock.mockResolvedValueOnce(tavilyResp(1));
    fetchMock
      .mockResolvedValueOnce(groqResp("No gaps."))
      .mockResolvedValueOnce(groqResp("## Report"));

    const result = await runDeepResearch(
      { taskType: "deep-research.run", query: "broad topic" },
      GROQ_KEY,
      TAVILY_KEY,
    );
    expect(result.iterations[0]?.queries).toHaveLength(8);
  });
});
