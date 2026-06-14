// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  MockEngine,
  ElementSelector,
  ScrapeCache,
  AdaptiveScraper,
  ScrapeScheduler,
  type ScrapeResult,
} from "../src/index.js";

// ── MockEngine ────────────────────────────────────────────────────────────────

describe("MockEngine", () => {
  it("returns default response for any URL", async () => {
    const engine = new MockEngine("httpx", 1);
    const result = await engine.scrape("https://example.com", {});
    expect(result).not.toBeNull();
    expect(result!.status).toBe("success");
    expect(result!.engine).toBe("httpx");
  });

  it("returns custom response for configured URL", async () => {
    const engine = new MockEngine("playwright", 1);
    engine.setResponse("https://target.com", { html: "<h1>Hello</h1>", text: "Hello" });
    const result = await engine.scrape("https://target.com", {});
    expect(result!.html).toBe("<h1>Hello</h1>");
    expect(result!.text).toBe("Hello");
  });

  it("returns null when shouldFail=true", async () => {
    const engine = new MockEngine("cdp", 1, true);
    expect(await engine.scrape("https://any.com", {})).toBeNull();
  });
});

// ── ElementSelector ───────────────────────────────────────────────────────────

describe("ElementSelector", () => {
  const html = "<div><h1>Main Title</h1><p>Some text here</p><span>Detail</span></div>";

  it("extracts text from primary CSS selector", () => {
    const sel = new ElementSelector("h1");
    expect(sel.extract(html)).toBe("Main Title");
  });

  it("falls back to next selector when primary fails", () => {
    const sel = new ElementSelector("article", [{ selector: "p", type: "css" }]);
    expect(sel.extract(html)).toBe("Some text here");
  });

  it("uses xpath fallback", () => {
    const sel = new ElementSelector("article", [{ selector: "//span", type: "xpath" }]);
    expect(sel.extract(html)).toBe("Detail");
  });

  it("uses text fallback", () => {
    const sel = new ElementSelector("missing", [{ selector: "Some text here", type: "text" }]);
    expect(sel.extract(html)).toBe("Some text here");
  });

  it("returns null when nothing matches", () => {
    const sel = new ElementSelector("nav");
    expect(sel.extract(html)).toBeNull();
  });

  it("getPrimary and getFallbacks return correct values", () => {
    const fallbacks = [{ selector: "p", type: "css" as const }];
    const sel = new ElementSelector("h1", fallbacks);
    expect(sel.getPrimary()).toBe("h1");
    expect(sel.getFallbacks()).toEqual(fallbacks);
  });
});

// ── ScrapeCache ───────────────────────────────────────────────────────────────

