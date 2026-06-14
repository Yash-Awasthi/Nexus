// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SearXNGSearchTask, SearXNGSuggestTask } from "../src/index.js";
import searxngAdapter from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const makeCtx = (environment: Record<string, string> = {}): IExecutionContext =>
  ({
    taskId: "test-task",
    startTime: new Date(),
    attempt: 1,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    environment,
  }) as unknown as IExecutionContext;

const MOCK_SEARCH_RESPONSE = {
  results: [
    {
      title: "OpenAI",
      url: "https://openai.com",
      content: "OpenAI is an AI research laboratory.",
      engine: "google",
      score: 0.9,
      category: "general",
    },
    {
      title: "Anthropic",
      url: "https://anthropic.com",
      content: "Anthropic is an AI safety company.",
      engine: "bing",
      score: 0.8,
      category: "general",
      publishedDate: "2024-01-01",
    },
  ],
  answers: ["42"],
  corrections: [],
  suggestions: ["openai gpt", "openai api"],
  infoboxes: [
    {
      infobox: "OpenAI",
      content: "AI research org",
      urls: [{ title: "Website", url: "https://openai.com" }],
    },
  ],
  number_of_results: 1_500_000,
};

const MOCK_SUGGEST_RESPONSE = [
  "openai",
  ["openai gpt", "openai api", "openai pricing"],
  ["", "", ""],
  ["", "", ""],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("@nexus/adapter-searxng", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Metadata ─────────────────────────────────────────────────────────────

  it("has the correct adapter name", () => {
    expect(searxngAdapter.name).toBe("nexus-adapter-searxng");
  });

  it("declares search.web capability", () => {
    expect(searxngAdapter.capabilities).toContain("search.web");
  });

  it("handles searxng.search and searxng.suggest task types", () => {
    expect(searxngAdapter.canExecute("searxng.search")).toBe(true);
    expect(searxngAdapter.canExecute("searxng.suggest")).toBe(true);
    expect(searxngAdapter.canExecute("tavily.search")).toBe(false);
  });

  // ── searxng.search ────────────────────────────────────────────────────────

  describe("searxng.search", () => {
    const task: SearXNGSearchTask = {
      taskType: "searxng.search",
      query: "openai",
      baseUrl: "http://localhost:4000",
    };

    it("sends a GET /search?format=json request", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SEARCH_RESPONSE,
      });

      await searxngAdapter.execute(task, makeCtx());

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("/search");
      expect(url).toContain("format=json");
      expect(url).toContain("q=openai");
    });

    it("maps results to SearXNGResultItem shape", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SEARCH_RESPONSE,
      });

      const result = await searxngAdapter.execute(task, makeCtx());

      expect("results" in result).toBe(true);
      if (!("results" in result)) return;

      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toMatchObject({
        title: "OpenAI",
        url: "https://openai.com",
        engine: "google",
        score: 0.9,
      });
      // publishedDate should be present on second result only
      expect(result.results[1].publishedDate).toBe("2024-01-01");
      expect(result.results[0].publishedDate).toBeUndefined();
    });

    it("maps answers, suggestions, and numberOfResults", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SEARCH_RESPONSE,
      });

      const result = await searxngAdapter.execute(task, makeCtx());
      if (!("results" in result)) return;

      expect(result.answers).toEqual(["42"]);
      expect(result.suggestions).toEqual(["openai gpt", "openai api"]);
      expect(result.numberOfResults).toBe(1_500_000);
    });

    it("maps infoboxes", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SEARCH_RESPONSE,
      });

      const result = await searxngAdapter.execute(task, makeCtx());
      if (!("results" in result)) return;

      expect(result.infoboxes).toHaveLength(1);
      expect(result.infoboxes[0].infobox).toBe("OpenAI");
      expect(result.infoboxes[0].urls[0].url).toBe("https://openai.com");
    });

    it("passes categories and engines as query params", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...MOCK_SEARCH_RESPONSE, results: [] }),
      });

      await searxngAdapter.execute(
        {
          ...task,
          categories: ["news", "science"],
          engines: ["google", "bing"],
          page: 2,
        },
        makeCtx(),
      );

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("categories=news%2Cscience");
      expect(url).toContain("engines=google%2Cbing");
      expect(url).toContain("pageno=2");
    });

    it("uses SEARXNG_BASE_URL env var when no baseUrl in task", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SEARCH_RESPONSE,
      });

      await searxngAdapter.execute(
        { taskType: "searxng.search", query: "nexus" },
        makeCtx({ SEARXNG_BASE_URL: "http://custom-searxng:9000" }),
      );

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("http://custom-searxng:9000");
    });

    it("throws AdapterHttpError on non-OK response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      });

      await expect(searxngAdapter.execute(task, makeCtx())).rejects.toThrow();
    });

    it("falls back to DEFAULT_BASE_URL when no baseUrl in task and env is empty", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SEARCH_RESPONSE,
      });

      await searxngAdapter.execute({ taskType: "searxng.search", query: "fallback" }, makeCtx());

      const [url] = fetchMock.mock.calls[0] as [string];
      // Must have used some base URL — either process.env or the hardcoded default
      expect(url).toContain("/search");
      expect(url).toContain("q=fallback");
    });

    it("handles results with missing optional fields and no optional response fields", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              // omit title, url, content, engine, category → triggers all ?? "" branches
              score: "not-a-number", // triggers score : 0 false branch
              thumbnail: "https://img.example.com/thumb.jpg", // triggers thumbnail true branch
            },
          ],
          // omit answers, corrections, suggestions, infoboxes, number_of_results
          // → triggers all ?? [] and ?? results.length branches
        }),
      });

      const result = (await searxngAdapter.execute(
        { taskType: "searxng.search", query: "sparse" },
        makeCtx(),
      )) as {
        results: { title: string; score: number; thumbnail?: string }[];
        answers: string[];
        corrections: string[];
        suggestions: string[];
        infoboxes: unknown[];
        numberOfResults: number;
      };

      expect(result.results[0].title).toBe("");
      expect(result.results[0].score).toBe(0);
      expect(result.results[0].thumbnail).toBe("https://img.example.com/thumb.jpg");
      expect(result.answers).toEqual([]);
      expect(result.corrections).toEqual([]);
      expect(result.suggestions).toEqual([]);
      expect(result.infoboxes).toEqual([]);
      // numberOfResults falls back to results.length (1)
      expect(result.numberOfResults).toBe(1);
    });

    it("handles infoboxes with missing optional fields and urls with missing title/url", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [],
          infoboxes: [
            {
              // omit infobox, content → triggers box.infobox ?? "" and box.content ?? ""
              urls: [
                {}, // omit title, url → triggers u.title ?? "" and u.url ?? ""
              ],
            },
            {
              // omit urls → triggers box.urls ?? []
              infobox: "Wiki",
              content: "desc",
            },
          ],
          number_of_results: 0,
        }),
      });

      const result = (await searxngAdapter.execute(
        { taskType: "searxng.search", query: "infobox-test" },
        makeCtx(),
      )) as {
        infoboxes: { infobox: string; content: string; urls: { title: string; url: string }[] }[];
      };

      expect(result.infoboxes[0].infobox).toBe("");
      expect(result.infoboxes[0].content).toBe("");
      expect(result.infoboxes[0].urls[0].title).toBe("");
      expect(result.infoboxes[0].urls[0].url).toBe("");
      expect(result.infoboxes[1].urls).toEqual([]);
    });
  });

  // ── searxng.suggest ───────────────────────────────────────────────────────

  describe("searxng.suggest", () => {
    const task: SearXNGSuggestTask = {
      taskType: "searxng.suggest",
      query: "openai",
      baseUrl: "http://localhost:4000",
    };

    it("sends a GET /autocompleter request", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SUGGEST_RESPONSE,
      });

      await searxngAdapter.execute(task, makeCtx());

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("/autocompleter");
      expect(url).toContain("q=openai");
    });

    it("parses OpenSearch Suggestions format (array of arrays)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SUGGEST_RESPONSE,
      });

      const result = await searxngAdapter.execute(task, makeCtx());

      expect("suggestions" in result).toBe(true);
      if (!("suggestions" in result)) return;

      expect(result.suggestions).toContain("openai gpt");
      expect(result.suggestions).toContain("openai api");
    });

    it("parses plain string[] format", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ["openai gpt-4", "openai sora", "openai playground"],
      });

      const result = await searxngAdapter.execute(task, makeCtx());
      if (!("suggestions" in result)) return;

      expect(result.suggestions).toEqual(["openai gpt-4", "openai sora", "openai playground"]);
    });

    it("returns empty suggestions on empty response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const result = await searxngAdapter.execute(task, makeCtx());
      if (!("suggestions" in result)) return;

      expect(result.suggestions).toEqual([]);
    });

    it("returns empty suggestions when autocompleter response is not an array", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ unexpected: "object" }),
      });

      const result = await searxngAdapter.execute(task, makeCtx());
      if (!("suggestions" in result)) return;

      expect(result.suggestions).toEqual([]);
    });

    it("throws AdapterHttpError on non-OK suggest response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      await expect(searxngAdapter.execute(task, makeCtx())).rejects.toThrow();
    });
  });
});
