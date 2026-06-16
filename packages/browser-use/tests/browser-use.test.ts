// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  BrowserUse,
  BrowserSession,
  BrowserError,
  NullPageDriver,
  type ITmuxClient,
  type PageDriver,
  type PageDriverFactory,
} from "../src/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFactory(driver?: NullPageDriver): {
  factory: PageDriverFactory;
  driver: NullPageDriver;
} {
  const d = driver ?? new NullPageDriver();
  const factory: PageDriverFactory = async () => d;
  return { factory, driver: d };
}

// ── NullPageDriver ────────────────────────────────────────────────────────────

describe("NullPageDriver", () => {
  let driver: NullPageDriver;

  beforeEach(() => {
    driver = new NullPageDriver();
  });

  it("starts at about:blank", () => {
    expect(driver.url()).toBe("about:blank");
  });

  it("goto updates url and records navigation", async () => {
    await driver.goto("https://example.com");
    expect(driver.url()).toBe("https://example.com");
    expect(driver.navigations).toContain("https://example.com");
  });

  it("click records selector", async () => {
    await driver.click("button#submit");
    expect(driver.clicks).toContain("button#submit");
  });

  it("type records selector and text", async () => {
    await driver.type("input#name", "Yash");
    expect(driver.typed[0]).toEqual({ selector: "input#name", text: "Yash" });
  });

  it("evaluate records script", async () => {
    await driver.evaluate("document.title");
    expect(driver.evaluations).toContain("document.title");
  });

  it("content returns seeded html", async () => {
    driver.seed({ html: "<html><body><p>Hello</p></body></html>" });
    expect(await driver.content()).toContain("<p>Hello</p>");
  });

  it("screenshot returns a Buffer", async () => {
    const buf = await driver.screenshot();
    expect(buf instanceof Buffer).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it("title returns seeded title", async () => {
    driver.seed({ title: "My Page" });
    expect(await driver.title()).toBe("My Page");
  });

  it("close sets closed to true", async () => {
    expect(driver.closed).toBe(false);
    await driver.close();
    expect(driver.closed).toBe(true);
  });

  it("seed sets all fields at once", () => {
    driver.seed({ url: "https://a.com", title: "A", html: "<html/>" });
    expect(driver.url()).toBe("https://a.com");
  });

  it("waitForSelector resolves without error", async () => {
    await expect(driver.waitForSelector(".foo")).resolves.toBeUndefined();
  });

  it("waitForNavigation resolves without error", async () => {
    await expect(driver.waitForNavigation()).resolves.toBeUndefined();
  });
});

// ── BrowserSession ────────────────────────────────────────────────────────────

describe("BrowserSession", () => {
  let driver: NullPageDriver;
  let session: BrowserSession;

  beforeEach(() => {
    driver = new NullPageDriver();
    session = new BrowserSession(driver);
  });

  it("navigate calls driver.goto", async () => {
    await session.navigate("https://example.com");
    expect(driver.navigations).toContain("https://example.com");
  });

  it("currentUrl proxies driver.url()", async () => {
    await session.navigate("https://test.com");
    expect(session.currentUrl).toBe("https://test.com");
  });

  it("title returns driver.title()", async () => {
    driver.seed({ title: "Test Page" });
    expect(await session.title()).toBe("Test Page");
  });

  it("click delegates to driver.click", async () => {
    await session.click(".btn");
    expect(driver.clicks).toContain(".btn");
  });

  it("fill delegates to driver.type", async () => {
    await session.fill("input", "hello");
    expect(driver.typed[0]).toEqual({ selector: "input", text: "hello" });
  });

  it("fillForm fills multiple fields in order", async () => {
    await session.fillForm({ "#name": "Yash", "#email": "y@example.com" });
    expect(driver.typed).toHaveLength(2);
    expect(driver.typed[0]!.selector).toBe("#name");
    expect(driver.typed[1]!.selector).toBe("#email");
  });

  it("getHtml returns driver.content()", async () => {
    driver.seed({ html: "<html><p>test</p></html>" });
    expect(await session.getHtml()).toContain("<p>test</p>");
  });

  it("getText with no selector evaluates document.body.innerText", async () => {
    await session.getText();
    expect(driver.evaluations.some((e) => e.includes("document.body.innerText"))).toBe(true);
  });

  it("getText with selector evaluates querySelector", async () => {
    await session.getText(".title");
    expect(driver.evaluations.some((e) => e.includes(".title"))).toBe(true);
  });

  it("getAttribute evaluates getAttribute script", async () => {
    await session.getAttribute("a.link", "href");
    expect(driver.evaluations.some((e) => e.includes("getAttribute"))).toBe(true);
  });

  it("extractText returns record of selector → text", async () => {
    const result = await session.extractText(["h1", "p"]);
    expect(Object.keys(result)).toEqual(expect.arrayContaining(["h1", "p"]));
  });

  it("extractLinks evaluates querySelectorAll anchor script", async () => {
    await session.extractLinks();
    expect(driver.evaluations.some((e) => e.includes("querySelectorAll"))).toBe(true);
  });

  it("screenshot returns Buffer from driver", async () => {
    const buf = await session.screenshot();
    expect(buf instanceof Buffer).toBe(true);
  });

  it("waitForSelector delegates to driver", async () => {
    await expect(session.waitForSelector(".ready")).resolves.toBeUndefined();
  });

  it("waitForNavigation delegates to driver", async () => {
    await expect(session.waitForNavigation()).resolves.toBeUndefined();
  });

  it("close marks driver as closed", async () => {
    await session.close();
    expect(driver.closed).toBe(true);
  });

  it("driver accessor returns the underlying driver", () => {
    expect(session.driver).toBe(driver);
  });

  it("clickAndWait without urlPattern just clicks", async () => {
    await session.clickAndWait(".btn");
    expect(driver.clicks).toContain(".btn");
  });

  it("clickAndWait with matching url pattern succeeds", async () => {
    driver.seed({ url: "https://example.com/success" });
    await session.clickAndWait(".submit", /success/);
    expect(driver.clicks).toContain(".submit");
  });

  it("clickAndWait throws NAV_MISMATCH when url doesn't match pattern", async () => {
    driver.seed({ url: "https://example.com/error" });
    try {
      await session.clickAndWait(".submit", /success/);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e instanceof BrowserError).toBe(true);
      expect((e as BrowserError).code).toBe("NAV_MISMATCH");
    }
  });

  it("evaluate passes script through to driver", async () => {
    await session.evaluate<number>("1 + 1");
    expect(driver.evaluations).toContain("1 + 1");
  });
});

// ── BrowserUse ────────────────────────────────────────────────────────────────

describe("BrowserUse", () => {
  it("newSession creates a BrowserSession", async () => {
    const { factory } = makeFactory();
    const browser = new BrowserUse(factory);
    const session = await browser.newSession();
    expect(session instanceof BrowserSession).toBe(true);
  });

  it("activeSessions tracks open sessions", async () => {
    const { factory } = makeFactory();
    const browser = new BrowserUse(factory);
    await browser.newSession();
    await browser.newSession();
    expect(browser.activeSessions).toHaveLength(2);
  });

  it("closeAll closes all sessions and clears list", async () => {
    const drivers: NullPageDriver[] = [];
    const factory: PageDriverFactory = async () => {
      const d = new NullPageDriver();
      drivers.push(d);
      return d;
    };
    const browser = new BrowserUse(factory);
    await browser.newSession();
    await browser.newSession();
    await browser.closeAll();
    expect(browser.activeSessions).toHaveLength(0);
    expect(drivers.every((d) => d.closed)).toBe(true);
  });

  it("each newSession call invokes the factory", async () => {
    let calls = 0;
    const factory: PageDriverFactory = async () => {
      calls++;
      return new NullPageDriver();
    };
    const browser = new BrowserUse(factory);
    await browser.newSession();
    await browser.newSession();
    expect(calls).toBe(2);
  });
});

// ── BrowserError ──────────────────────────────────────────────────────────────

describe("BrowserError", () => {
  it("has correct name, code, and message", () => {
    const e = new BrowserError("navigation failed", "NAV_FAILED");
    expect(e.name).toBe("BrowserError");
    expect(e.code).toBe("NAV_FAILED");
    expect(e.message).toBe("navigation failed");
    expect(e instanceof Error).toBe(true);
  });
});
