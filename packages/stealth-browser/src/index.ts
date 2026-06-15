// SPDX-License-Identifier: Apache-2.0
/**
 * stealth-browser — Stealth browser abstraction for headless scraping.
 *
 * Provides a testable, injectable browser abstraction that mirrors a
 * patchright/playwright-style API without importing those packages.
 * Real browser integration is done by supplying a BrowserDriver.
 *
 * Features:
 *   • StealthProfile      — fingerprint spoofing configuration
 *   • BrowserDriver       — injectable interface (real: patchright, test: MockDriver)
 *   • MockDriver          — in-memory driver for testing
 *   • PatchrightDriver    — real stealth browser via patchright (optional dep)
 *   • PatchrightPage      — BrowserPage wrapper around patchright Page
 *   • isPatchrightAvailable — probe whether patchright is installed
 *   • PagePool            — reusable page pool with max-size cap
 *   • CloudflareBypass    — heuristic bypass state machine
 *   • StealthPage         — high-level page wrapper (navigate/content/click/type/screenshot)
 *   • StealthBrowser      — lifecycle manager (open/close pool/acquire/release)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Rotating user-agent pool — sampled when StealthProfile.userAgent is not set.
 * Covers Chrome, Firefox, Safari across Win/Mac/Linux to maximise coverage.
 */
export const DEFAULT_USER_AGENT_POOL: readonly string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
];

/** Pick random user agent. */
export function pickRandomUserAgent(pool: readonly string[] = DEFAULT_USER_AGENT_POOL): string {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/** Stealth profile interface definition. */
export interface StealthProfile {
  userAgent?: string;
  /** When userAgent is unset, pick from this pool at random (default: DEFAULT_USER_AGENT_POOL). */
  userAgentPool?: readonly string[];
  locale?: string;
  timezone?: string;
  viewport?: { width: number; height: number };
  /** Extra HTTP headers injected on every request */
  extraHeaders?: Record<string, string>;
  /** Disable WebRTC leak (default: true) */
  blockWebRtc?: boolean;
  /** Randomise canvas fingerprint (default: true) */
  canvasNoise?: boolean;
  /** Inject WebGL noise to prevent GPU fingerprinting (default: true) */
  webGlNoise?: boolean;
}

/** Navigate result interface definition. */
export interface NavigateResult {
  url: string;
  status: number;
  title: string;
  loadTimeMs: number;
}

/** Click options interface definition. */
export interface ClickOptions {
  delay?: number; // ms between mousedown and mouseup
  button?: "left" | "right" | "middle";
}

/** Type options interface definition. */
export interface TypeOptions {
  delay?: number; // ms per keystroke
}

/** Screenshot options interface definition. */
export interface ScreenshotOptions {
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number; // 0-100 (jpeg only)
}

/** Cloudflare bypass result interface definition. */
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

/** Browser driver interface definition. */
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

/** Mock browser page. */
export class MockBrowserPage implements BrowserPage {
  private _url = "about:blank";
  private _closed = false;
  private opts: MockPageOptions;
  readonly clicks: { selector: string; opts?: ClickOptions }[] = [];
  readonly types: { selector: string; text: string; opts?: TypeOptions }[] = [];
  readonly navigations: string[] = [];

  constructor(opts: MockPageOptions = {}) {
    this.opts = opts;
  }

  get url(): string {
    return this._url;
  }
  get isClosed(): boolean {
    return this._closed;
  }

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

/** Mock browser driver. */
export class MockBrowserDriver implements BrowserDriver {
  private _open = true;
  private _pageOpts: MockPageOptions;
  readonly pagesCreated: MockBrowserPage[] = [];

  constructor(pageOpts: MockPageOptions = {}) {
    this._pageOpts = pageOpts;
  }

  get isOpen(): boolean {
    return this._open;
  }

  async newPage(_profile?: StealthProfile): Promise<BrowserPage> {
    const page = new MockBrowserPage(this._pageOpts);
    this.pagesCreated.push(page);
    return page;
  }

  async close(): Promise<void> {
    this._open = false;
  }
}

// ── PatchrightDriver ──────────────────────────────────────────────────────────

/**
 * Probes whether the `patchright` package is installed and importable.
 * Used at startup to decide whether to activate real browser execution.
 */
export async function isPatchrightAvailable(): Promise<boolean> {
  try {
    await import("patchright");
    return true;
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PatchrightPageType = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PatchrightBrowserType = any;

/**
 * BrowserPage backed by a real patchright Page.
 * Maps our interface to patchright's Playwright-compatible API.
 */
export class PatchrightPage implements BrowserPage {
  private _page: PatchrightPageType;
  private _closed = false;

  constructor(page: PatchrightPageType) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this._page = page;
  }

  get url(): string {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return (this._page.url?.() as string | undefined) ?? "about:blank";
  }
  get isClosed(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return this._closed || (this._page.isClosed?.() as boolean | undefined) === true;
  }

  async navigate(url: string): Promise<NavigateResult> {
    const t0 = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const response = await (this._page.goto(url, { waitUntil: "domcontentloaded" }) as Promise<{
      status(): number;
    } | null>);
    const status = response?.status() ?? 200;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const pageTitle = (await this._page.title()) as string;
    return { url, status, title: pageTitle, loadTimeMs: Date.now() - t0 };
  }

  async content(): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return this._page.content() as Promise<string>;
  }

  async title(): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return this._page.title() as Promise<string>;
  }

  async click(selector: string, opts?: ClickOptions): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await this._page.click(selector, {
      delay: opts?.delay,
      button: opts?.button ?? "left",
    });
  }

  async type(selector: string, text: string, opts?: TypeOptions): Promise<void> {
    if (opts?.delay) {
      // Key-by-key typing for delay simulation
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await this._page.locator(selector).pressSequentially(text, { delay: opts.delay });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await this._page.fill(selector, text);
    }
  }

  async evaluate<T>(fn: string | (() => T)): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return this._page.evaluate(fn) as Promise<T>;
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return this._page.screenshot({
      fullPage: opts?.fullPage ?? false,
      type: opts?.format ?? "png",
      quality: opts?.quality,
    }) as Promise<Buffer>;
  }

  async waitForSelector(selector: string, timeoutMs = 30_000): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await this._page.waitForSelector(selector, { timeout: timeoutMs });
  }

  async close(): Promise<void> {
    this._closed = true;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await this._page.close();
  }
}

