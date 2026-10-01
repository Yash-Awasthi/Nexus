// SPDX-License-Identifier: Apache-2.0
/** Web search clients: SearxNG, Exa, Brave and Serper. */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SearchSource = "exa" | "brave" | "serper";
/** Search result type type alias. */
export type SearchResultType = "document" | "message" | "code" | "event" | "note";

/** Search result interface definition. */
export interface SearchResult {
  id: string;
  content: string;
  source: SearchSource;
  type: SearchResultType;
  score: number; // 0–1
  timestamp: string; // ISO-8601
  projectId?: string;
  metadata?: Record<string, unknown>;
}

// ── SearxNG ─────────────────────────────────────────────────────────────────
//
// Privacy-preserving web search via a self-hosted SearxNG instance.
// Extracted from Vane (MIT). Set SEARXNG_URL env to your instance.
// Supports category/engine/language/page-number filtering.

export interface SearxNGOptions {
  categories?: string[];
  engines?: string[];
  language?: string;
  pageno?: number;
  timeoutMs?: number;
}

export interface SearxNGResult {
  title: string;
  url: string;
  content?: string;
  author?: string;
  img_src?: string;
  thumbnail_src?: string;
}

export interface SearxNGResponse {
  results: SearxNGResult[];
  suggestions: string[];
}

/** Fetch from a SearxNG instance. Set SEARXNG_URL (e.g. http://localhost:8888). */
export async function searchSearxNG(
  query: string,
  opts: SearxNGOptions = {},
): Promise<SearxNGResponse> {
  const base = (process.env.SEARXNG_URL ?? "http://localhost:8888").replace(/\/$/, "");
  const url = new URL(`${base}/search?format=json`);
  url.searchParams.set("q", query);
  if (opts.categories?.length) url.searchParams.set("categories", opts.categories.join(","));
  if (opts.engines?.length) url.searchParams.set("engines", opts.engines.join(","));
  if (opts.language) url.searchParams.set("language", opts.language);
  if (opts.pageno) url.searchParams.set("pageno", String(opts.pageno));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`SearxNG ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as { results?: SearxNGResult[]; suggestions?: string[] };
    return { results: data.results ?? [], suggestions: data.suggestions ?? [] };
  } finally {
    clearTimeout(timer);
  }
}
// ── Exa ─────────────────────────────────────────────────────────────────
//
// Neural/keyword web search via Exa (api.exa.ai). Set EXA_API_KEY.
// Returns scored results with optional inline page text.

export interface ExaOptions {
  /** Exa API key — defaults to process.env.EXA_API_KEY */
  apiKey?: string;
  /** Retrieval mode: "auto" (default) | "neural" | "keyword" */
  type?: "auto" | "neural" | "keyword";
  /** Inline page text in results (default: true). */
  includeText?: boolean;
  /** Request timeout in ms (default: 10_000). */
  timeoutMs?: number;
  /** Injectable fetch for testing. */
  fetchFn?: FetchLike;
}

/** Minimal fetch shape so tests can inject without node types. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

interface ExaApiResponse {
  results?: {
    id?: string;
    url?: string;
    title?: string;
    text?: string;
    score?: number;
    publishedDate?: string;
  }[];
}

/** Search the web via Exa. Set EXA_API_KEY (or pass apiKey). */
export async function searchExa(query: string, opts: ExaOptions = {}): Promise<SearchResult[]> {
  const apiKey = opts.apiKey ?? process.env.EXA_API_KEY ?? "";
  if (!apiKey) throw new Error("Exa search requires an API key — set EXA_API_KEY");
  const doFetch = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        numResults: 10,
        type: opts.type ?? "auto",
        ...(opts.includeText !== false ? { text: true } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Exa ${res.status}: ${res.statusText ?? ""}`);
    const data = (await res.json()) as ExaApiResponse;
    return (data.results ?? []).map((r, i) => ({
      id: r.id ?? `exa-${i}`,
      content: r.text ?? r.title ?? "",
      source: "exa" as SearchSource,
      type: "document" as SearchResultType,
      score: r.score ?? 1 - i * 0.05,
      timestamp: r.publishedDate ?? new Date().toISOString(),
      metadata: { url: r.url, title: r.title },
    }));
  } finally {
    clearTimeout(timer);
  }
}