describe("ScrapeCache", () => {
  const mockResult: ScrapeResult = {
    url: "https://example.com",
    html: "<html></html>",
    text: "content",
    status: "success",
    engine: "httpx",
    durationMs: 100,
  };

  it("stores and retrieves results", () => {
    const cache = new ScrapeCache();
    cache.set("https://example.com", mockResult);
    const hit = cache.get("https://example.com");
    expect(hit).not.toBeNull();
    expect(hit!.status).toBe("cached"); // status overridden to 'cached'
    expect(hit!.html).toBe("<html></html>");
  });

  it("returns null for missing URL", () => {
    const cache = new ScrapeCache();
    expect(cache.get("https://missing.com")).toBeNull();
  });

  it("expires entries after TTL", async () => {
    const cache = new ScrapeCache(10); // 10ms TTL
    cache.set("https://example.com", mockResult);
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("https://example.com")).toBeNull();
  });

  it("has() reflects cache state", () => {
    const cache = new ScrapeCache();
    cache.set("https://a.com", mockResult);
    expect(cache.has("https://a.com")).toBe(true);
    expect(cache.has("https://b.com")).toBe(false);
  });

  it("invalidate removes entry", () => {
    const cache = new ScrapeCache();
    cache.set("https://a.com", mockResult);
    expect(cache.invalidate("https://a.com")).toBe(true);
    expect(cache.has("https://a.com")).toBe(false);
  });

  it("clear removes all entries", () => {
    const cache = new ScrapeCache();
    cache.set("https://a.com", mockResult);
    cache.set("https://b.com", mockResult);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

// ── AdaptiveScraper ───────────────────────────────────────────────────────────

describe("AdaptiveScraper", () => {
  it("uses first engine successfully", async () => {
    const e1 = new MockEngine("httpx", 1);
    const scraper = new AdaptiveScraper([e1]);
    const result = await scraper.scrape("https://site.com");
    expect(result.status).toBe("success");
    expect(result.engine).toBe("httpx");
  });

  it("falls back to second engine when first fails", async () => {
    const e1 = new MockEngine("playwright", 1, true); // always fails
    const e2 = new MockEngine("httpx", 2);
    const scraper = new AdaptiveScraper([e1, e2]);
    const result = await scraper.scrape("https://site.com");
    expect(result.status).toBe("success");
    expect(result.engine).toBe("httpx");
  });

  it("returns error result when all engines fail", async () => {
    const e1 = new MockEngine("playwright", 1, true);
    const e2 = new MockEngine("cdp", 2, true);
    const scraper = new AdaptiveScraper([e1, e2]);
    const result = await scraper.scrape("https://site.com");
    expect(result.status).toBe("error");
  });

  it("caches results and returns cached on second call", async () => {
    const e1 = new MockEngine("httpx", 1);
    let callCount = 0;
    const originalScrape = e1.scrape.bind(e1);
    e1.scrape = async (url, opts) => { callCount++; return originalScrape(url, opts); };

    const scraper = new AdaptiveScraper([e1]);
    await scraper.scrape("https://site.com");
    const second = await scraper.scrape("https://site.com");
    expect(second.status).toBe("cached");
    expect(callCount).toBe(1); // only called once
  });

  it("tracks stats per engine", async () => {
    const e1 = new MockEngine("httpx", 1);
    const scraper = new AdaptiveScraper([e1]);
    await scraper.scrape("https://a.com");
    await scraper.scrape("https://b.com");
    const stats = scraper.getStats();
    const httpxStats = stats.find((s) => s.engine === "httpx");
    expect(httpxStats?.attempts).toBe(2);
    expect(httpxStats?.successRate).toBe(1);
  });

  it("addEngine inserts and re-sorts by priority", async () => {
    const e2 = new MockEngine("httpx", 2, true); // fails
    const scraper = new AdaptiveScraper([e2]);
    const e1 = new MockEngine("playwright", 1); // succeeds, lower priority number = tried first
    scraper.addEngine(e1);
    const result = await scraper.scrape("https://new.com");
    expect(result.engine).toBe("playwright");
  });
});

// ── ScrapeScheduler ───────────────────────────────────────────────────────────

describe("ScrapeScheduler", () => {
  let scraper: AdaptiveScraper;
  let scheduler: ScrapeScheduler;

  beforeEach(() => {
    scraper = new AdaptiveScraper([new MockEngine("httpx", 1)]);
    scheduler = new ScrapeScheduler(scraper, { concurrency: 2, delayBetweenMs: 0 });
  });

  it("enqueues tasks", () => {
    scheduler.enqueue("https://a.com");
    scheduler.enqueue("https://b.com");
    expect(scheduler.queueSize()).toBe(2);
  });

  it("flush processes all tasks", async () => {
    scheduler.enqueue("https://a.com");
    scheduler.enqueue("https://b.com");
    const results = await scheduler.flush();
    expect(results).toHaveLength(2);
    expect(results.every((t) => t.status === "done")).toBe(true);
  });

  it("completed tasks have results", async () => {
    scheduler.enqueue("https://site.com");
    const results = await scheduler.flush();
    expect(results[0]!.result).toBeDefined();
    expect(results[0]!.result!.url).toBe("https://site.com");
  });

  it("clearQueue removes only pending tasks", async () => {
    scheduler.enqueue("https://a.com");
    await scheduler.flush(); // complete all
    scheduler.enqueue("https://b.com"); // new pending
    scheduler.clearQueue();
    expect(scheduler.queueSize()).toBe(0);
    expect(scheduler.allTasks().filter((t) => t.status === "done")).toHaveLength(1);
  });

  it("allTasks returns all tasks", async () => {
    scheduler.enqueue("https://x.com");
    scheduler.enqueue("https://y.com");
    await scheduler.flush();
    expect(scheduler.allTasks()).toHaveLength(2);
  });
});
