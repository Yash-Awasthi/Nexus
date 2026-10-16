// SPDX-License-Identifier: Apache-2.0
/** Web search with no key: DuckDuckGo's HTML results page, then Wikipedia, when no search key is saved. */

interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  score: number;
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Results from a DuckDuckGo HTML page, links unwrapped from its redirect, ads skipped. */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const block of html.split(/class="result__a"/).slice(1)) {
    const href = /href="([^"]+)"/.exec(block)?.[1] ?? "";
    const wrapped = /[?&]uddg=([^&"]+)/.exec(href)?.[1];
    const url = wrapped ? decodeURIComponent(wrapped) : href;
    if (!/^https?:\/\//.test(url) || href.includes("duckduckgo.com/y.js") || seen.has(url))
      continue;
    seen.add(url);
    hits.push({
      url,
      title: text(/>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? url),
      snippet: text(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? ""),
      score: 1 - hits.length * 0.05,
    });
  }
  return hits;
}

export async function searchDuckDuckGo(query: string, max: number): Promise<SearchHit[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Nexus)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  return parseDuckDuckGo(await res.text()).slice(0, max);
}

/** Wikipedia's search API: no key and answers servers that DuckDuckGo turns away. */
export async function searchWikipedia(query: string, max: number): Promise<SearchHit[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${max}&srsearch=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Nexus (https://github.com/Yash-Awasthi/Nexus)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  const data = (await res.json()) as { query?: { search?: { title: string; snippet: string }[] } };
  return (data.query?.search ?? []).map((r, i) => ({
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    title: r.title,
    snippet: text(r.snippet),
    score: 1 - i * 0.05,
  }));
}
