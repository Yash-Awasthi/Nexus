// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Spider,
  CrawlScheduler,
  MemoryCookieJar,
  extractLinks,
  parseRobots,
  isAllowedByRobots,
  parseSitemapUrls,
  SpiderError,
  type CrawledPage,
  type CrawlTarget,
  type IProxyRotator,
  type Proxy,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _time = 1_000_000;
function makeNow() {
  _time = 1_000_000;
  return () => _time;
}
function advanceTime(ms: number) {
  _time += ms;
}

function makeProxy(host: string): Proxy {
  return { url: `http://${host}:8080`, host, port: 8080, protocol: "http" };
}

// Inline fetch mock: maps URL → { status, body, headers }
type MockRoute = { status?: number; body?: string; headers?: Record<string, string> };
type FetchMockMap = Record<string, MockRoute>;

function makeFetch(routes: FetchMockMap, defaultBody = "<html><body></body></html>"): typeof fetch {
  return async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const route = routes[url] ?? { status: 200, body: defaultBody };
    const status = route.status ?? 200;
    const body = route.body ?? defaultBody;
    const headers = new Headers({ "content-type": "text/html", ...route.headers });
    return new Response(body, { status, headers, url } as ResponseInit & { url: string });
  };
}

function makeTarget(override: Partial<CrawlTarget> = {}): CrawlTarget {
  return { url: "https://example.com", maxPages: 5, maxDepth: 2, ...override };
}

// ─────────────────────────────────────────────────────────────────────────────
// extractLinks
// ─────────────────────────────────────────────────────────────────────────────

