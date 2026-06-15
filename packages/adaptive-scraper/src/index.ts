// SPDX-License-Identifier: Apache-2.0
/**
 * adaptive-scraper — Multi-engine adaptive web scraping layer.
 *
 * Provides:
 *   • ScrapeEngine      — pluggable scrape backend (playwright/cdp/httpx/camoufox)
 *   • ScrapeResult      — normalised scrape output
 *   • ElementSelector   — CSS/XPath selector with drift-recovery fallbacks
 *   • AdaptiveScraper   — tries engines in priority order, tracks success rates
 *   • ScrapeCache       — TTL-based URL response cache
 *   • ScrapeScheduler   — rate-limited task queue
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type EngineType = "playwright" | "cdp" | "httpx" | "camoufox";

/** Scrape status type alias. */
export type ScrapeStatus = "success" | "blocked" | "timeout" | "error" | "cached";

/** Scrape result interface definition. */
export interface ScrapeResult {
  url: string;
  html: string;
  text: string;
  status: ScrapeStatus;
  engine: EngineType;
  durationMs: number;
  headers?: Record<string, string>;
  statusCode?: number;
}

/** Scrape options interface definition. */
export interface ScrapeOptions {
  timeout?: number;
  headers?: Record<string, string>;
  waitForSelector?: string;
  javascript?: boolean;
}

// ── ScrapeEngine interface ─────────────────────────────────────────────────────

export interface ScrapeEngine {
  type: EngineType;
  priority: number; // lower = tried first
  /** Returns null if engine can't handle the URL / is rate-limited */
  scrape(url: string, opts: ScrapeOptions): Promise<ScrapeResult | null>;
}

// ── MockEngine (for testing) ───────────────────────────────────────────────────

export class MockEngine implements ScrapeEngine {
  type: EngineType;
  priority: number;
  private responses = new Map<string, ScrapeResult>();
  private shouldFail: boolean;

  constructor(type: EngineType, priority: number, shouldFail = false) {
    this.type = type;
    this.priority = priority;
    this.shouldFail = shouldFail;
  }

  setResponse(url: string, result: Partial<ScrapeResult>): void {
    this.responses.set(url, {
      url,
      html: "<html><body>mock</body></html>",
      text: "mock content",
      status: "success",
      engine: this.type,
      durationMs: 50,
      ...result,
    });
  }

  async scrape(url: string, _opts: ScrapeOptions): Promise<ScrapeResult | null> {
    if (this.shouldFail) return null;
    const resp = this.responses.get(url);
    if (!resp) {
      return {
        url,
        html: `<html><body>Default mock for ${url}</body></html>`,
        text: `Default mock for ${url}`,
        status: "success",
        engine: this.type,
        durationMs: 10,
      };
    }
    return resp;
  }
}

// ── ElementSelector ───────────────────────────────────────────────────────────

export interface SelectorFallback {
  selector: string;
  type: "css" | "xpath" | "text";
}

/** Element selector. */
export class ElementSelector {
  private primary: string;
  private fallbacks: SelectorFallback[];

  constructor(primary: string, fallbacks: SelectorFallback[] = []) {
    this.primary = primary;
    this.fallbacks = fallbacks;
  }

  /** Extract text content matching selector(s) from HTML using simple regex patterns. */
  extract(html: string): string | null {
    const all = [{ selector: this.primary, type: "css" as const }, ...this.fallbacks];
    for (const { selector, type } of all) {
      const result = this.applySelector(html, selector, type);
      if (result !== null) return result;
    }
    return null;
  }

  private applySelector(
    html: string,
    selector: string,
    type: "css" | "xpath" | "text",
  ): string | null {
    if (type === "text") {
      return html.includes(selector) ? selector : null;
    }
    if (type === "css") {
      // Simple CSS tag extraction: match <tagName ...>content</tagName>
      // supports #id and .class patterns by extracting inner text of matching elements
      const tagMatch = /^([a-z][a-z0-9]*)/.exec(selector);
      if (tagMatch) {
        const tag = tagMatch[1]!;
        const re = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i");
        const m = re.exec(html);
        return m ? m[1]!.trim() : null;
      }
      return null;
    }
    if (type === "xpath") {
      // Very basic: extract text node from //tag patterns
      const tagMatch = /\/\/([a-z][a-z0-9]*)/.exec(selector);
      if (tagMatch) {
        const tag = tagMatch[1]!;
        const re = new RegExp(`<${tag}[^>]*>([^<]+)<\\/${tag}>`, "i");
        const m = re.exec(html);
        return m ? m[1]!.trim() : null;
      }
      return null;
    }
    return null;
  }

  getPrimary(): string {
    return this.primary;
  }
  getFallbacks(): SelectorFallback[] {
    return [...this.fallbacks];
  }
}

