// SPDX-License-Identifier: Apache-2.0
/**
 * stealth-browser — Stealth browser abstraction for headless scraping.
 *
 * Provides a testable, injectable browser abstraction that mirrors a
 * patchright/playwright-style API without importing those packages.
 * Real browser integration is done by supplying a BrowserDriver.
 *
 * Features:
 *   • StealthProfile    — fingerprint spoofing configuration
 *   • BrowserDriver     — injectable interface (real: patchright, test: MockDriver)
 *   • MockDriver        — in-memory driver for testing
 *   • PagePool          — reusable page pool with max-size cap
 *   • CloudflareBypass  — heuristic bypass state machine
 *   • StealthPage       — high-level page wrapper (navigate/content/click/type/screenshot)
 *   • StealthBrowser    — lifecycle manager (open/close pool/acquire/release)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StealthProfile {
  userAgent?: string;
  locale?: string;
  timezone?: string;
  viewport?: { width: number; height: number };
  /** Extra HTTP headers injected on every request */
  extraHeaders?: Record<string, string>;
  /** Disable WebRTC leak (default: true) */
  blockWebRtc?: boolean;
  /** Randomise canvas fingerprint (default: true) */
  canvasNoise?: boolean;
}

export interface NavigateResult {
  url: string;
  status: number;
  title: string;
  loadTimeMs: number;
}

export interface ClickOptions {
  delay?: number; // ms between mousedown and mouseup
  button?: "left" | "right" | "middle";
}

export interface TypeOptions {
  delay?: number; // ms per keystroke
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number; // 0-100 (jpeg only)
}

export interface CloudflareBypassResult {
  success: boolean;
  attempts: number;
  method: "none" | "wait" | "js-challenge" | "turnstile" | "failed";
}

// ── BrowserDriver interface ───────────────────────────────────────────────────

export interface BrowserPage {
  navigate(url: string): Promise<NavigateResult>;
  content(): Promise<string>;
  title(): Promise<string>;
  click(selector: string, opts?: ClickOptions): Promise<void>;
  type(selector: string, text: string, opts?: TypeOptions): Promise<void>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
  readonly url: string;
  readonly isClosed: boolean;
}

export interface BrowserDriver {
  newPage(profile?: StealthProfile): Promise<BrowserPage>;
  close(): Promise<void>;
  readonly isOpen: boolean;
}

// ── MockDriver ────────────────────────────────────────────────────────────────

export interface MockPageOptions {
  status?: number;
  html?: string;
  title?: string;
  /** Map selector → true to mark as clickable */
  clickable?: Record<string, boolean>;
  /** Map selector → true to mark as typeable */
  typeable?: Record<string, boolean>;
  /** Whether waitForSelector should throw */
  selectorTimeout?: boolean;
  /** Simulated load time in ms */
  loadTimeMs?: number;
}

export class MockBrowserPage implements BrowserPage {
  private _url = "about:blank";
  private _closed = false;
  private opts: MockPageOptions;
  readonly clicks: Array<{ selector: string; opts?: ClickOptions }> = [];
  readonly types: Array<{ selector: string; text: string; opts?: TypeOptions }> = [];
  readonly navigations: string[] = [];

  constructor(opts: MockPageOptions = {}) {
    this.opts = opts;
  }

  get url(): string { return this._url; }
  get isClosed(): boolean { return this._closed; }

  async navigate(url: string): Promise<NavigateResult> {
    this._url = url;
    this.navigations.push(url);
    return {
      url,
      status: this.opts.status ?? 200,
      title: this.opts.title ?? "Mock Page",
      loadTimeMs: this.opts.loadTimeMs ?? 50,
    };
  }

  async content(): Promise<string> {
    return this.opts.html ?? `<html><body><p>Mock content for ${this._url}</p></body></html>`;
  }

  async title(): Promise<string> {
    return this.opts.title ?? "Mock Page";
  }

  async click(selector: string, opts?: ClickOptions): Promise<void> {
    this.clicks.push({ selector, opts });
    if (this.opts.clickable && !this.opts.clickable[selector]) {
      throw new Error(`Selector not clickable: ${selector}`);
    }
  }

