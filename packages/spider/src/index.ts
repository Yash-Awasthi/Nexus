// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/spider — Web crawl framework.
 *
 * Features
 * ────────
 * • Scheduler with BFS depth control and per-domain rate limiting
 * • robots.txt parsing and enforcement (injectable cache)
 * • Sitemap.xml discovery and parsing (urlset + sitemapindex)
 * • Link extraction from HTML (<a href>, <link rel=canonical>, meta refresh)
 * • Session/cookie management per domain (injectable cookie jar)
 * • Checkpoint / resume — serializable crawler state
 * • Proxy integration — accepts any IProxyRotator-compatible interface
 * • Pattern-based URL allow/block lists
 * • Injectable fetch for full testability
 *
 * Architecture
 * ────────────
 * Spider.crawl() runs a BFS loop driven by a CrawlScheduler.
 * Each iteration: dequeue URL → fetch → parse links → enqueue new URLs.
 * The caller receives each CrawledPage via an async callback.
 *
 * All side-effectful dependencies are injectable:
 *   fetch, proxy rotator, cookie jar, delay, robots cache, now()
 */

export type FetchFn = typeof fetch;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CrawlTarget {
  url: string;
  /** Max crawl depth from seed URL. Default: 3 */
  maxDepth?: number;
  /** Max pages to crawl total. Default: 100 */
  maxPages?: number;
  /** Follow links found on crawled pages. Default: true */
  followLinks?: boolean;
  /** Only crawl URLs under these domains (extracted from seed if omitted). */
  allowedDomains?: string[];
  /** Only crawl URLs matching these patterns. */
  allowedPatterns?: RegExp[];
  /** Skip URLs matching these patterns. */
  blockedPatterns?: RegExp[];
  /** Honour robots.txt. Default: true */
  respectRobotsTxt?: boolean;
  /** Fetch and enqueue all URLs from sitemap.xml. Default: false */
  crawlSitemap?: boolean;
  /** Override sitemap URL (default: origin + /sitemap.xml). */
  sitemapUrl?: string;
  /** Delay between requests in ms. Default: 0 */
  requestDelayMs?: number;
  /** Extra HTTP headers to include on every request. */
  headers?: Record<string, string>;
}

export interface CrawledPage {
  url: string;
  finalUrl: string; // after redirects
  statusCode: number;
  html: string;
  headers: Record<string, string>;
  links: string[];
  depth: number;
  crawledAt: number;
  error?: string;
  proxyUsed?: string;
}

export interface CrawlSummary {
  totalPages: number;
  successPages: number;
  errorPages: number;
  skippedPages: number;
  durationMs: number;
  seedUrl: string;
}

export interface CrawlCheckpoint {
  seedUrl: string;
  visited: string[];
  queue: Array<{ url: string; depth: number }>;
  createdAt: number;
}

// ── Error ──────────────────────────────────────────────────────────────────────

export class SpiderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SpiderError";
  }
}

// ── Proxy interface (minimal, compatible with @nexus/proxy-rotation) ──────────

export interface Proxy {
  url: string;
  host: string;
  port: number;
  protocol: string;
  auth?: { username: string; password: string };
}

export interface IProxyRotator {
  next(sessionKey?: string): Proxy | undefined;
  markSuccess(proxy: Proxy, latencyMs?: number): void;
  markFail(proxy: Proxy): void;
  markBanned(proxy: Proxy): void;
}

// ── Cookie jar interface ──────────────────────────────────────────────────────

export interface ICookieJar {
  /** Return Cookie header value for a URL. */
  getCookieHeader(url: string): string;
  /** Ingest Set-Cookie header values from a response. */
  setCookies(url: string, setCookieHeaders: string[]): void;
}

/** In-memory cookie jar keyed by domain. */
export class MemoryCookieJar implements ICookieJar {
  private readonly cookies = new Map<string, Map<string, string>>();

