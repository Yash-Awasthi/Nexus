// SPDX-License-Identifier: Apache-2.0
/**
 * searxng-client — Self-hosted SearXNG metasearch adapter.
 *
 * Provides:
 *   • SearxngResult      — normalised search hit
 *   • SearxngClient      — query SearXNG instance (injectable HTTP)
 *   • MultiEngineRouter  — fan-out queries across multiple SearXNG instances
 *   • ResultDeduplicator — merge + deduplicate results by URL
 *   • QueryBuilder       — build SearXNG-compatible query strings
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SearchCategory = "general" | "images" | "news" | "files" | "social" | "science" | "it";

/** Searxng result interface definition. */
export interface SearxngResult {
  url: string;
  title: string;
  content: string;
  engine: string; // which sub-engine returned this
  score: number;
  category: SearchCategory;
  publishedDate?: string;
}

/** Searxng response interface definition. */
export interface SearxngResponse {
  query: string;
  results: SearxngResult[];
  suggestions: string[];
  answers: string[];
  infoboxes: Array<{ infobox: string; content: string }>;
  number_of_results: number;
  latency: number;
}

/** Searxng query options interface definition. */
export interface SearxngQueryOptions {
  categories?: SearchCategory[];
  engines?: string[];
  language?: string;
  pageno?: number;
  timeRange?: "day" | "week" | "month" | "year";
  safeSearch?: 0 | 1 | 2;
  format?: "json" | "csv" | "rss";
}

// ── HTTP transport ─────────────────────────────────────────────────────────────

export type HttpGetFn = (url: string, headers?: Record<string, string>) => Promise<unknown>;

const DEFAULT_HTTP: HttpGetFn = async (url) => {
  // In real usage this would do fetch(url, ...) and parse JSON
  throw new Error(`Real HTTP not available in test environment. Requested: ${url}`);
};

// ── QueryBuilder ──────────────────────────────────────────────────────────────

export class QueryBuilder {
  private params: Record<string, string> = {};

  setQuery(q: string): this {
    this.params["q"] = q;
    return this;
  }

  setCategories(cats: SearchCategory[]): this {
    this.params["categories"] = cats.join(",");
    return this;
  }

  setEngines(engines: string[]): this {
    this.params["engines"] = engines.join(",");
    return this;
  }

  setLanguage(lang: string): this {
    this.params["language"] = lang;
    return this;
  }

  setPage(page: number): this {
    this.params["pageno"] = String(page);
    return this;
  }

  setTimeRange(range: "day" | "week" | "month" | "year"): this {
    this.params["time_range"] = range;
    return this;
  }

  setSafeSearch(level: 0 | 1 | 2): this {
    this.params["safesearch"] = String(level);
    return this;
  }

  setFormat(format: "json" | "csv" | "rss"): this {
    this.params["format"] = format;
    return this;
  }

  build(baseUrl: string): string {
    const qs = new URLSearchParams(this.params).toString();
    return `${baseUrl.replace(/\/$/, "")}/search?${qs}`;
  }

  getParams(): Record<string, string> {
    return { ...this.params };
  }
}

// ── SearxngClient ─────────────────────────────────────────────────────────────

export class SearxngClient {
  private baseUrl: string;
  private http: HttpGetFn;
  private defaultOptions: SearxngQueryOptions;

  constructor(
    baseUrl: string,
    opts: { http?: HttpGetFn; defaults?: SearxngQueryOptions } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.http = opts.http ?? DEFAULT_HTTP;
    this.defaultOptions = opts.defaults ?? {};
  }

  async search(query: string, opts: SearxngQueryOptions = {}): Promise<SearxngResponse> {
    const merged = { ...this.defaultOptions, ...opts };
    const builder = new QueryBuilder()
      .setQuery(query)
      .setFormat("json");

    if (merged.categories?.length) builder.setCategories(merged.categories);
    if (merged.engines?.length) builder.setEngines(merged.engines);
    if (merged.language) builder.setLanguage(merged.language);
    if (merged.pageno) builder.setPage(merged.pageno);
    if (merged.timeRange) builder.setTimeRange(merged.timeRange);
    if (merged.safeSearch !== undefined) builder.setSafeSearch(merged.safeSearch);

    const url = builder.build(this.baseUrl);
    const raw = await this.http(url) as SearxngResponse;
    return raw;
  }

  getBaseUrl(): string { return this.baseUrl; }
}

// ── ResultDeduplicator ────────────────────────────────────────────────────────

export class ResultDeduplicator {
  private seen = new Set<string>();
  private results: SearxngResult[] = [];

  add(results: SearxngResult[]): this {
    for (const r of results) {
      const key = r.url.toLowerCase();
      if (!this.seen.has(key)) {
        this.seen.add(key);
        this.results.push(r);
      }
    }
    return this;
  }

  /** Return deduplicated results sorted by score descending. */
  get(sort = true): SearxngResult[] {
    return sort ? [...this.results].sort((a, b) => b.score - a.score) : [...this.results];
  }

  count(): number { return this.results.length; }

  clear(): void {
    this.seen.clear();
    this.results = [];
  }
}

// ── MultiEngineRouter ─────────────────────────────────────────────────────────

export interface RouterInstance {
  client: SearxngClient;
  weight: number; // higher = results ranked earlier when merging
  name: string;
}

/** Router result interface definition. */
export interface RouterResult {
  query: string;
  results: SearxngResult[];
  instanceResults: Map<string, SearxngResult[]>;
  totalDurationMs: number;
}

/** Multi engine router. */
export class MultiEngineRouter {
  private instances: RouterInstance[];

  constructor(instances: RouterInstance[]) {
    this.instances = instances;
  }

  async search(query: string, opts: SearxngQueryOptions = {}): Promise<RouterResult> {
    const t0 = Date.now();
    const instanceResults = new Map<string, SearxngResult[]>();

    const responses = await Promise.allSettled(
      this.instances.map(async (inst) => {
        const resp = await inst.client.search(query, opts);
        // Apply weight to scores
        const weighted = resp.results.map((r) => ({ ...r, score: r.score * inst.weight }));
        return { name: inst.name, results: weighted };
      }),
    );

    const dedup = new ResultDeduplicator();
    for (const r of responses) {
      if (r.status === "fulfilled") {
        instanceResults.set(r.value.name, r.value.results);
        dedup.add(r.value.results);
      }
    }

    return {
      query,
      results: dedup.get(),
      instanceResults,
      totalDurationMs: Date.now() - t0,
    };
  }

  addInstance(inst: RouterInstance): void {
    this.instances.push(inst);
  }

  instanceCount(): number { return this.instances.length; }
}