  async type(selector: string, text: string, opts?: TypeOptions): Promise<void> {
    this.types.push({ selector, text, opts });
  }

  async evaluate<T>(fn: string | (() => T)): Promise<T> {
    if (typeof fn === "function") return fn();
    return undefined as T;
  }

  async screenshot(_opts?: ScreenshotOptions): Promise<Buffer> {
    return Buffer.from("mock-screenshot-data");
  }

  async waitForSelector(selector: string, _timeoutMs?: number): Promise<void> {
    if (this.opts.selectorTimeout) {
      throw new Error(`Timeout waiting for selector: ${selector}`);
    }
  }

  async close(): Promise<void> {
    this._closed = true;
  }
}

export class MockBrowserDriver implements BrowserDriver {
  private _open = true;
  private _pageOpts: MockPageOptions;
  readonly pagesCreated: MockBrowserPage[] = [];

  constructor(pageOpts: MockPageOptions = {}) {
    this._pageOpts = pageOpts;
  }

  get isOpen(): boolean { return this._open; }

  async newPage(_profile?: StealthProfile): Promise<BrowserPage> {
    const page = new MockBrowserPage(this._pageOpts);
    this.pagesCreated.push(page);
    return page;
  }

  async close(): Promise<void> {
    this._open = false;
  }
}

// ── PagePool ──────────────────────────────────────────────────────────────────

export interface PagePoolOptions {
  maxSize?: number;
  driver: BrowserDriver;
  profile?: StealthProfile;
}

export class PagePool {
  private idle: BrowserPage[] = [];
  private inUse = new Set<BrowserPage>();
  private maxSize: number;
  private driver: BrowserDriver;
  private profile?: StealthProfile;

  constructor(opts: PagePoolOptions) {
    this.maxSize = opts.maxSize ?? 5;
    this.driver = opts.driver;
    this.profile = opts.profile;
  }

  /** Acquire a page from the pool (creates new if idle pool is empty and under limit). */
  async acquire(): Promise<BrowserPage> {
    // Reclaim any closed pages from idle
    this.idle = this.idle.filter((p) => !p.isClosed);

    const existing = this.idle.pop();
    if (existing) {
      this.inUse.add(existing);
      return existing;
    }

    if (this.inUse.size >= this.maxSize) {
      throw new Error(`PagePool exhausted (maxSize=${this.maxSize})`);
    }

    const page = await this.driver.newPage(this.profile);
    this.inUse.add(page);
    return page;
  }

  /** Release a page back to the pool. */
  release(page: BrowserPage): void {
    if (this.inUse.delete(page)) {
      if (!page.isClosed) {
        this.idle.push(page);
      }
    }
  }

  /** Close and discard all pages. */
  async drain(): Promise<void> {
    for (const p of [...this.idle, ...this.inUse]) {
      if (!p.isClosed) await p.close();
    }
    this.idle = [];
    this.inUse.clear();
  }

  get idleCount(): number { return this.idle.length; }
  get inUseCount(): number { return this.inUse.size; }
  get totalCount(): number { return this.idle.length + this.inUse.size; }
}

// ── CloudflareBypass ──────────────────────────────────────────────────────────

export interface CloudflareDetector {
  /** Returns true if the page content looks like a CF challenge. */
  isChallenge(html: string): boolean;
}

export class DefaultCloudflareDector implements CloudflareDetector {
  private patterns = [
    /cf-browser-verification/i,
    /checking your browser/i,
    /ray id:/i,
    /cloudflare/i,
    /__cf_chl_/i,
    /jschl_vc/i,
    /turnstile/i,
  ];

  isChallenge(html: string): boolean {
    return this.patterns.some((p) => p.test(html));
  }
}

