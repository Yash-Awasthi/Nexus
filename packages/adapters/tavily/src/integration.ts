// SPDX-License-Identifier: Apache-2.0
interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilySearchResponse {
  results: TavilyResult[];
  answer?: string;
  query: string;
}

async function tavilyFetch(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  const key = process.env["TAVILY_API_KEY"];
  if (!key) throw new Error("TAVILY_API_KEY not set");
  const res = await fetch(`https://api.tavily.com/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ api_key: key, ...body }),
  });
  if (!res.ok) throw new Error(`Tavily error: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function search(
  query: string,
  opts: { depth?: "basic" | "advanced"; maxResults?: number; includeAnswer?: boolean } = {},
): Promise<TavilySearchResponse> {
  return tavilyFetch("search", {
    query,
    search_depth: opts.depth ?? "basic",
    max_results: opts.maxResults ?? 5,
    include_answer: opts.includeAnswer ?? true,
  }) as Promise<TavilySearchResponse>;
}

export async function searchAndSummarize(query: string): Promise<string> {
  const res = await search(query, { depth: "advanced", maxResults: 5, includeAnswer: true });
  if (res.answer) return res.answer;
  return res.results
    .slice(0, 3)
    .map((r) => `${r.title}\n${r.content}`)
    .join("\n\n");
}

export async function fetchPage(url: string): Promise<string> {
  return tavilyFetch("extract", { urls: [url] }) as Promise<string>;
}
