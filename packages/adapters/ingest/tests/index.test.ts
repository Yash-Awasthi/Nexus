// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { ingestAdapter } from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";

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

const SCRAPE_RESP = {
  source: "bloomberg",
  articles: [],
  events: [],
  durationMs: 200,
  scrapedAt: "2024-01-01T12:00:00Z",
};

const BATCH_RESP = {
  results: [],
  totalArticles: 0,
  totalEvents: 0,
  durationMs: 300,
  scrapedAt: "2024-01-01T12:00:00Z",
};

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("ingestAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(ingestAdapter.name).toBe("nexus-adapter-ingest"));
    it("exposes scraping.financial capability", () => {
      expect(ingestAdapter.capabilities).toContain("scraping.financial");
    });
  });

  describe("canExecute()", () => {
    it("handles ingest.scrape", () => expect(ingestAdapter.canExecute("ingest.scrape")).toBe(true));
    it("handles ingest.scrape-batch", () =>
      expect(ingestAdapter.canExecute("ingest.scrape-batch")).toBe(true));
    it("rejects unknown types", () =>
      expect(ingestAdapter.canExecute("tavily.search")).toBe(false));
  });

  describe("execute() — ingest.scrape", () => {
    it("POSTs to /scrape/:source and returns ScrapeResponse", async () => {
      mockFetch(200, SCRAPE_RESP);
      const ctx = makeCtx({ NEXUS_INGEST_URL: "http://ingest:8000" });
      const result = await ingestAdapter.execute(
        { taskType: "ingest.scrape", source: "bloomberg" },
        ctx,
      );
      expect(result).toMatchObject({ source: "bloomberg", durationMs: 200 });
      const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
      expect(url).toBe("http://ingest:8000/scrape/bloomberg");
    });

    it("does not include taskType in the request body", async () => {
      mockFetch(200, SCRAPE_RESP);
      const ctx = makeCtx({ NEXUS_INGEST_URL: "http://ingest:8000" });
      await ingestAdapter.execute({ taskType: "ingest.scrape", source: "reuters" }, ctx);
      const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body["taskType"]).toBeUndefined();
    });

    it("throws AdapterConfigError when NEXUS_INGEST_URL is missing", async () => {
      await expect(
        ingestAdapter.execute({ taskType: "ingest.scrape", source: "yahoo" }, makeCtx({})),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP failure", async () => {
      mockFetch(502, "Bad Gateway");
      await expect(
        ingestAdapter.execute(
          { taskType: "ingest.scrape", source: "bloomberg" },
          makeCtx({ NEXUS_INGEST_URL: "http://ingest:8000" }),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });

  describe("execute() — ingest.scrape-batch", () => {
    it("POSTs to /scrape/batch and returns BatchScrapeResponse", async () => {
      mockFetch(200, BATCH_RESP);
      const ctx = makeCtx({ NEXUS_INGEST_URL: "http://ingest:8000" });
      const result = await ingestAdapter.execute(
        { taskType: "ingest.scrape-batch", sources: ["bloomberg", "reuters"] },
        ctx,
      );
      expect(result).toMatchObject({ totalArticles: 0, totalEvents: 0 });
      const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
      expect(url).toBe("http://ingest:8000/scrape/batch");
    });
  });
});