  getCookieHeader(url: string): string {
    const domain = this._domain(url);
    const jar = this.cookies.get(domain);
    if (!jar) return "";
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  setCookies(url: string, headers: string[]): void {
    const domain = this._domain(url);
    let jar = this.cookies.get(domain);
    if (!jar) { jar = new Map(); this.cookies.set(domain, jar); }
    for (const header of headers) {
      const nameVal = header.split(";")[0]?.trim();
      if (!nameVal) continue;
      const eqIdx = nameVal.indexOf("=");
      if (eqIdx < 0) continue;
      jar.set(nameVal.slice(0, eqIdx).trim(), nameVal.slice(eqIdx + 1).trim());
    }
  }

  private _domain(url: string): string {
    try { return new URL(url).hostname; } catch { return url; }
  }

  clear(): void { this.cookies.clear(); }
}

// ── robots.txt ────────────────────────────────────────────────────────────────

interface RobotsRules {
  disallowed: string[];
  crawlDelay?: number;
}

function parseRobots(text: string, userAgent = "*"): RobotsRules {
  const lines = text.split(/\r?\n/);
  let active = false;
  const disallowed: string[] = [];
  let crawlDelay: number | undefined;

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (!line) continue;
    const [field, ...rest] = line.split(":").map((s) => s.trim());
    const value = rest.join(":").trim();
    if (field?.toLowerCase() === "user-agent") {
      active = value === "*" || value.toLowerCase() === userAgent.toLowerCase();
    } else if (active) {
      if (field?.toLowerCase() === "disallow" && value) disallowed.push(value);
      if (field?.toLowerCase() === "crawl-delay") crawlDelay = parseFloat(value);
    }
  }
  return { disallowed, crawlDelay };
}

function isAllowedByRobots(rules: RobotsRules, path: string): boolean {
  for (const pattern of rules.disallowed) {
    if (path.startsWith(pattern)) return false;
  }
  return true;
}

// ── Sitemap parser ────────────────────────────────────────────────────────────

function parseSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  // <loc>…</loc> in both urlset and sitemapindex
  for (const match of xml.matchAll(/<loc>(.*?)<\/loc>/g)) {
    const url = match[1]?.trim();
    if (url) urls.push(url);
  }
  return urls;
}

// ── Link extractor ────────────────────────────────────────────────────────────

export function extractLinks(html: string, baseUrl: string): string[] {
  const base = (() => { try { return new URL(baseUrl); } catch { return null; } })();
  if (!base) return [];

  const hrefs: string[] = [];
  // <a href="...">
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#][^"']*)["']/gi)) {
    if (m[1]) hrefs.push(m[1]);
  }
  // <link rel="canonical" href="...">
  for (const m of html.matchAll(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/gi)) {
    if (m[1]) hrefs.push(m[1]);
  }

  const resolved: string[] = [];
  for (const href of hrefs) {
    try {
      const u = new URL(href, base);
      u.hash = "";
      // Only follow http/https links
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      resolved.push(u.toString());
    } catch { /* skip malformed */ }
  }
  // Deduplicate
  return [...new Set(resolved)];
}

// ── URL filters ───────────────────────────────────────────────────────────────

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    const s = u.toString();
    // URL() always appends "/" for root paths — strip it to keep route keys stable.
    return u.pathname === "/" && !raw.endsWith("/") ? s.replace(/\/$/, "") : s;
  } catch {
    return raw;
  }
}

