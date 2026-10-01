// SPDX-License-Identifier: Apache-2.0
import { AdaptiveScraper, RobotsChecker, type ScrapeResult } from "@nexus/adaptive-scraper";
import { describe, expect, it } from "vitest";

import { importSite, sameSiteLinks } from "../../src/lib/site-import.js";

const body = (words: string) => `${words} `.repeat(60);
const SITE: Record<string, string> = {
  "https://docs.example.com/":
    '<title>Home</title><a href="/guide">g</a><a href="/private/keys">p</a><a href="https://other.com/x">o</a>',
  "https://docs.example.com/guide": `<title>Guide</title><a href="/">home</a><p>${body("install")}</p>`,
  "https://docs.example.com/private/keys": `<title>Keys</title><p>${body("secret")}</p>`,
};

function fakeScraper(): AdaptiveScraper {
  const scraper = new AdaptiveScraper([]);
  scraper.scrape = async (url: string): Promise<ScrapeResult> => {
    const html = SITE[url];
    return {
      url,
      html: html ?? "",
      text: (html ?? "").replace(/<[^>]+>/g, " "),
      status: html ? "success" : "error",
      engine: "httpx",
      durationMs: 1,
    };
  };
  return scraper;
}

const robots = () =>
  new RobotsChecker({
    fetch: (async () =>
      new Response("User-agent: *\nDisallow: /private\n")) as unknown as typeof fetch,
  });

describe("importSite", () => {
  it("collects same-site pages with enough text and obeys robots.txt", async () => {
    const out = await importSite("https://docs.example.com/", {
      scraper: fakeScraper(),
      robots: robots(),
      maxPages: 10,
    });
    expect(out.pages.map((p) => [p.url, p.title])).toEqual([
      ["https://docs.example.com/guide", "Guide"],
    ]);
    expect(out.disallowed).toBe(1);
  });

  it("stops at the page cap", async () => {
    const out = await importSite("https://docs.example.com/guide", {
      scraper: fakeScraper(),
      robots: robots(),
      maxPages: 1,
    });
    expect(out.pages).toHaveLength(1);
  });

  it("reads absolute same-site links only", () => {
    expect(
      sameSiteLinks(
        '<a href="/a#x">a</a><a href=\'b\'>b</a><a href="mailto:x@y.z">m</a><a href="https://evil.com/">e</a>',
        "https://s.com/dir/",
      ),
    ).toEqual(["https://s.com/a", "https://s.com/dir/b"]);
  });
});