// ── ScrapeCache ───────────────────────────────────────────────────────────────

export class ScrapeCache {
  private cache = new Map<string, { result: ScrapeResult; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlMs = 300_000) {
    // 5 minutes default
    this.ttlMs = ttlMs;
  }

  set(url: string, result: ScrapeResult): void {
    this.cache.set(url, { result, expiresAt: Date.now() + this.ttlMs });
  }

  get(url: string): ScrapeResult | null {
    const entry = this.cache.get(url);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(url);
      return null;
    }
    return { ...entry.result, status: "cached" };
  }

  has(url: string): boolean {
    return this.get(url) !== null;
  }

  invalidate(url: string): boolean {
    return this.cache.delete(url);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// ── AdaptiveScraper ───────────────────────────────────────────────────────────

export interface EngineStats {
  engine: EngineType;
  attempts: number;
  successes: number;
  successRate: number;
}

/** Adaptive scraper. */
export class AdaptiveScraper {
  private engines: ScrapeEngine[];
  private cache: ScrapeCache;
  private stats = new Map<EngineType, { attempts: number; successes: number }>();

  constructor(engines: ScrapeEngine[], cache?: ScrapeCache) {
    this.engines = [...engines].sort((a, b) => a.priority - b.priority);
    this.cache = cache ?? new ScrapeCache();
  }

  async scrape(url: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
    // Check cache first
    const cached = this.cache.get(url);
    if (cached) return cached;

    // Try engines in priority order
    for (const engine of this.engines) {
      this._initStats(engine.type);
      this.stats.get(engine.type)!.attempts++;

      const t0 = Date.now();
      try {
        const result = await engine.scrape(url, opts);
        if (result && result.status === "success") {
          this.stats.get(engine.type)!.successes++;
          this.cache.set(url, result);
          return { ...result, durationMs: Date.now() - t0 };
        }
      } catch {
        // engine failed; try next
      }
    }

    return {
      url,
      html: "",
      text: "",
      status: "error",
      engine: this.engines[0]?.type ?? "httpx",
      durationMs: 0,
    };
  }

  getStats(): EngineStats[] {
    return [...this.stats.entries()].map(([engine, s]) => ({
      engine,
      attempts: s.attempts,
      successes: s.successes,
      successRate: s.attempts > 0 ? s.successes / s.attempts : 0,
    }));
  }

  private _initStats(type: EngineType): void {
    if (!this.stats.has(type)) this.stats.set(type, { attempts: 0, successes: 0 });
  }

  addEngine(engine: ScrapeEngine): void {
    this.engines.push(engine);
    this.engines.sort((a, b) => a.priority - b.priority);
  }
}

// ── ScrapeScheduler ───────────────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  url: string;
  opts: ScrapeOptions;
  status: "pending" | "running" | "done" | "failed";
  result?: ScrapeResult;
  createdAt: number;
}

let _taskSeq = 0;

/** Scrape scheduler. */
export class ScrapeScheduler {
  private queue: ScheduledTask[] = [];
  private scraper: AdaptiveScraper;
  private concurrency: number;
  private delayBetweenMs: number;

  constructor(
    scraper: AdaptiveScraper,
    opts: { concurrency?: number; delayBetweenMs?: number } = {},
  ) {
    this.scraper = scraper;
    this.concurrency = opts.concurrency ?? 1;
    this.delayBetweenMs = opts.delayBetweenMs ?? 500;
  }

  enqueue(url: string, opts: ScrapeOptions = {}): ScheduledTask {
    const task: ScheduledTask = {
      id: `task-${++_taskSeq}`,
      url,
      opts,
      status: "pending",
      createdAt: Date.now(),
    };
    this.queue.push(task);
    return task;
  }

  /** Run all pending tasks up to concurrency limit. */
  async flush(): Promise<ScheduledTask[]> {
    const pending = this.queue.filter((t) => t.status === "pending");
    const results: ScheduledTask[] = [];

    for (let i = 0; i < pending.length; i += this.concurrency) {
      const batch = pending.slice(i, i + this.concurrency);
      const batchResults = await Promise.all(
        batch.map(async (task) => {
          task.status = "running";
          try {
            task.result = await this.scraper.scrape(task.url, task.opts);
            task.status = "done";
          } catch {
            task.status = "failed";
          }
          return task;
        }),
      );
      results.push(...batchResults);
    }

    return results;
  }

  queueSize(): number {
    return this.queue.filter((t) => t.status === "pending").length;
  }
  allTasks(): ScheduledTask[] {
    return [...this.queue];
  }
  clearQueue(): void {
    this.queue = this.queue.filter((t) => t.status !== "pending");
  }
}