/**
 * Real stealth browser driver backed by patchright (an undetected Chromium fork).
 *
 * patchright is an optional peer dependency — install with:
 *   pnpm add patchright
 *   npx patchright install chromium
 *
 * Dynamically imported on first use so the package stays optional.
 * Falls back gracefully: throws if patchright is not found so the caller
 * can substitute MockBrowserDriver.
 *
 * Usage:
 *   const available = await isPatchrightAvailable();
 *   const driver = available ? new PatchrightDriver() : new MockBrowserDriver();
 *   const browser = new StealthBrowser({ driver });
 */
export class PatchrightDriver implements BrowserDriver {
  private _browser: PatchrightBrowserType | null = null;
  private _open = false;
  private readonly headless: boolean;
  private readonly channel: string;

  constructor(config?: { headless?: boolean; channel?: string }) {
    this.headless = config?.headless ?? true;
    this.channel = config?.channel ?? "chromium";
  }

  get isOpen(): boolean {
    return this._open && this._browser !== null;
  }

  private async ensureOpen(): Promise<PatchrightBrowserType> {
    if (this._browser) return this._browser;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let patchright: any;
    try {
      patchright = await import("patchright");
    } catch {
      throw new Error(
        "PatchrightDriver: `patchright` package not found. " +
          "Install it with: pnpm add patchright && npx patchright install chromium",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const chromium = (patchright.chromium ?? patchright.default?.chromium) as
      | {
          launch(opts: Record<string, unknown>): Promise<PatchrightBrowserType>;
        }
      | undefined;

    if (!chromium) {
      throw new Error("PatchrightDriver: could not locate chromium in patchright exports");
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this._browser = await chromium.launch({
      headless: this.headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    this._open = true;
    return this._browser;
  }

  async newPage(profile?: StealthProfile): Promise<BrowserPage> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const browser = await this.ensureOpen();

    // Resolve user-agent: explicit → pool rotation → chromium default
    const userAgent =
      profile?.userAgent ?? pickRandomUserAgent(profile?.userAgentPool ?? DEFAULT_USER_AGENT_POOL);

    const contextOptions: Record<string, unknown> = {
      userAgent,
      locale: profile?.locale,
      timezoneId: profile?.timezone,
      viewport: profile?.viewport ?? { width: 1280, height: 720 },
      extraHTTPHeaders: profile?.extraHeaders,
    };

    // Remove undefined values to avoid patchright validation errors
    for (const k of Object.keys(contextOptions)) {
      if (contextOptions[k] === undefined) delete contextOptions[k];
    }

     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    const context = await (browser as any).newContext(contextOptions);
     
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    const page = await (context as any).newPage();

    // ── Fingerprint-hardening init scripts ────────────────────────────────────
    const shouldCanvasNoise = profile?.canvasNoise !== false; // default true
    const shouldWebGlNoise = profile?.webGlNoise !== false; // default true
    const shouldBlockWebRtc = profile?.blockWebRtc !== false; // default true

    if (shouldCanvasNoise) {
      // Perturb canvas pixel values by ±1 to defeat canvas fingerprinting
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (context as unknown).addInitScript(`
        (function () {
          const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
            const ctx = this.getContext("2d");
            if (ctx) {
              const img = ctx.getImageData(0, 0, this.width, this.height);
              for (let i = 0; i < img.data.length; i += 4) {
                img.data[i]     = Math.max(0, Math.min(255, img.data[i]     + (Math.random() > 0.5 ? 1 : -1)));
                img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + (Math.random() > 0.5 ? 1 : -1)));
                img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + (Math.random() > 0.5 ? 1 : -1)));
              }
              ctx.putImageData(img, 0, 0);
            }
            return origToDataURL.call(this, type, quality);
          };
        })();
      `);
    }

    if (shouldWebGlNoise) {
      // Randomise WebGL renderer/vendor strings to prevent GPU fingerprinting
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (context as unknown).addInitScript(`
        (function () {
          const getParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return "Intel Open Source Technology Center";  // VENDOR
            if (param === 37446) return "Mesa DRI Intel(R) HD Graphics " + (Math.floor(Math.random() * 900) + 100);  // RENDERER
            return getParameter.call(this, param);
          };
          const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
          WebGL2RenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return "Intel Open Source Technology Center";
            if (param === 37446) return "Mesa DRI Intel(R) HD Graphics " + (Math.floor(Math.random() * 900) + 100);
            return getParameter2.call(this, param);
          };
        })();
      `);
    }

    if (shouldBlockWebRtc) {
      // Override RTCPeerConnection to block local IP leaks
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (context as unknown).addInitScript(`
        (function () {
          const Orig = window.RTCPeerConnection;
          if (!Orig) return;
          window.RTCPeerConnection = function (config) {
            if (config && config.iceServers) {
              config.iceServers = [];
            }
            return new Orig(config);
          };
          window.RTCPeerConnection.prototype = Orig.prototype;
        })();
      `);
    }

    return new PatchrightPage(page);
  }

  async close(): Promise<void> {
    if (this._browser) {
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      await (this._browser as any).close();
      this._browser = null;
      this._open = false;
    }
  }
}

// ── PagePool ──────────────────────────────────────────────────────────────────

export interface PagePoolOptions {
  maxSize?: number;
  driver: BrowserDriver;
  profile?: StealthProfile;
}

/** Page pool. */
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

  get idleCount(): number {
    return this.idle.length;
  }
  get inUseCount(): number {
    return this.inUse.size;
  }
  get totalCount(): number {
    return this.idle.length + this.inUse.size;
  }
}

// ── CloudflareBypass ──────────────────────────────────────────────────────────

export interface CloudflareDetector {
  /** Returns true if the page content looks like a CF challenge. */
  isChallenge(html: string): boolean;
}

/** Default cloudflare dector. */
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

/** Cloudflare bypass. */
export class CloudflareBypass {
  private detector: CloudflareDetector;
  private maxAttempts: number;
  private waitMs: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(
    opts: {
      detector?: CloudflareDetector;
      maxAttempts?: number;
      waitMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
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

  async content(): Promise<string> {
    return this.page.content();
  }
  async title(): Promise<string> {
    return this.page.title();
  }
  async click(selector: string, opts?: ClickOptions): Promise<void> {
    return this.page.click(selector, opts);
  }
  async type(selector: string, text: string, opts?: TypeOptions): Promise<void> {
    return this.page.type(selector, text, opts);
  }
  async evaluate<T>(fn: string | (() => T)): Promise<T> {
    return this.page.evaluate(fn);
  }
  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    return this.page.screenshot(opts);
  }
  async waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
    return this.page.waitForSelector(selector, timeoutMs);
  }
  async close(): Promise<void> {
    return this.page.close();
  }

  get url(): string {
    return this.page.url;
  }
  get isClosed(): boolean {
    return this.page.isClosed;
  }
  get rawPage(): BrowserPage {
    return this.page;
  }
}

// ── StealthBrowser ────────────────────────────────────────────────────────────

export interface StealthBrowserOptions {
  driver: BrowserDriver;
  profile?: StealthProfile;
  poolSize?: number;
  bypass?: CloudflareBypass;
}

/** Stealth browser. */
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

  get isOpen(): boolean {
    return this.driver.isOpen;
  }
  get pool_(): PagePool {
    return this.pool;
  }
}

// ── StealthBrowserScrapingBackend ─────────────────────────────────────────────
/**
 * Bridges StealthBrowser to the ScrapingBackend interface used by
 * @nexus/scraping-mcp.  Uses structural (duck-type) compatibility — no import
 * of scraping-mcp is needed, which avoids a circular dependency.
 *
 * fetch()        — navigate + html content (real HTTP status code)
 * fetchStealthy()— same path; fingerprint spoofing already applied by StealthBrowser
 * screenshot()   — navigate + PNG screenshot as base64
 *
 * Use createStealthBackend() factory to auto-select PatchrightDriver when
 * patchright is available, falling back to MockDriver for dev/test.
 */

export interface StealthFetchResult {
  url: string;
  html: string;
  status: number;
  headers?: Record<string, string>;
}

/** Stealth screenshot result interface definition. */
export interface StealthScreenshotResult {
  url: string;
  data: string; // base64-encoded PNG
  mimeType: string;
}

/** Stealth browser scraping backend. */
export class StealthBrowserScrapingBackend {
  private _browser: StealthBrowser;

  constructor(opts: { driver: BrowserDriver; poolSize?: number; profile?: StealthProfile }) {
    this._browser = new StealthBrowser({
      driver: opts.driver,
      poolSize: opts.poolSize ?? 3,
      profile: opts.profile,
    });
  }

  async fetch(url: string, _sessionId?: string): Promise<StealthFetchResult> {
    return this._browser.withPage(async (page) => {
      const nav = await page.goto(url);
      const html = await page.content();
      return { url: nav.url, html, status: nav.status };
    });
  }

  /** Stealthy fetch — identical to fetch() since StealthPage already applies
   *  fingerprint spoofing, custom user-agent, and WebRTC block. */
  async fetchStealthy(url: string, sessionId?: string): Promise<StealthFetchResult> {
    return this.fetch(url, sessionId);
  }

  async screenshot(url: string, _sessionId?: string): Promise<StealthScreenshotResult> {
    return this._browser.withPage(async (page) => {
      await page.goto(url);
      const buf = await page.screenshot({ format: "png", fullPage: false });
      return { url, data: buf.toString("base64"), mimeType: "image/png" };
    });
  }

  async close(): Promise<void> {
    await this._browser.close();
  }
}

/**
 * Auto-select driver:
 *   1. PatchrightDriver  — when patchright npm package is installed
 *   2. MockDriver        — development / CI fallback
 *
 * @example
 *   const backend = await createStealthBackend();
 *   const { html } = await backend.fetch("https://example.com");
 */
export async function createStealthBackend(
  opts: { poolSize?: number; profile?: StealthProfile } = {},
): Promise<StealthBrowserScrapingBackend> {
  const driver: BrowserDriver = (await isPatchrightAvailable())
    ? new PatchrightDriver()
    : new MockBrowserDriver();
  return new StealthBrowserScrapingBackend({ driver, ...opts });
}
