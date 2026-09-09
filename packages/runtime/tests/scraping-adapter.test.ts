// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  url: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../src/bridge-manager.js", () => ({
  getBridgeManager: () => ({ url: mocks.url }),
  BridgeManager: { post: mocks.post },
}));

import type { IExecutionContext } from "../src/interfaces/execution.interface.js";
import { ScrapingExecutionAdapter } from "../src/scraping-adapter.js";

function telemetry() {
  return {
    browserSessionsActive: 0,
    navigationHistory: [] as string[],
    totalBytesWritten: 0,
    totalBytesFetched: 0,
    recordNavigation: vi.fn(),
    recordFetch: vi.fn(),
  };
}

const ctx = {
  taskId: "st-1",
  startTime: new Date(),
  attempt: 1,
  environment: {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as IExecutionContext;

beforeEach(() => {
  mocks.url.mockReset();
  mocks.post.mockReset();
  mocks.url.mockResolvedValue("http://localhost:7702");
});

describe("ScrapingExecutionAdapter", () => {
  it("only handles the scraping task type", () => {
    const adapter = new ScrapingExecutionAdapter(telemetry() as never, true);
    expect(adapter.canExecute("scraping")).toBe(true);
    expect(adapter.canExecute("browser")).toBe(false);
  });

  it("blocks unsafe urls", async () => {
    const adapter = new ScrapingExecutionAdapter(telemetry() as never, true);
    const out = await adapter.executeScrapingTask({
      id: "1",
      url: "file:///secret",
      selectors: ["title"],
      maxDepth: 1,
      maxRequests: 5,
    });
    expect(out.success).toBe(false);
    expect(out.data.error).toBe("BLOCKED_BY_SAFETY_POLICY");
  });

  it("simulates offline crawling up to the request quota and records telemetry", async () => {
    const t = telemetry();
    const adapter = new ScrapingExecutionAdapter(t as never, true);
    const out = await adapter.executeScrapingTask({
      id: "1",
      url: "https://news.example",
      selectors: ["h1", ".headline"],
      maxDepth: 1,
      maxRequests: 3,
    });
    expect(out.success).toBe(true);
    expect(out.requestsCount).toBe(3);
    expect(out.bytesFetched).toBe(450);
    expect(out.data).toEqual({
      h1: expect.stringContaining("h1"),
      ".headline": expect.stringContaining(".headline"),
    });
    expect(t.recordFetch).toHaveBeenCalledTimes(3);
  });

  it("respects a custom maxRequests quota", async () => {
    const t = telemetry();
    const adapter = new ScrapingExecutionAdapter(t as never, true);
    const out = await adapter.executeScrapingTask({
      id: "2",
      url: "https://example.com",
      selectors: [],
      maxDepth: 1,
      maxRequests: 2,
    });
    expect(out.requestsCount).toBe(2);
    expect(out.data).toEqual({});
  });

  it("uses stealth mode for bot-protected hosts", async () => {
    mocks.post.mockResolvedValue({
      success: true,
      url: "https://linkedin.com/x",
      status_code: 200,
      html: "<html>linkedin</html>",
      text: "linkedin text",
      extracted: {},
      pages_crawled: 1,
      bytes_fetched: 500,
      error: "",
    });
    const t = telemetry();
    const adapter = new ScrapingExecutionAdapter(t as never, false);
    const out = await adapter.executeScrapingTask({
      id: "3",
      url: "https://linkedin.com/jobs",
      selectors: [],
      maxDepth: 1,
      maxRequests: 5,
    });
    expect(out.success).toBe(true);
    expect(mocks.post).toHaveBeenCalledWith(
      "http://localhost:7702",
      "/fetch_stealth",
      expect.anything(),
    );
    expect(out.data.__text__).toBe("linkedin text");
    expect(t.recordFetch).toHaveBeenCalledWith(500);
  });

  it("uses the plain fetch endpoint for normal hosts and merges selector results", async () => {
    mocks.post.mockResolvedValue({
      success: true,
      url: "https://blog.example",
      status_code: 200,
      html: "<html>blog</html>",
      text: "",
      extracted: { title: "My Post" },
      pages_crawled: 2,
      bytes_fetched: 700,
      error: "",
    });
    const t = telemetry();
    const adapter = new ScrapingExecutionAdapter(t as never, false);
    const out = await adapter.executeScrapingTask({
      id: "4",
      url: "https://blog.example/p",
      selectors: ["title"],
      maxDepth: 1,
      maxRequests: 5,
    });
    expect(out.success).toBe(true);
    expect(mocks.post).toHaveBeenCalledWith("http://localhost:7702", "/fetch", expect.anything());
    expect(out.data.title).toBe("My Post");
    expect(out.requestsCount).toBe(2);
  });

  it("reports bridge failure results and network errors", async () => {
    const t = telemetry();
    mocks.post.mockResolvedValueOnce({
      success: false,
      error: "429 blocked",
      url: "",
      status_code: 429,
      html: "",
      text: "",
      extracted: {},
      pages_crawled: 0,
      bytes_fetched: 0,
    });
    const adapter = new ScrapingExecutionAdapter(t as never, false);
    const failed = await adapter.executeScrapingTask({
      id: "5",
      url: "https://example.com",
      selectors: [],
      maxDepth: 1,
      maxRequests: 5,
    });
    expect(failed.success).toBe(false);
    expect(failed.data.error).toBe("429 blocked");

    mocks.post.mockRejectedValueOnce(new Error("bridge timeout"));
    const thrown = await adapter.executeScrapingTask({
      id: "6",
      url: "https://example.com",
      selectors: [],
      maxDepth: 1,
      maxRequests: 5,
    });
    expect(thrown.success).toBe(false);
    expect(thrown.data.error).toBe("bridge timeout");
  });

  it("execute() maps task payloads into scraping tasks", async () => {
    const t = telemetry();
    const adapter = new ScrapingExecutionAdapter(t as never, true);
    const out = await adapter.execute(
      { payload: { url: "https://example.com", selectors: ["a"], maxRequests: 2 } },
      ctx,
    );
    expect(out.success).toBe(true);
    expect(out.requestsCount).toBe(2);
  });
});