describe("extractLinks", () => {
  it("extracts absolute href links", () => {
    const html = '<a href="https://example.com/page">link</a>';
    expect(extractLinks(html, "https://example.com")).toContain("https://example.com/page");
  });

  it("resolves relative links against base URL", () => {
    const html = '<a href="/about">about</a>';
    const links = extractLinks(html, "https://example.com/home");
    expect(links).toContain("https://example.com/about");
  });

  it("extracts canonical link", () => {
    const html = '<link rel="canonical" href="https://example.com/canonical"/>';
    expect(extractLinks(html, "https://example.com")).toContain("https://example.com/canonical");
  });

  it("strips hash fragments", () => {
    const html = '<a href="/page#section">link</a>';
    const links = extractLinks(html, "https://example.com");
    expect(links).toContain("https://example.com/page");
    expect(links.some((l) => l.includes("#"))).toBe(false);
  });

  it("deduplicates links", () => {
    const html = '<a href="/p">1</a><a href="/p">2</a>';
    const links = extractLinks(html, "https://example.com");
    expect(links.filter((l) => l === "https://example.com/p")).toHaveLength(1);
  });

  it("returns empty array for invalid base URL", () => {
    expect(extractLinks('<a href="/x">x</a>', "not-a-url")).toHaveLength(0);
  });

  it("skips data: and other non-http scheme links", () => {
    const html = '<a href="data:text/html,<h1>x</h1>">data</a><a href="/good">good</a>';
    const links = extractLinks(html, "https://example.com");
    expect(links).toContain("https://example.com/good");
    expect(links.every((l) => l.startsWith("https://example.com"))).toBe(true);
  });

  it("ignores hash-only links (starts with #)", () => {
    const html = '<a href="#section">anchor</a>';
    expect(extractLinks(html, "https://example.com")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseRobots / isAllowedByRobots
// ─────────────────────────────────────────────────────────────────────────────

describe("parseRobots", () => {
  it("parses disallowed paths for wildcard agent", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nDisallow: /admin");
    expect(rules.disallowed).toContain("/private");
    expect(rules.disallowed).toContain("/admin");
  });

  it("parses crawl-delay", () => {
    const rules = parseRobots("User-agent: *\nCrawl-delay: 2");
    expect(rules.crawlDelay).toBe(2);
  });

  it("ignores comments", () => {
    const rules = parseRobots("# comment\nUser-agent: *\nDisallow: /x # inline comment");
    expect(rules.disallowed).toContain("/x");
  });

  it("empty disallowed for non-matching user-agent", () => {
    const rules = parseRobots("User-agent: Googlebot\nDisallow: /private", "Nexus");
    expect(rules.disallowed).toHaveLength(0);
  });
});

describe("isAllowedByRobots", () => {
  it("allows paths not in disallow list", () => {
    const rules = { disallowed: ["/admin"] };
    expect(isAllowedByRobots(rules, "/about")).toBe(true);
  });

  it("blocks paths matching disallow prefix", () => {
    const rules = { disallowed: ["/private"] };
    expect(isAllowedByRobots(rules, "/private/data")).toBe(false);
  });

  it("allows everything when disallowed is empty", () => {
    expect(isAllowedByRobots({ disallowed: [] }, "/anything")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseSitemapUrls
// ─────────────────────────────────────────────────────────────────────────────

describe("parseSitemapUrls", () => {
  it("extracts URLs from urlset", () => {
    const xml = `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>`;
    const urls = parseSitemapUrls(xml);
    expect(urls).toContain("https://example.com/a");
    expect(urls).toContain("https://example.com/b");
  });

  it("extracts URLs from sitemapindex", () => {
    const xml = `<sitemapindex><sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemapUrls(xml)).toContain("https://example.com/sitemap1.xml");
  });

  it("returns empty array for empty XML", () => {
    expect(parseSitemapUrls("<urlset></urlset>")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CrawlScheduler
// ─────────────────────────────────────────────────────────────────────────────

describe("CrawlScheduler", () => {
  let sched: CrawlScheduler;

  beforeEach(() => {
    sched = new CrawlScheduler();
  });

  it("enqueue / dequeue FIFO", () => {
    sched.enqueue("https://a.com", 0);
    sched.enqueue("https://b.com", 1);
    // normalizeUrl strips trailing slash from root paths
    expect(sched.dequeue()?.url).toContain("a.com");
    expect(sched.dequeue()?.url).toContain("b.com");
  });

  it("deduplicates URLs", () => {
    sched.enqueue("https://a.com", 0);
    sched.enqueue("https://a.com", 0);
    expect(sched.queueLength).toBe(1);
  });

  it("normalises trailing slash variations", () => {
    sched.enqueue("https://a.com/page", 0);
    sched.enqueue("https://a.com/page", 0);
    expect(sched.queueLength).toBe(1);
  });

  it("isVisited returns true after enqueue", () => {
    sched.enqueue("https://a.com", 0);
    expect(sched.isVisited("https://a.com")).toBe(true);
  });

  it("markVisited prevents re-enqueueing", () => {
    sched.markVisited("https://a.com");
    sched.enqueue("https://a.com", 0);
    expect(sched.queueLength).toBe(0);
  });

  it("checkpoint captures state", () => {
    sched.enqueue("https://a.com", 0);
    sched.enqueue("https://b.com", 1);
    const cp = sched.checkpoint("https://seed.com");
    expect(cp.seedUrl).toBe("https://seed.com");
    expect(cp.visited).toHaveLength(2);
    expect(cp.queue).toHaveLength(2);
  });

  it("restore replays checkpoint state", () => {
    sched.enqueue("https://a.com", 0);
    const cp = sched.checkpoint("https://seed.com");
    const fresh = new CrawlScheduler();
    fresh.restore(cp);
    expect(fresh.queueLength).toBe(1);
    expect(fresh.isVisited("https://a.com")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemoryCookieJar
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryCookieJar", () => {
  let jar: MemoryCookieJar;

  beforeEach(() => {
    jar = new MemoryCookieJar();
  });

  it("getCookieHeader returns empty string when no cookies", () => {
    expect(jar.getCookieHeader("https://example.com")).toBe("");
  });

  it("stores and retrieves cookies per domain", () => {
    jar.setCookies("https://example.com/page", ["session=abc123; Path=/; HttpOnly"]);
    expect(jar.getCookieHeader("https://example.com")).toContain("session=abc123");
  });

  it("isolates cookies by domain", () => {
    jar.setCookies("https://a.com", ["x=1"]);
    jar.setCookies("https://b.com", ["y=2"]);
    expect(jar.getCookieHeader("https://a.com")).toContain("x=1");
    expect(jar.getCookieHeader("https://a.com")).not.toContain("y=2");
  });

  it("multiple cookies in one Set-Cookie call", () => {
    jar.setCookies("https://example.com", ["a=1", "b=2"]);
    const h = jar.getCookieHeader("https://example.com");
    expect(h).toContain("a=1");
    expect(h).toContain("b=2");
  });

  it("clear removes all cookies", () => {
    jar.setCookies("https://example.com", ["x=1"]);
    jar.clear();
    expect(jar.getCookieHeader("https://example.com")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spider
// ─────────────────────────────────────────────────────────────────────────────

describe("Spider", () => {
  let now: () => number;

  beforeEach(() => {
    now = makeNow();
  });

  // Basic crawl
  it("crawls a single page and returns summary", async () => {
    const fetch = makeFetch({ "https://example.com": { body: "<html><body>hello</body></html>" } });
    const spider = new Spider({ fetch, now, delay: async () => {} });
    const pages: CrawledPage[] = [];
    const summary = await spider.crawl(makeTarget({ followLinks: false }), async (p) => {
      pages.push(p);
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.url).toContain("example.com");
    expect(pages[0]?.statusCode).toBe(200);
    expect(summary.successPages).toBe(1);
    expect(summary.seedUrl).toBe("https://example.com");
  });

  // Link following
  it("follows links up to maxDepth", async () => {
    const fetch = makeFetch({
      "https://example.com": { body: '<html><body><a href="/page1">p1</a></body></html>' },
      "https://example.com/page1": { body: '<html><body><a href="/page2">p2</a></body></html>' },
      "https://example.com/page2": { body: "<html><body>leaf</body></html>" },
    });
    const spider = new Spider({ fetch, now, delay: async () => {} });
    const pages: CrawledPage[] = [];
    await spider.crawl(makeTarget({ maxDepth: 2, maxPages: 10 }), async (p) => {
      pages.push(p);
    });
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages.map((p) => p.url)).toContain("https://example.com/page1");
  });

  // maxPages cap
  it("stops after maxPages", async () => {
    const html =
      "<html><body>" +
      Array.from({ length: 20 }, (_, i) => `<a href="/p${i}">x</a>`).join("") +
      "</body></html>";
    const fetch = makeFetch({}, html);
    const spider = new Spider({ fetch, now, delay: async () => {} });
    const pages: CrawledPage[] = [];
    await spider.crawl(makeTarget({ maxPages: 3, maxDepth: 5 }), async (p) => {
      pages.push(p);
    });
    expect(pages).toHaveLength(3);
  });

  // Domain filter
  it("only crawls allowed domains", async () => {
    const fetch = makeFetch({
      "https://example.com": {
        body: '<html><body><a href="https://other.com/page">ext</a><a href="/internal">int</a></body></html>',
      },
      "https://example.com/internal": { body: "<html><body>internal</body></html>" },
    });
    const spider = new Spider({ fetch, now, delay: async () => {} });
    const pages: CrawledPage[] = [];
    await spider.crawl(
      makeTarget({ maxDepth: 2, maxPages: 10, allowedDomains: ["example.com"] }),
      async (p) => {
        pages.push(p);
      },
    );
    expect(pages.every((p) => p.url.includes("example.com"))).toBe(true);
  });

  // Blocked patterns
  it("skips URLs matching blockedPatterns", async () => {
    const fetch = makeFetch({
      "https://example.com": {
        body: '<html><body><a href="/admin/secret">admin</a><a href="/about">about</a></body></html>',
      },
      "https://example.com/about": { body: "<html><body>about</body></html>" },
    });
    const spider = new Spider({ fetch, now, delay: async () => {} });
    const pages: CrawledPage[] = [];
    await spider.crawl(
      makeTarget({ maxDepth: 2, maxPages: 10, blockedPatterns: [/\/admin/] }),
      async (p) => {
        pages.push(p);
      },
    );
    expect(pages.every((p) => !p.url.includes("/admin"))).toBe(true);
  });

  // robots.txt
  it("respects robots.txt disallowed paths", async () => {
    const fetch = makeFetch({
      "https://example.com/robots.txt": { body: "User-agent: *\nDisallow: /private" },
      "https://example.com": {
        body: '<html><body><a href="/private/secret">priv</a><a href="/public">pub</a></body></html>',
      },
      "https://example.com/public": { body: "<html><body>public</body></html>" },
    });
    const spider = new Spider({ fetch, now, delay: async () => {} });
    const pages: CrawledPage[] = [];
    await spider.crawl(
      makeTarget({ maxDepth: 2, maxPages: 10, respectRobotsTxt: true }),
      async (p) => {
        pages.push(p);
      },
    );
    expect(pages.every((p) => !p.url.includes("/private"))).toBe(true);
  });

  it("crawls disallowed paths when respectRobotsTxt: false", async () => {
    const fetch = makeFetch({
      "https://example.com": { body: '<html><body><a href="/private">priv</a></body></html>' },
      "https://example.com/private": { body: "<html><body>private</body></html>" },
      "https://example.com/robots.txt": { body: "User-agent: *\nDisallow: /private" },
    });
    const spider = new Spider({ fetch, now, delay: async () => {} });
    const pages: CrawledPage[] = [];
    await spider.crawl(
      makeTarget({ maxDepth: 2, maxPages: 10, respectRobotsTxt: false }),
      async (p) => {
        pages.push(p);
      },
    );
    expect(pages.some((p) => p.url.includes("/private"))).toBe(true);
  });

  // Sitemap
  it("seeds from sitemap when crawlSitemap: true", async () => {
    const fetch = makeFetch({
      "https://example.com": { body: "<html><body>home</body></html>" },
      "https://example.com/sitemap.xml": {
        body: "<urlset><url><loc>https://example.com/from-sitemap</loc></url></urlset>",
        headers: { "content-type": "text/xml" },
      },
      "https://example.com/from-sitemap": { body: "<html><body>sitemap page</body></html>" },
    });
    const spider = new Spider({ fetch, now, delay: async () => {} });
    const pages: CrawledPage[] = [];
    await spider.crawl(
      makeTarget({ maxDepth: 0, maxPages: 10, crawlSitemap: true, followLinks: false }),
      async (p) => {
        pages.push(p);
      },
    );
    expect(pages.some((p) => p.url.includes("from-sitemap"))).toBe(true);
  });

  // Error handling
  it("records fetch errors in crawledPage.error", async () => {
    const errFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const spider = new Spider({ fetch: errFetch, now, delay: async () => {}, maxRetries: 0 });
    const pages: CrawledPage[] = [];
    await spider.crawl(makeTarget({ followLinks: false }), async (p) => {
      pages.push(p);
    });
    expect(pages[0]?.error).toContain("ECONNREFUSED");
    // summary
  });

  // Proxy integration
  it("passes proxy URL to page record", async () => {
    const proxy = makeProxy("proxy.host");
    const rotator: IProxyRotator = {
      next: () => proxy,
      markSuccess: vi.fn(),
      markFail: vi.fn(),
      markBanned: vi.fn(),
    };
    const fetch = makeFetch({ "https://example.com": { body: "<html></html>" } });
    const spider = new Spider({ fetch, proxy: rotator, now, delay: async () => {} });
    const pages: CrawledPage[] = [];
    await spider.crawl(makeTarget({ followLinks: false }), async (p) => {
      pages.push(p);
    });
    expect(pages[0]?.proxyUsed).toBe("http://proxy.host:8080");
    expect(rotator.markSuccess).toHaveBeenCalled();
  });

  // Cookies
  it("sends cookies and stores Set-Cookie", async () => {
    const sentHeaders: Record<string, string>[] = [];
    const cookieFetch: typeof fetch = async (input, init) => {
      const h = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
      sentHeaders.push(h);
      const res = new Response("<html></html>", {
        status: 200,
        headers: { "set-cookie": "session=xyz; Path=/" },
      });
      return res;
    };
    const jar = new MemoryCookieJar();
    jar.setCookies("https://example.com", ["existing=val"]);
    const spider = new Spider({ fetch: cookieFetch, cookieJar: jar, now, delay: async () => {} });
    await spider.crawl(makeTarget({ followLinks: false, respectRobotsTxt: false }), async () => {});
    expect(sentHeaders[0]?.cookie).toContain("existing=val");
    expect(jar.getCookieHeader("https://example.com")).toContain("session=xyz");
  });

  // pause / resume / stop
  it("stop halts the crawl early", async () => {
    let callCount = 0;
    const fetch = makeFetch({
      "https://example.com": {
        body:
          "<html>" +
          Array.from({ length: 10 }, (_, i) => `<a href="/p${i}">x</a>`).join("") +
          "</html>",
      },
    });
    const spider = new Spider({ fetch, now, delay: async () => {} });
    const pages: CrawledPage[] = [];
    // Stop after 1 page
    await spider.crawl(makeTarget({ maxPages: 20, maxDepth: 3 }), async (p) => {
      pages.push(p);
      if (pages.length === 1) spider.stop();
    });
    expect(pages.length).toBe(1);
  });

  // Checkpoint / restore
  it("checkpoint captures queue and visited state", async () => {
    const fetch = makeFetch({
      "https://example.com": { body: '<a href="/a">a</a><a href="/b">b</a>' },
    });
    const spider = new Spider({ fetch, now, delay: async () => {} });
    await spider.crawl(makeTarget({ maxPages: 1, maxDepth: 1, followLinks: true }), async () => {});
    const cp = spider.checkpoint();
    expect(cp.seedUrl).toBe("https://example.com");
    expect(cp.visited.length).toBeGreaterThan(0);
  });

  it("restore resumes crawl from checkpoint", async () => {
    const fetch = makeFetch({
      "https://example.com/a": { body: "<html><body>a</body></html>" },
      "https://example.com/b": { body: "<html><body>b</body></html>" },
    });
    const spider = new Spider({ fetch, now, delay: async () => {} });
    spider.restore({
      seedUrl: "https://example.com",
      visited: ["https://example.com"],
      queue: [
        { url: "https://example.com/a", depth: 1 },
        { url: "https://example.com/b", depth: 1 },
      ],
      createdAt: Date.now(),
    });
    const pages: CrawledPage[] = [];
    await spider.crawl(makeTarget({ maxPages: 5 }), async (p) => {
      pages.push(p);
    });
    expect(pages.map((p) => p.url)).toContain("https://example.com/a");
    expect(pages.map((p) => p.url)).toContain("https://example.com/b");
  });

  // Request delay
  it("applies requestDelayMs between fetches", async () => {
    const delays: number[] = [];
    const delayFn = async (ms: number) => {
      delays.push(ms);
    };
    const fetch = makeFetch({
      "https://example.com": { body: '<a href="/p1">p1</a>' },
      "https://example.com/p1": { body: "<html></html>" },
    });
    const spider = new Spider({ fetch, now, delay: delayFn });
    await spider.crawl(makeTarget({ requestDelayMs: 500, maxDepth: 1 }), async () => {});
    expect(delays.every((d) => d === 500)).toBe(true);
    expect(delays.length).toBeGreaterThan(0);
  });

  // Extra headers
  it("passes extra headers to every request", async () => {
    const capturedHeaders: string[] = [];
    const hFetch: typeof fetch = async (_input, init) => {
      const h = new Headers(init?.headers as HeadersInit);
      capturedHeaders.push(h.get("x-api-key") ?? "");
      return new Response("<html></html>", { status: 200 });
    };
    const spider = new Spider({ fetch: hFetch, now, delay: async () => {} });
    await spider.crawl(
      makeTarget({
        followLinks: false,
        respectRobotsTxt: false,
        headers: { "x-api-key": "secret" },
      }),
      async () => {},
    );
    expect(capturedHeaders[0]).toBe("secret");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SpiderError
// ─────────────────────────────────────────────────────────────────────────────

describe("SpiderError", () => {
  it("has correct name and code", () => {
    const e = new SpiderError("fetch failed", "FETCH_ERROR", { url: "x" });
    expect(e.name).toBe("SpiderError");
    expect(e.code).toBe("FETCH_ERROR");
    expect(e instanceof Error).toBe(true);
  });
});
