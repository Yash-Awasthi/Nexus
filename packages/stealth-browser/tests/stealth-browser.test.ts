// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MockBrowserPage,
  MockBrowserDriver,
  PagePool,
  CloudflareBypass,
  DefaultCloudflareDector,
  StealthPage,
  StealthBrowser,
  type MockPageOptions,
  type StealthProfile,
} from "../src/index.js";

// ── MockBrowserPage ───────────────────────────────────────────────────────────

describe("MockBrowserPage", () => {
  it("navigate sets url and returns result", async () => {
    const page = new MockBrowserPage({ status: 200, title: "Test", loadTimeMs: 100 });
    const result = await page.navigate("https://example.com");
    expect(result.url).toBe("https://example.com");
    expect(result.status).toBe(200);
    expect(result.title).toBe("Test");
    expect(result.loadTimeMs).toBe(100);
    expect(page.url).toBe("https://example.com");
  });

  it("content returns configured HTML", async () => {
    const page = new MockBrowserPage({ html: "<html><body>Hello</body></html>" });
    expect(await page.content()).toContain("Hello");
  });

  it("content returns default mock content when html not set", async () => {
    const page = new MockBrowserPage();
    await page.navigate("https://test.com");
    expect(await page.content()).toContain("Mock content");
  });

  it("title returns configured title", async () => {
    const page = new MockBrowserPage({ title: "My Title" });
    expect(await page.title()).toBe("My Title");
  });

  it("click records interactions", async () => {
    const page = new MockBrowserPage();
    await page.click("#btn", { button: "left" });
    expect(page.clicks).toHaveLength(1);
    expect(page.clicks[0]!.selector).toBe("#btn");
    expect(page.clicks[0]!.opts?.button).toBe("left");
  });

  it("type records interactions", async () => {
    const page = new MockBrowserPage();
    await page.type("#input", "hello world", { delay: 50 });
    expect(page.types).toHaveLength(1);
    expect(page.types[0]!.text).toBe("hello world");
  });

  it("evaluate executes function in mock", async () => {
    const page = new MockBrowserPage();
    const result = await page.evaluate<number>(() => 42);
    expect(result).toBe(42);
  });

  it("screenshot returns a Buffer", async () => {
    const page = new MockBrowserPage();
    const buf = await page.screenshot({ fullPage: true });
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it("waitForSelector resolves normally by default", async () => {
    const page = new MockBrowserPage();
    await expect(page.waitForSelector(".el")).resolves.toBeUndefined();
  });

  it("waitForSelector throws when selectorTimeout is true", async () => {
    const page = new MockBrowserPage({ selectorTimeout: true });
    await expect(page.waitForSelector(".el")).rejects.toThrow("Timeout");
  });

  it("close marks page as closed", async () => {
    const page = new MockBrowserPage();
    expect(page.isClosed).toBe(false);
    await page.close();
    expect(page.isClosed).toBe(true);
  });

  it("navigations tracks all navigate calls", async () => {
    const page = new MockBrowserPage();
    await page.navigate("https://a.com");
    await page.navigate("https://b.com");
    expect(page.navigations).toEqual(["https://a.com", "https://b.com"]);
  });
});

// ── MockBrowserDriver ─────────────────────────────────────────────────────────

describe("MockBrowserDriver", () => {
  it("creates pages and tracks them", async () => {
    const driver = new MockBrowserDriver();
    const page = await driver.newPage();
    expect(driver.pagesCreated).toHaveLength(1);
    expect(driver.pagesCreated[0]).toBe(page);
  });

  it("isOpen starts true and becomes false after close", async () => {
    const driver = new MockBrowserDriver();
    expect(driver.isOpen).toBe(true);
    await driver.close();
    expect(driver.isOpen).toBe(false);
  });

  it("passes profile to page creation (no-op in mock but asserts no error)", async () => {
    const driver = new MockBrowserDriver();
    const profile: StealthProfile = { userAgent: "TestBot/1.0", locale: "en-US" };
    const page = await driver.newPage(profile);
    expect(page).toBeDefined();
  });
});

// ── PagePool ──────────────────────────────────────────────────────────────────

describe("PagePool", () => {
  it("acquires a page from the driver on first call", async () => {
    const driver = new MockBrowserDriver();
    const pool = new PagePool({ driver, maxSize: 3 });
    const page = await pool.acquire();
    expect(page).toBeDefined();
    expect(pool.inUseCount).toBe(1);
    expect(driver.pagesCreated).toHaveLength(1);
  });

  it("reuses idle pages after release", async () => {
    const driver = new MockBrowserDriver();
    const pool = new PagePool({ driver, maxSize: 3 });
    const page = await pool.acquire();
    pool.release(page);
    const page2 = await pool.acquire();
    expect(page2).toBe(page); // same instance
    expect(driver.pagesCreated).toHaveLength(1); // no new page created
  });

  it("throws when pool is exhausted", async () => {
    const driver = new MockBrowserDriver();
    const pool = new PagePool({ driver, maxSize: 2 });
    await pool.acquire();
    await pool.acquire();
    await expect(pool.acquire()).rejects.toThrow("PagePool exhausted");
  });

  it("drain closes all pages", async () => {
    const driver = new MockBrowserDriver();
    const pool = new PagePool({ driver, maxSize: 3 });
    const p1 = await pool.acquire();
    pool.release(p1);
    const p2 = await pool.acquire();
    // p1 in idle, p2 in use
    pool.release(p2);
    await pool.drain();
    expect(pool.totalCount).toBe(0);
  });

  it("closed pages are not returned from idle pool", async () => {
    const driver = new MockBrowserDriver();
    const pool = new PagePool({ driver, maxSize: 3 });
    const page = await pool.acquire();
    pool.release(page);
    await page.close(); // manually close the idle page
    // next acquire should create a new one, not return the closed one
    const page2 = await pool.acquire();
    expect(page2.isClosed).toBe(false);
    expect(driver.pagesCreated).toHaveLength(2);
  });

  it("idleCount and inUseCount track correctly", async () => {
    const driver = new MockBrowserDriver();
    const pool = new PagePool({ driver, maxSize: 5 });
    const p1 = await pool.acquire();
    const p2 = await pool.acquire();
    expect(pool.inUseCount).toBe(2);
    expect(pool.idleCount).toBe(0);
    pool.release(p1);
    expect(pool.inUseCount).toBe(1);
    expect(pool.idleCount).toBe(1);
  });
});

// ── DefaultCloudflareDector ───────────────────────────────────────────────────

describe("DefaultCloudflareDector", () => {
  const detector = new DefaultCloudflareDector();

  it("detects cf-browser-verification", () => {
    expect(detector.isChallenge("<div class='cf-browser-verification'></div>")).toBe(true);
  });

  it("detects 'checking your browser'", () => {
    expect(detector.isChallenge("Checking your browser before accessing")).toBe(true);
  });

  it("detects Ray ID pattern", () => {
    expect(detector.isChallenge("Ray ID: 7abc123def")).toBe(true);
  });

  it("detects cloudflare keyword", () => {
    expect(detector.isChallenge("Protected by Cloudflare")).toBe(true);
  });

  it("detects turnstile pattern", () => {
    expect(detector.isChallenge("<div class='cf-turnstile'></div>")).toBe(true);
  });

  it("returns false for normal content", () => {
    expect(detector.isChallenge("<html><body><h1>Hello World</h1></body></html>")).toBe(false);
  });
});

// ── CloudflareBypass ──────────────────────────────────────────────────────────

describe("CloudflareBypass", () => {
  it("returns success: true with method 'none' when no challenge present", async () => {
    const page = new MockBrowserPage({ html: "<html><body>Normal page</body></html>" });
    const bypass = new CloudflareBypass({ waitMs: 0 });
    await page.navigate("https://example.com");
    const result = await bypass.bypass(page, "https://example.com");
    expect(result.success).toBe(true);
    expect(result.method).toBe("none");
    expect(result.attempts).toBe(1);
  });

  it("returns success: false after maxAttempts if challenge persists", async () => {
    const page = new MockBrowserPage({ html: "<div class='cf-browser-verification'></div>" });
    const bypass = new CloudflareBypass({ maxAttempts: 2, waitMs: 0 });
    await page.navigate("https://example.com");
    const result = await bypass.bypass(page, "https://example.com");
    expect(result.success).toBe(false);
    expect(result.method).toBe("failed");
    expect(result.attempts).toBeGreaterThanOrEqual(2);
  });

  it("uses injected sleep function", async () => {
    const sleeps: number[] = [];
    const page = new MockBrowserPage({ html: "<div class='cf-browser-verification'></div>" });
    const bypass = new CloudflareBypass({
      maxAttempts: 2,
      waitMs: 500,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await page.navigate("https://example.com");
    await bypass.bypass(page, "https://example.com");
    expect(sleeps).toContain(500);
  });

  it("accepts custom detector", async () => {
    const customDetector = { isChallenge: (_html: string) => false };
    const page = new MockBrowserPage({ html: "anything" });
    const bypass = new CloudflareBypass({ detector: customDetector, waitMs: 0 });
    await page.navigate("https://x.com");
    const result = await bypass.bypass(page, "https://x.com");
    expect(result.success).toBe(true);
  });
});

// ── StealthPage ───────────────────────────────────────────────────────────────

describe("StealthPage", () => {
  it("goto navigates and returns bypass result", async () => {
    const mockPage = new MockBrowserPage({ html: "<p>Clean</p>", status: 200 });
    const stealthPage = new StealthPage(mockPage);
    const result = await stealthPage.goto("https://example.com");
    expect(result.status).toBe(200);
    expect(result.bypassResult).toBeDefined();
    expect(result.bypassResult.success).toBe(true);
  });

  it("proxies content, title, click, type, evaluate, screenshot, waitForSelector, close", async () => {
    const mockPage = new MockBrowserPage({ html: "<p>content</p>", title: "Title" });
    const stealthPage = new StealthPage(mockPage);
    await stealthPage.goto("https://x.com");

    expect(await stealthPage.content()).toContain("content");
    expect(await stealthPage.title()).toBe("Title");

    await stealthPage.click("#btn");
    expect(mockPage.clicks).toHaveLength(1);

    await stealthPage.type("#inp", "test");
    expect(mockPage.types).toHaveLength(1);

    const val = await stealthPage.evaluate<number>(() => 99);
    expect(val).toBe(99);

    const buf = await stealthPage.screenshot();
    expect(Buffer.isBuffer(buf)).toBe(true);

    await stealthPage.waitForSelector(".el");

    expect(stealthPage.url).toBe("https://x.com");
    expect(stealthPage.isClosed).toBe(false);

    await stealthPage.close();
    expect(stealthPage.isClosed).toBe(true);
  });

  it("rawPage exposes the underlying BrowserPage", () => {
    const mockPage = new MockBrowserPage();
    const stealthPage = new StealthPage(mockPage);
    expect(stealthPage.rawPage).toBe(mockPage);
  });
});

// ── StealthBrowser ────────────────────────────────────────────────────────────

describe("StealthBrowser", () => {
  it("acquire returns a StealthPage", async () => {
    const driver = new MockBrowserDriver();
    const browser = new StealthBrowser({ driver, poolSize: 3 });
    const page = await browser.acquire();
    expect(page).toBeInstanceOf(StealthPage);
    await browser.close();
  });

  it("release returns page to pool", async () => {
    const driver = new MockBrowserDriver();
    const browser = new StealthBrowser({ driver, poolSize: 3 });
    const page = await browser.acquire();
    expect(browser.pool_.inUseCount).toBe(1);
    browser.release(page);
    expect(browser.pool_.idleCount).toBe(1);
    await browser.close();
  });

  it("withPage runs callback and releases automatically", async () => {
    const driver = new MockBrowserDriver();
    const browser = new StealthBrowser({ driver, poolSize: 3 });
    let capturedPage: StealthPage | null = null;
    await browser.withPage(async (page) => {
      capturedPage = page;
      await page.goto("https://example.com");
    });
    expect(browser.pool_.inUseCount).toBe(0);
    await browser.close();
  });

  it("withPage releases even when callback throws", async () => {
    const driver = new MockBrowserDriver();
    const browser = new StealthBrowser({ driver, poolSize: 3 });
    await expect(
      browser.withPage(async () => {
        throw new Error("callback error");
      }),
    ).rejects.toThrow("callback error");
    expect(browser.pool_.inUseCount).toBe(0);
    await browser.close();
  });

  it("close drains pool and closes driver", async () => {
    const driver = new MockBrowserDriver();
    const browser = new StealthBrowser({ driver, poolSize: 3 });
    await browser.acquire();
    await browser.close();
    expect(browser.isOpen).toBe(false);
    expect(browser.pool_.totalCount).toBe(0);
  });

  it("isOpen reflects driver state", async () => {
    const driver = new MockBrowserDriver();
    const browser = new StealthBrowser({ driver });
    expect(browser.isOpen).toBe(true);
    await browser.close();
    expect(browser.isOpen).toBe(false);
  });

  it("pool respects poolSize cap", async () => {
    const driver = new MockBrowserDriver();
    const browser = new StealthBrowser({ driver, poolSize: 2 });
    await browser.acquire();
    await browser.acquire();
    await expect(browser.acquire()).rejects.toThrow("PagePool exhausted");
    await browser.close();
  });
});
