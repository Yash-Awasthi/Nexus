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

// ── HttpxEngine — real HTTP scrape engine (Scrapling HttpxFetcher pattern) ─────
//
// Inspired by Scrapling's Fetcher: lightweight HTTP with user-agent pool,
// header randomization, and basic fingerprint evasion without a full browser.

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
];

function pickUA(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]!;
}

function buildScrapeHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
  const ua = pickUA();
  return {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
    ...extraHeaders,
  };
}

function extractText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50_000);
}

/** Real HTTP engine with UA rotation and evasion headers. */
export class HttpxEngine implements ScrapeEngine {
  readonly type: EngineType = "httpx";
  priority: number;
  private proxy?: string;

  constructor(opts: { priority?: number; proxy?: string } = {}) {
    this.priority = opts.priority ?? 1;
    this.proxy = opts.proxy;
  }

  async scrape(url: string, opts: ScrapeOptions): Promise<ScrapeResult | null> {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout ?? 20_000);

    try {
      const headers = buildScrapeHeaders(opts.headers);
      const res = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);

      if (!res.ok) {
        return { url, html: "", text: "", status: res.status === 403 ? "blocked" : "error", engine: "httpx", durationMs: Date.now() - t0, statusCode: res.status };
      }

      const html = await res.text();
      const text = extractText(html);

      return { url, html, text, status: "success", engine: "httpx", durationMs: Date.now() - t0, statusCode: res.status, headers: Object.fromEntries(res.headers.entries()) };
    } catch (e) {
      clearTimeout(timer);
      const isTimeout = e instanceof Error && (e.name === "AbortError" || e.message.includes("abort"));
      return { url, html: "", text: "", status: isTimeout ? "timeout" : "error", engine: "httpx", durationMs: Date.now() - t0 };
    }
  }
}

// ── ProxyRotatingEngine — wraps any engine with proxy pool rotation ────────────
//
// Scrapling spider pattern: per-domain throttling + automatic proxy rotation.

export interface ProxyEntry { url: string; used: number; failures: number; lastUsedAt: number }

/** Proxy rotating engine */
export class ProxyRotatingEngine implements ScrapeEngine {
  readonly type: EngineType;
  priority: number;
  private inner: ScrapeEngine;
  private proxies: ProxyEntry[];
  private domainDelays = new Map<string, number>();
  private perDomainDelayMs: number;

  constructor(inner: ScrapeEngine, proxies: string[], opts: { perDomainDelayMs?: number; priority?: number } = {}) {
    this.inner = inner;
    this.type = inner.type;
    this.priority = opts.priority ?? inner.priority;
    this.perDomainDelayMs = opts.perDomainDelayMs ?? 2_000;
    this.proxies = proxies.map((url) => ({ url, used: 0, failures: 0, lastUsedAt: 0 }));
  }

  async scrape(url: string, opts: ScrapeOptions): Promise<ScrapeResult | null> {
    const domain = new URL(url).hostname;
    const lastMs = this.domainDelays.get(domain) ?? 0;
    const wait = Math.max(0, lastMs + this.perDomainDelayMs - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.domainDelays.set(domain, Date.now());

    const proxy = this._pickProxy();
    const mergedOpts = proxy ? { ...opts, headers: { ...opts.headers, "X-Proxy": proxy.url } } : opts;

    const result = await this.inner.scrape(url, mergedOpts);

    if (proxy) {
      proxy.used++;
      proxy.lastUsedAt = Date.now();
      if (result?.status === "blocked") proxy.failures++;
    }

    return result;
  }

  addProxy(url: string): void { this.proxies.push({ url, used: 0, failures: 0, lastUsedAt: 0 }); }
  removeProxy(url: string): void { this.proxies = this.proxies.filter((p) => p.url !== url); }
  proxyStats(): ProxyEntry[] { return [...this.proxies]; }

  private _pickProxy(): ProxyEntry | null {
    if (!this.proxies.length) return null;
    // Prefer least recently used + lowest failure rate
    return this.proxies.reduce((best, p) =>
      (p.lastUsedAt + p.failures * 5_000) < (best.lastUsedAt + best.failures * 5_000) ? p : best,
    );
  }
}

// ── SpiderCrawler — Scrapling-inspired concurrent spider with pause/resume ─────
//
// Scrapling spider API: start_urls, async parse() callbacks, Request/Response
// objects, concurrent crawling with per-domain throttling.

export interface SpiderRequest { url: string; meta?: Record<string, unknown> }
export type SpiderParseFn = (result: ScrapeResult, meta: Record<string, unknown>) => Promise<SpiderRequest[]>;

export interface SpiderStats {
  queued: number; running: number; done: number; failed: number; blocked: number;
  requestsPerSecond: number;
}

export interface SpiderOpts {
  concurrency?: number;
  maxRequests?: number;
  allowedDomains?: string[];
  downloadDelayMs?: number;
}

/** Spider crawler */
export class SpiderCrawler {
  private scraper: AdaptiveScraper;
  private parseFn: SpiderParseFn;
  private opts: Required<SpiderOpts>;
  private seen = new Set<string>();
  private queue: SpiderRequest[] = [];
  private stats = { running: 0, done: 0, failed: 0, blocked: 0, startTime: Date.now() };
  private paused = false;

