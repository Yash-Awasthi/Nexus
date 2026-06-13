// SPDX-License-Identifier: Apache-2.0
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { tavilyAdapter } from "../src/index.js";

function makeCtx(env: Record<string, string> = {}): IExecutionContext {
  return {
    taskId: "task-test",
    startTime: new Date(),
    attempt: 1,
    environment: env,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return response;
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("tavilyAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(tavilyAdapter.name).toBe("nexus-adapter-tavily"));
    it("exposes search.web capability", () => {
      expect(tavilyAdapter.capabilities).toContain("search.web");
    });
  });

  describe("canExecute()", () => {
    it("handles tavily.search", () => expect(tavilyAdapter.canExecute("tavily.search")).toBe(true));
    it("handles tavily.extract", () =>
      expect(tavilyAdapter.canExecute("tavily.extract")).toBe(true));
    it("rejects unknown types", () => expect(tavilyAdapter.canExecute("groq.chat")).toBe(false));
  });

  describe("execute() — tavily.search", () => {
    it("POSTs to /search and returns results", async () => {
      const body = { answer: "42", query: "test", results: [], responseTime: 100 };
      mockFetch(200, body);
      const ctx = makeCtx({ TAVILY_API_KEY: "tvly-key" });
      const result = await tavilyAdapter.execute(
        { taskType: "tavily.search", query: "AI news" },
        ctx,
      );
      expect(result).toMatchObject({ query: "test", responseTime: 100 });
      expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
      const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
      expect(url).toContain("/search");
    });

    it("throws AdapterConfigError when TAVILY_API_KEY is missing", async () => {
      await expect(
        tavilyAdapter.execute({ taskType: "tavily.search", query: "test" }, makeCtx({})),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(401, "Unauthorized");
      await expect(
        tavilyAdapter.execute(
          { taskType: "tavily.search", query: "fail" },
          makeCtx({ TAVILY_API_KEY: "bad" }),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — tavily.extract", () => {
    it("POSTs to /extract with urls", async () => {
      const body = {
        results: [{ url: "https://example.com", rawContent: "content" }],
        failedResults: [],
      };
      mockFetch(200, body);
      const ctx = makeCtx({ TAVILY_API_KEY: "tvly-key" });
      const result = await tavilyAdapter.execute(
        { taskType: "tavily.extract", urls: ["https://example.com"] },
        ctx,
      );
      expect(result).toMatchObject({ failedResults: [] });
      const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
      expect(url).toContain("/extract");
    });
  });
});