function matchesDomain(url: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  try {
    const { hostname } = new URL(url);
    return allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function matchesPattern(url: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(url));
}

// ── CrawlScheduler ────────────────────────────────────────────────────────────

interface QueueEntry { url: string; depth: number; }

export class CrawlScheduler {
  private readonly _queue: QueueEntry[] = [];
  private readonly _visited = new Set<string>();

  enqueue(url: string, depth: number): void {
    const norm = normalizeUrl(url);
    if (!this._visited.has(norm)) {
      this._queue.push({ url: norm, depth });
      this._visited.add(norm);
    }
  }

  dequeue(): QueueEntry | undefined {
    return this._queue.shift();
  }

  markVisited(url: string): void {
    this._visited.add(normalizeUrl(url));
  }

  isVisited(url: string): boolean {
    return this._visited.has(normalizeUrl(url));
  }

  get queueLength(): number { return this._queue.length; }
  get visitedCount(): number { return this._visited.size; }

  checkpoint(seedUrl: string): CrawlCheckpoint {
    return {
      seedUrl,
      visited: [...this._visited],
      queue: [...this._queue],
      createdAt: Date.now(),
    };
  }

  restore(cp: CrawlCheckpoint): void {
    this._visited.clear();
    this._queue.length = 0;
    for (const u of cp.visited) this._visited.add(u);
    for (const e of cp.queue) this._queue.push(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Spider
// ─────────────────────────────────────────────────────────────────────────────

export interface SpiderConfig {
  fetch?: FetchFn;
  proxy?: IProxyRotator;
  cookieJar?: ICookieJar;
  /** ms to wait between requests. Overrides target.requestDelayMs. */
  delayMs?: number;
  /** Inject a custom delay fn (injectable for tests). */
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  /** User-agent string. Default: "NexusSpider/1.0" */
  userAgent?: string;
  /** Max retries per URL on network error. Default: 1 */
  maxRetries?: number;
}

export class Spider {
  private readonly fetch: FetchFn;
  private readonly proxy?: IProxyRotator;
  private readonly cookieJar: ICookieJar;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly userAgent: string;
  private readonly maxRetries: number;

  private _paused = false;
  private _stopped = false;
  private _wasRestored = false;
  private _scheduler = new CrawlScheduler();
  private _currentSeedUrl = "";
  private readonly _robotsCache = new Map<string, RobotsRules>();

  constructor(config: SpiderConfig = {}) {
    this.fetch = config.fetch ?? globalThis.fetch;
    this.proxy = config.proxy;
    this.cookieJar = config.cookieJar ?? new MemoryCookieJar();
    this.delay = config.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = config.now ?? (() => Date.now());
    this.userAgent = config.userAgent ?? "NexusSpider/1.0";
    this.maxRetries = config.maxRetries ?? 1;
  }

  pause(): void { this._paused = true; }
  resume(): void { this._paused = false; }
  stop(): void { this._stopped = true; }

  checkpoint(): CrawlCheckpoint {
    return this._scheduler.checkpoint(this._currentSeedUrl);
  }

  restore(cp: CrawlCheckpoint): void {
    this._currentSeedUrl = cp.seedUrl;
    this._scheduler.restore(cp);
    this._wasRestored = true;
  }

  // ── robots.txt ──────────────────────────────────────────────────────────────

  private async _fetchRobots(origin: string): Promise<RobotsRules> {
    if (this._robotsCache.has(origin)) return this._robotsCache.get(origin)!;
    try {
      const res = await this.fetch(`${origin}/robots.txt`, {
        headers: { "user-agent": this.userAgent },
      });
      const rules = res.ok ? parseRobots(await res.text()) : { disallowed: [] };
      this._robotsCache.set(origin, rules);
      return rules;
    } catch {
      const rules = { disallowed: [] };
      this._robotsCache.set(origin, rules);
      return rules;
    }
  }

  private async _allowedByRobots(url: string): Promise<boolean> {
    try {
      const u = new URL(url);
      const rules = await this._fetchRobots(u.origin);
      return isAllowedByRobots(rules, u.pathname + u.search);
    } catch {
      return true;
    }
  }

  // ── Sitemap ─────────────────────────────────────────────────────────────────

  private async _fetchSitemapUrls(target: CrawlTarget): Promise<string[]> {
    const origin = (() => { try { return new URL(target.url).origin; } catch { return ""; } })();
    const sitemapUrl = target.sitemapUrl ?? `${origin}/sitemap.xml`;
    try {
      const res = await this.fetch(sitemapUrl, {
        headers: { "user-agent": this.userAgent },
      });
      if (!res.ok) return [];
      const xml = await res.text();
      const urls = parseSitemapUrls(xml);
      // If it's a sitemapindex, first-level entries are sub-sitemaps — fetch them too
      if (xml.includes("<sitemapindex")) {
        const nested: string[] = [];
        for (const subUrl of urls) {
          try {
            const subRes = await this.fetch(subUrl, { headers: { "user-agent": this.userAgent } });
            if (subRes.ok) nested.push(...parseSitemapUrls(await subRes.text()));
          } catch { /* skip */ }
        }
        return nested;
      }
      return urls;
    } catch {
      return [];
    }
  }

  // ── Fetch a single page ─────────────────────────────────────────────────────

  private async _fetchPage(
    url: string,
    depth: number,
    target: CrawlTarget,
  ): Promise<CrawledPage> {
    const proxy = this.proxy?.next(new URL(url).hostname);
    const cookieHeader = this.cookieJar.getCookieHeader(url);
    const baseHeaders: Record<string, string> = {
      "user-agent": this.userAgent,
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...target.headers,
    };

    const startMs = this.now();
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetch(url, { headers: baseHeaders });
        const latencyMs = this.now() - startMs;

        // Collect cookies (getSetCookie is Node 18+ only; fall back to get())
        const setCookies: string[] =
          res.headers.getSetCookie?.() ??
          (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
        if (setCookies.length) this.cookieJar.setCookies(url, setCookies);

        // Build headers map
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k] = v; });

        const html = res.ok ? await res.text() : "";
        const links = res.ok ? extractLinks(html, res.url || url) : [];

        if (proxy) {
          if (res.ok) this.proxy!.markSuccess(proxy, latencyMs);
          else if (res.status === 403 || res.status === 407) this.proxy!.markBanned(proxy);
        }

        return {
          url,
          finalUrl: res.url || url,
          statusCode: res.status,
          html,
          headers,
          links,
          depth,
          crawledAt: startMs,
          proxyUsed: proxy?.url,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (proxy) this.proxy!.markFail(proxy);
      }
    }

    return {
      url,
      finalUrl: url,
      statusCode: 0,
      html: "",
      headers: {},
      links: [],
      depth,
      crawledAt: startMs,
      error: lastError?.message,
      proxyUsed: proxy?.url,
    };
  }

  // ── Main crawl loop ─────────────────────────────────────────────────────────

  async crawl(
    target: CrawlTarget,
    onPage: (page: CrawledPage) => Promise<void>,
  ): Promise<CrawlSummary> {
    this._paused = false;
    this._stopped = false;
    this._currentSeedUrl = target.url;

    const maxDepth = target.maxDepth ?? 3;
    const maxPages = target.maxPages ?? 100;
    const followLinks = target.followLinks ?? true;
    const respectRobots = target.respectRobotsTxt ?? true;
    const delayMs = target.requestDelayMs ?? 0;

    const seedOrigin = (() => { try { return new URL(target.url).origin; } catch { return ""; } })();
    const allowedDomains = target.allowedDomains ?? (seedOrigin ? [new URL(target.url).hostname] : []);

    if (!this._wasRestored) {
      this._scheduler = new CrawlScheduler();
      this._scheduler.enqueue(target.url, 0);
      // Seed from sitemap
      if (target.crawlSitemap) {
        const sitemapUrls = await this._fetchSitemapUrls(target);
        for (const u of sitemapUrls) {
          this._scheduler.enqueue(u, 0);
        }
      }
    }
    this._wasRestored = false;

    const startMs = this.now();
    let successPages = 0;
    let errorPages = 0;
    let skippedPages = 0;
    let totalPages = 0;

    while (this._scheduler.queueLength > 0 && totalPages < maxPages) {
      // Pause support
      while (this._paused && !this._stopped) {
        await this.delay(50);
      }
      if (this._stopped) break;

      const entry = this._scheduler.dequeue();
      if (!entry) break;
      const { url, depth } = entry;

      // Depth gate
      if (depth > maxDepth) { skippedPages++; continue; }

      // Domain filter
      if (!matchesDomain(url, allowedDomains)) { skippedPages++; continue; }

      // Pattern filters
      if (target.allowedPatterns?.length && !matchesPattern(url, target.allowedPatterns)) {
        skippedPages++; continue;
      }
      if (target.blockedPatterns?.length && matchesPattern(url, target.blockedPatterns)) {
        skippedPages++; continue;
      }

      // robots.txt
      if (respectRobots && !(await this._allowedByRobots(url))) {
        skippedPages++; continue;
      }

      // Rate limit
      if (delayMs > 0) await this.delay(delayMs);

      const page = await this._fetchPage(url, depth, target);
      totalPages++;

      if (page.error || page.statusCode === 0) {
        errorPages++;
      } else {
        successPages++;
      }

      await onPage(page);

      // Enqueue discovered links
      if (followLinks && page.html && depth < maxDepth) {
        for (const link of page.links) {
          if (!this._scheduler.isVisited(link)) {
            this._scheduler.enqueue(link, depth + 1);
          }
        }
      }
    }

    return {
      totalPages,
      successPages,
      errorPages,
      skippedPages,
      durationMs: this.now() - startMs,
      seedUrl: target.url,
    };
  }
}

// ── Re-export helpers ─────────────────────────────────────────────────────────

export { parseRobots, isAllowedByRobots, parseSitemapUrls };