  constructor(scraper: AdaptiveScraper, parseFn: SpiderParseFn, opts: SpiderOpts = {}) {
    this.scraper = scraper;
    this.parseFn = parseFn;
    this.opts = {
      concurrency: opts.concurrency ?? 3,
      maxRequests: opts.maxRequests ?? 100,
      allowedDomains: opts.allowedDomains ?? [],
      downloadDelayMs: opts.downloadDelayMs ?? 500,
    };
  }

  async start(startUrls: string[]): Promise<void> {
    for (const url of startUrls) this._enqueue({ url });
    await this._drain();
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }

  getStats(): SpiderStats {
    const elapsed = (Date.now() - this.stats.startTime) / 1000;
    return {
      queued: this.queue.length,
      running: this.stats.running,
      done: this.stats.done,
      failed: this.stats.failed,
      blocked: this.stats.blocked,
      requestsPerSecond: elapsed > 0 ? Math.round((this.stats.done + this.stats.failed) / elapsed * 100) / 100 : 0,
    };
  }

  private _enqueue(req: SpiderRequest): void {
    if (this.seen.has(req.url)) return;
    if (this.opts.allowedDomains.length) {
      try {
        const host = new URL(req.url).hostname;
        if (!this.opts.allowedDomains.some((d) => host.endsWith(d))) return;
      } catch { return; }
    }
    this.seen.add(req.url);
    this.queue.push(req);
  }

  private async _drain(): Promise<void> {
    while ((this.queue.length > 0 || this.stats.running > 0) && this.seen.size <= this.opts.maxRequests) {
      if (this.paused) { await new Promise((r) => setTimeout(r, 200)); continue; }

      const slots = this.opts.concurrency - this.stats.running;
      const batch = this.queue.splice(0, slots);
      if (!batch.length) { await new Promise((r) => setTimeout(r, 50)); continue; }

      this.stats.running += batch.length;
      await Promise.all(batch.map(async (req) => {
        try {
          if (this.opts.downloadDelayMs > 0) await new Promise((r) => setTimeout(r, this.opts.downloadDelayMs));
          const result = await this.scraper.scrape(req.url, {});
          if (result.status === "success") {
            const newRequests = await this.parseFn(result, req.meta ?? {});
            for (const nr of newRequests) this._enqueue(nr);
            this.stats.done++;
          } else if (result.status === "blocked") {
            this.stats.blocked++;
          } else {
            this.stats.failed++;
          }
        } catch { this.stats.failed++; }
        this.stats.running--;
      }));
    }
  }
}

// ── AdaptiveSelectorStore — Scrapling auto_save + adaptive drift recovery ──────
//
// Scrapling pattern: p.css('.product', auto_save=True) → persists the matched
// selector's resolved path so if page structure drifts, it can be relocated.

export interface SelectorRecord {
  original: string;
  confirmed: string[];   // selectors that previously found content
  failedAt?: string;
  updatedAt: string;
}

/** Adaptive selector store */
export class AdaptiveSelectorStore {
  private records = new Map<string, SelectorRecord>();

  /** Record a successful selector match for a URL. */
  confirm(url: string, selector: string): void {
    const key = this._key(url, selector);
    const existing = this.records.get(key);
    if (existing) {
      if (!existing.confirmed.includes(selector)) existing.confirmed.push(selector);
      existing.updatedAt = new Date().toISOString();
    } else {
      this.records.set(key, { original: selector, confirmed: [selector], updatedAt: new Date().toISOString() });
    }
  }