export class CloudflareBypass {
  private detector: CloudflareDetector;
  private maxAttempts: number;
  private waitMs: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: {
    detector?: CloudflareDetector;
    maxAttempts?: number;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}) {
    this.detector = opts.detector ?? new DefaultCloudflareDector();
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.waitMs = opts.waitMs ?? 2000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async bypass(page: BrowserPage, url: string): Promise<CloudflareBypassResult> {
    let attempts = 0;

    for (let i = 0; i < this.maxAttempts; i++) {
      attempts++;
      const html = await page.content();

      if (!this.detector.isChallenge(html)) {
        return { success: true, attempts, method: i === 0 ? "none" : "wait" };
      }

      // Try waiting for JS challenge to resolve
      if (i < this.maxAttempts - 1) {
        await this.sleep(this.waitMs);
        await page.navigate(url);
      }
    }

    // Final check after last attempt
    const finalHtml = await page.content();
    if (!this.detector.isChallenge(finalHtml)) {
      return { success: true, attempts, method: "js-challenge" };
    }

    return { success: false, attempts, method: "failed" };
  }
}

// ── StealthPage ───────────────────────────────────────────────────────────────

export class StealthPage {
  private page: BrowserPage;
  private bypass: CloudflareBypass;

  constructor(page: BrowserPage, bypass?: CloudflareBypass) {
    this.page = page;
    this.bypass = bypass ?? new CloudflareBypass({ waitMs: 0 });
  }

  /** Navigate with automatic Cloudflare bypass attempt. */
  async goto(url: string): Promise<NavigateResult & { bypassResult: CloudflareBypassResult }> {
    const nav = await this.page.navigate(url);
    const bypassResult = await this.bypass.bypass(this.page, url);
    return { ...nav, bypassResult };
  }

  async content(): Promise<string> { return this.page.content(); }
  async title(): Promise<string> { return this.page.title(); }
  async click(selector: string, opts?: ClickOptions): Promise<void> { return this.page.click(selector, opts); }
  async type(selector: string, text: string, opts?: TypeOptions): Promise<void> { return this.page.type(selector, text, opts); }
  async evaluate<T>(fn: string | (() => T)): Promise<T> { return this.page.evaluate(fn); }
  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> { return this.page.screenshot(opts); }
  async waitForSelector(selector: string, timeoutMs?: number): Promise<void> { return this.page.waitForSelector(selector, timeoutMs); }
  async close(): Promise<void> { return this.page.close(); }

  get url(): string { return this.page.url; }
  get isClosed(): boolean { return this.page.isClosed; }
  get rawPage(): BrowserPage { return this.page; }
}

// ── StealthBrowser ────────────────────────────────────────────────────────────

export interface StealthBrowserOptions {
  driver: BrowserDriver;
  profile?: StealthProfile;
  poolSize?: number;
  bypass?: CloudflareBypass;
}

export class StealthBrowser {
  private pool: PagePool;
  private driver: BrowserDriver;
  private bypass: CloudflareBypass;
  private profile?: StealthProfile;

  constructor(opts: StealthBrowserOptions) {
    this.driver = opts.driver;
    this.profile = opts.profile;
    this.bypass = opts.bypass ?? new CloudflareBypass({ waitMs: 0 });
    this.pool = new PagePool({
      driver: opts.driver,
      profile: opts.profile,
      maxSize: opts.poolSize ?? 5,
    });
  }

  /** Acquire a StealthPage from the pool. */
  async acquire(): Promise<StealthPage> {
    const page = await this.pool.acquire();
    return new StealthPage(page, this.bypass);
  }

  /** Release a StealthPage back to the pool. */
  release(page: StealthPage): void {
    this.pool.release(page.rawPage);
  }

  /** Acquire, run callback, release — handles cleanup automatically. */
  async withPage<T>(fn: (page: StealthPage) => Promise<T>): Promise<T> {
    const page = await this.acquire();
    try {
      return await fn(page);
    } finally {
      this.release(page);
    }
  }

  /** Close all pooled pages and the underlying driver. */
  async close(): Promise<void> {
    await this.pool.drain();
    await this.driver.close();
  }

  get isOpen(): boolean { return this.driver.isOpen; }
  get pool_(): PagePool { return this.pool; }
}
