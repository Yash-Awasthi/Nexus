// SPDX-License-Identifier: Apache-2.0
/**
 * Crawl one website into pages of text: same-site links only, robots.txt obeyed,
 * a hard page cap. The knowledge-base import stores what this returns.
 */
import { SpiderCrawler, type AdaptiveScraper, type RobotsChecker } from "@nexus/adaptive-scraper";

interface ImportedPage {
  url: string;
  title: string;
  text: string;
}

interface SiteImport {
  pages: ImportedPage[];
  /** Pages robots.txt told us to leave alone. */
  disallowed: number;
}

const MIN_TEXT_CHARS = 200;

/** Same-site http(s) links in a page, absolute and without fragments. */
export function sameSiteLinks(html: string, pageUrl: string): string[] {
  const base = new URL(pageUrl);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)[^"']*["']/gi)) {
    try {
      const u = new URL(m[1]!, base);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.host === base.host) {
        u.hash = "";
        out.add(u.href);
      }
    } catch {
      /* not a URL */
    }
  }
  return [...out];
}

function titleOf(html: string, url: string): string {
  const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  return t || new URL(url).pathname || url;
}

export async function importSite(
  startUrl: string,
  opts: { scraper: AdaptiveScraper; robots: RobotsChecker; maxPages: number },
): Promise<SiteImport> {
  const pages: ImportedPage[] = [];
  let disallowed = 0;
  const allowed = async (url: string) => {
    if (await opts.robots.canFetch(url)) return true;
    disallowed++;
    return false;
  };
  if (!(await allowed(startUrl))) return { pages, disallowed };

  const spider = new SpiderCrawler(
    opts.scraper,
    async (result) => {
      if (pages.length < opts.maxPages && result.text.trim().length >= MIN_TEXT_CHARS) {
        pages.push({ url: result.url, title: titleOf(result.html, result.url), text: result.text });
      }
      if (pages.length >= opts.maxPages) return [];
      const next = [];
      for (const url of sameSiteLinks(result.html, result.url)) {
        if (await allowed(url)) next.push({ url });
      }
      return next;
    },
    {
      concurrency: 3,
      // Seen URLs, not fetched pages: leaves room for thin pages that get skipped.
      maxRequests: opts.maxPages * 3,
      allowedDomains: [new URL(startUrl).hostname],
      downloadDelayMs: Math.max(0, (await opts.robots.crawlDelayMs(startUrl)) ?? 300),
    },
  );
  await spider.start([startUrl]);
  return { pages, disallowed };
}