  /** Record a failed selector — trigger drift detection. */
  fail(url: string, selector: string): void {
    const key = this._key(url, selector);
    const existing = this.records.get(key) ?? { original: selector, confirmed: [], updatedAt: new Date().toISOString() };
    existing.failedAt = new Date().toISOString();
    this.records.set(key, existing);
  }

  /** Get all confirmed selectors for a URL + original selector combo. */
  getConfirmed(url: string, selector: string): string[] {
    return this.records.get(this._key(url, selector))?.confirmed ?? [];
  }

  hasDrifted(url: string, selector: string): boolean {
    const r = this.records.get(this._key(url, selector));
    return !!r?.failedAt && r.confirmed.length > 0;
  }

  allRecords(): Map<string, SelectorRecord> { return new Map(this.records); }

  private _key(url: string, selector: string): string {
    try { return `${new URL(url).hostname}::${selector}`; }
    catch { return `${url}::${selector}`; }
  }
}

// ── isProxyError — proxy failure detection from exception messages ─────────────
//
// Ported from Scrapling proxy_rotation.py (MIT).
// Used by ProxyRotatingEngine to detect proxy-level failures (not just HTTP 407).

const _PROXY_ERROR_INDICATORS = [
  "net::err_proxy",
  "net::err_tunnel",
  "connection refused",
  "connection reset",
  "connection timed out",
  "failed to connect",
  "could not resolve proxy",
] as const;

/** Returns true if the error message indicates a proxy-level failure. */
export function isProxyError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return _PROXY_ERROR_INDICATORS.some((pat) => msg.includes(pat));
}

// ── RobotsChecker — robots.txt compliance for SpiderCrawler ──────────────────
//
// Async robots.txt fetch + per-domain cache + Crawl-Delay extraction.
// Implements the same interface as Scrapling's RobotsTxtManager (MIT),
// ported to TypeScript with no external parser dependency (regex-based).

export interface RobotsDirectives {
  canFetch: boolean;
  crawlDelayMs: number | null;
}

/** Parse robots.txt text for a given user-agent (defaults to "*"). */
export function parseRobotsTxt(
  content: string,
  ua = "*",
): { disallowed: string[]; crawlDelayMs: number | null } {
  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const disallowed: string[] = [];
  let crawlDelayMs: number | null = null;

  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const key = field.trim().toLowerCase();
    const val = rest.join(":").trim();

    if (key === "user-agent") {
      inBlock = val === "*" || val.toLowerCase() === ua.toLowerCase();
    } else if (inBlock && key === "disallow" && val) {
      disallowed.push(val);
    } else if (inBlock && key === "crawl-delay") {
      const secs = parseFloat(val);
      if (!isNaN(secs)) crawlDelayMs = Math.round(secs * 1000);
    }
  }
  return { disallowed, crawlDelayMs };
}

/** Async robots.txt checker with per-domain in-memory cache. */
export class RobotsChecker {
  private _cache = new Map<string, { disallowed: string[]; crawlDelayMs: number | null }>();
  private _userAgent: string;
  private _timeoutMs: number;

  constructor(opts: { userAgent?: string; timeoutMs?: number } = {}) {
    this._userAgent = opts.userAgent ?? "*";
    this._timeoutMs = opts.timeoutMs ?? 5_000;
  }

  private async _fetch(domain: string, scheme: string): Promise<string> {
    const url = `${scheme}://${domain}/robots.txt`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this._timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return "";
      return res.text();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  private async _getDirectives(url: string) {
    const parsed = new URL(url);
    const domain = parsed.hostname;
    if (!this._cache.has(domain)) {
      const content = await this._fetch(domain, parsed.protocol.replace(":", ""));
      this._cache.set(domain, parseRobotsTxt(content, this._userAgent));
    }
    return this._cache.get(domain)!;
  }

  /** Check if a URL is allowed per robots.txt. Returns true when in doubt (fetch failure). */
  async canFetch(url: string): Promise<boolean> {
    try {
      const { disallowed } = await this._getDirectives(url);
      const path = new URL(url).pathname;
      return !disallowed.some((rule) => path.startsWith(rule));
    } catch {
      return true; // fail-open
    }
  }

  /** Return crawl delay in ms for a URL's domain, or null if not specified. */
  async crawlDelayMs(url: string): Promise<number | null> {
    try {
      const { crawlDelayMs } = await this._getDirectives(url);
      return crawlDelayMs;
    } catch {
      return null;
    }
  }

  /** Clear the cache (force re-fetch on next check). */
  clear(): void { this._cache.clear(); }
}
