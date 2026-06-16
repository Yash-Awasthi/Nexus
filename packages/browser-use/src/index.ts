// SPDX-License-Identifier: Apache-2.0

// ── Driver abstraction (injectable) ──────────────────────────────────────────

export interface GotoOpts {
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
}

/** Screenshot opts interface definition. */
export interface ScreenshotOpts {
  fullPage?: boolean;
  encoding?: "binary" | "base64";
  clip?: { x: number; y: number; width: number; height: number };
}

/** Wait selector opts interface definition. */
export interface WaitSelectorOpts {
  visible?: boolean;
  hidden?: boolean;
  timeoutMs?: number;
}

/** Low-level injectable page driver — implement this to wrap Playwright/Puppeteer/CDP. */
export interface PageDriver {
  goto(url: string, opts?: GotoOpts): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string, opts?: { delay?: number }): Promise<void>;
  evaluate<T = unknown>(script: string): Promise<T>;
  content(): Promise<string>;
  screenshot(opts?: ScreenshotOpts): Promise<Buffer>;
  waitForSelector(selector: string, opts?: WaitSelectorOpts): Promise<void>;
  waitForNavigation(opts?: { timeoutMs?: number }): Promise<void>;
  close(): Promise<void>;
  url(): string;
  title(): Promise<string>;
}

/** Page driver factory type alias. */
export type PageDriverFactory = () => Promise<PageDriver>;

// ── Error ─────────────────────────────────────────────────────────────────────

export class BrowserError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
  }
}

// ── BrowserSession ────────────────────────────────────────────────────────────

/** High-level browser session wrapping a PageDriver. */
export class BrowserSession {
  constructor(private readonly _driver: PageDriver) {}

  get driver(): PageDriver {
    return this._driver;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  async navigate(url: string, opts?: GotoOpts): Promise<void> {
    await this._driver.goto(url, opts);
  }

  get currentUrl(): string {
    return this._driver.url();
  }

  async title(): Promise<string> {
    return this._driver.title();
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  async click(selector: string): Promise<void> {
    await this._driver.click(selector);
  }

  async fill(selector: string, text: string, opts?: { delay?: number }): Promise<void> {
    await this._driver.type(selector, text, opts);
  }

  /** Fill multiple form fields. Keys are selectors, values are text content. */
  async fillForm(fields: Record<string, string>): Promise<void> {
    for (const [selector, value] of Object.entries(fields)) {
      await this._driver.type(selector, value);
    }
  }

  /** Click an element and optionally wait for a URL pattern to appear. */
  async clickAndWait(selector: string, urlPattern?: RegExp | string): Promise<void> {
    if (urlPattern) {
      await Promise.all([this._driver.waitForNavigation(), this._driver.click(selector)]);
      const currentUrl = this._driver.url();
      const re = typeof urlPattern === "string" ? new RegExp(urlPattern) : urlPattern;
      if (!re.test(currentUrl)) {
        throw new BrowserError(
          `Navigation after click did not match ${re} — got ${currentUrl}`,
          "NAV_MISMATCH",
        );
      }
    } else {
      await this._driver.click(selector);
    }
  }

  // ── Extraction ────────────────────────────────────────────────────────────

  async getHtml(): Promise<string> {
    return this._driver.content();
  }

  async getText(selector?: string): Promise<string> {
    if (!selector) {
      return this._driver.evaluate<string>("document.body.innerText");
    }
    return this._driver.evaluate<string>(
      `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`,
    );
  }

  async getAttribute(selector: string, attr: string): Promise<string | null> {
    return this._driver.evaluate<string | null>(
      `(document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(attr)}) ?? null)`,
    );
  }

  /** Extract text content for multiple selectors. Returns map selector → text. */
  async extractText(selectors: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const sel of selectors) {
      result[sel] = await this.getText(sel);
    }
    return result;
  }

  /** Extract all <a href> links from the current page. */
  async extractLinks(): Promise<string[]> {
    return this._driver.evaluate<string[]>(
      "Array.from(document.querySelectorAll('a[href]')).map(a => a.href)",
    );
  }

  async evaluate<T = unknown>(script: string): Promise<T> {
    return this._driver.evaluate<T>(script);
  }

  // ── Waits ─────────────────────────────────────────────────────────────────

  async waitForSelector(selector: string, opts?: WaitSelectorOpts): Promise<void> {
    await this._driver.waitForSelector(selector, opts);
  }

  async waitForNavigation(opts?: { timeoutMs?: number }): Promise<void> {
    await this._driver.waitForNavigation(opts);
  }

  // ── Screenshot / close ────────────────────────────────────────────────────

  async screenshot(opts?: ScreenshotOpts): Promise<Buffer> {
    return this._driver.screenshot(opts);
  }

  async close(): Promise<void> {
    await this._driver.close();
  }
}

// ── BrowserUse ────────────────────────────────────────────────────────────────

/** Factory that spawns BrowserSession instances from an injectable PageDriverFactory. */
export class BrowserUse {
  private readonly _sessions: BrowserSession[] = [];

  constructor(private readonly factory: PageDriverFactory) {}

  async newSession(): Promise<BrowserSession> {
    const driver = await this.factory();
    const session = new BrowserSession(driver);
    this._sessions.push(session);
    return session;
  }

  get activeSessions(): readonly BrowserSession[] {
    return this._sessions;
  }

  async closeAll(): Promise<void> {
    await Promise.all(this._sessions.map((s) => s.close()));
    this._sessions.length = 0;
  }
}

// ── NullPageDriver ────────────────────────────────────────────────────────────

/** In-memory PageDriver for unit tests. */
export class NullPageDriver implements PageDriver {
  private _url = "about:blank";
  private _title = "Untitled";
  private _html = "<html><body></body></html>";
  private _closed = false;

  readonly clicks: string[] = [];
  readonly typed: { selector: string; text: string }[] = [];
  readonly evaluations: string[] = [];
  readonly navigations: string[] = [];

  /** Seed page state to simulate a loaded page. */
  seed(opts: { url?: string; title?: string; html?: string }): void {
    if (opts.url !== undefined) this._url = opts.url;
    if (opts.title !== undefined) this._title = opts.title;
    if (opts.html !== undefined) this._html = opts.html;
  }

  async goto(url: string, _opts?: GotoOpts): Promise<void> {
    this._url = url;
    this.navigations.push(url);
  }

  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
  }

  async type(selector: string, text: string, _opts?: { delay?: number }): Promise<void> {
    this.typed.push({ selector, text });
  }

  async evaluate<T = unknown>(script: string): Promise<T> {
    this.evaluations.push(script);
    // Minimal simulation for common patterns
    if (script.includes("document.body.innerText")) return "" as unknown as T;
    if (script.includes("document.querySelectorAll('a[href]')")) return [] as unknown as T;
    if (script.startsWith("(document.querySelector(")) return "" as unknown as T;
    return undefined as unknown as T;
  }

  async content(): Promise<string> {
    return this._html;
  }

  async screenshot(_opts?: ScreenshotOpts): Promise<Buffer> {
    return Buffer.from("PNG_PLACEHOLDER");
  }

  async waitForSelector(_selector: string, _opts?: WaitSelectorOpts): Promise<void> {}

  async waitForNavigation(_opts?: { timeoutMs?: number }): Promise<void> {}

  async close(): Promise<void> {
    this._closed = true;
  }

  url(): string {
    return this._url;
  }

  async title(): Promise<string> {
    return this._title;
  }

  get closed(): boolean {
    return this._closed;
  }
}