// ── Brave ───────────────────────────────────────────────────────────────
//
// Web search via Brave Search's API (api.search.brave.com). Set
// BRAVE_API_KEY — the auth header is the unusual X-Subscription-Token.

export interface BraveOptions {
  /** Brave API key — defaults to process.env.BRAVE_API_KEY */
  apiKey?: string;
  /** Result freshness, e.g. "pd" (24h), "pw", "pm", "py". */
  freshness?: string;
  /** Country code (default: "us"). */
  country?: string;
  /** Request timeout in ms (default: 10_000). */
  timeoutMs?: number;
  /** Injectable fetch for testing. */
  fetchFn?: FetchLike;
}

interface BraveApiResponse {
  web?: { results?: { title?: string; url?: string; description?: string; age?: string }[] };
}

/** Search the web via Brave. Set BRAVE_API_KEY (or pass apiKey). */
export async function searchBrave(query: string, opts: BraveOptions = {}): Promise<SearchResult[]> {
  const apiKey = opts.apiKey ?? process.env.BRAVE_API_KEY ?? "";
  if (!apiKey) throw new Error("Brave search requires an API key — set BRAVE_API_KEY");
  const doFetch = opts.fetchFn ?? fetch;
  const params = new URLSearchParams({
    q: query,
    count: "10",
    country: opts.country ?? "us",
    ...(opts.freshness ? { freshness: opts.freshness } : {}),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Brave ${res.status}: ${res.statusText ?? ""}`);
    const data = (await res.json()) as BraveApiResponse;
    return (data.web?.results ?? []).map((r, i) => ({
      id: `brave-${i}`,
      content: r.description ?? r.title ?? "",
      source: "brave" as SearchSource,
      type: "document" as SearchResultType,
      score: 1 - i * 0.05,
      timestamp: r.age ?? new Date().toISOString(),
      metadata: { url: r.url, title: r.title },
    }));
  } finally {
    clearTimeout(timer);
  }
}

// ── Serper ──────────────────────────────────────────────────────────────
//
// Google-results search via Serper.dev. Set SERPER_API_KEY. POST {q} →
// organic results with position-derived scores.

export interface SerperOptions {
  /** Serper API key — defaults to process.env.SERPER_API_KEY */
  apiKey?: string;
  /** Google country/language params (default: us / en). */
  gl?: string;
  hl?: string;
  /** Request timeout in ms (default: 10_000). */
  timeoutMs?: number;
  /** Injectable fetch for testing. */
  fetchFn?: FetchLike;
}

interface SerperApiResponse {
  organic?: {
    title?: string;
    link?: string;
    snippet?: string;
    position?: number;
    date?: string;
  }[];
}

/** Search the web via Serper. Set SERPER_API_KEY (or pass apiKey). */
export async function searchSerper(
  query: string,
  opts: SerperOptions = {},
): Promise<SearchResult[]> {
  const apiKey = opts.apiKey ?? process.env.SERPER_API_KEY ?? "";
  if (!apiKey) throw new Error("Serper search requires an API key — set SERPER_API_KEY");
  const doFetch = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 10, gl: opts.gl ?? "us", hl: opts.hl ?? "en" }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Serper ${res.status}: ${res.statusText ?? ""}`);
    const data = (await res.json()) as SerperApiResponse;
    return (data.organic ?? []).map((r, i) => ({
      id: `serper-${i}`,
      content: r.snippet ?? r.title ?? "",
      source: "serper" as SearchSource,
      type: "document" as SearchResultType,
      score: 1 - i * 0.05,
      timestamp: r.date ?? new Date().toISOString(),
      metadata: { url: r.link, title: r.title },
    }));
  } finally {
    clearTimeout(timer);
  }
}
