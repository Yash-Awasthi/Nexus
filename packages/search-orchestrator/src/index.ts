// SPDX-License-Identifier: Apache-2.0
/**
 * search-orchestrator — Strategy-chain search with timeline output.
 *
 * Provides:
 *   • SearchStrategy         — injectable strategy interface
 *   • SearchResult           — typed result with source + score
 *   • SearchFilters          — date/project/type filters
 *   • StrategyChain          — ordered fallback chain (first non-empty result wins)
 *   • TimelineBuilder        — groups results into dated timeline segments
 *   • SearchOrchestrator     — facade: filters → chain → timeline
 *   • MockSearchStrategy     — configurable in-memory test double
 *   • ChromaSearchStrategy   — real Chroma vector DB strategy (uses CHROMA_URL)
 *   • PgFullTextStrategy     — Postgres ILIKE full-text over memory_entries (uses DATABASE_URL)
 *   • HybridSearchStrategy   — vector + BM25 RRF fusion (wraps @nexus/hybrid-search; activated when CHROMA_URL is set)
 */

import { neon } from "@neondatabase/serverless";
import {
  HybridSearchEngine,
  InMemoryBM25,
  type SearchHit as HybridSearchHit,
  type VectorSearchAdapter,
} from "@nexus/hybrid-search";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SearchSource = "chroma" | "sqlite" | "hybrid" | "mock" | "exa" | "brave" | "serper";
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

/** Search filters interface definition. */
export interface SearchFilters {
  projectId?: string;
  types?: SearchResultType[];
  after?: string; // ISO-8601 lower bound
  before?: string; // ISO-8601 upper bound
  minScore?: number;
}

/** Search request interface definition. */
export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
  maxResults?: number;
  /** Multi-tenant ACL — when set, results are scoped to this userId only. */
  userId?: string;
}

/** Search response interface definition. */
export interface SearchResponse {
  results: SearchResult[];
  source: SearchSource;
  durationMs: number;
  totalFound: number;
}

// ── SearchStrategy interface ──────────────────────────────────────────────────

export interface SearchStrategy {
  readonly name: SearchSource;
  search(request: SearchRequest): Promise<SearchResponse>;
}

// ── MockSearchStrategy ────────────────────────────────────────────────────────

export interface MockStrategyBehavior {
  results?: SearchResult[];
  throws?: string;
  delayMs?: number;
  empty?: boolean;
}

let _sSeq = 0;

/** Mock search strategy. */
export class MockSearchStrategy implements SearchStrategy {
  readonly name: SearchSource;
  private behavior: MockStrategyBehavior;
  readonly calls: SearchRequest[] = [];

  constructor(name: SearchSource = "mock", behavior: MockStrategyBehavior = {}) {
    this.name = name;
    this.behavior = behavior;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    this.calls.push(request);
    if (this.behavior.delayMs) {
      await new Promise((r) => setTimeout(r, this.behavior.delayMs));
    }
    if (this.behavior.throws) throw new Error(this.behavior.throws);
    if (this.behavior.empty) {
      return { results: [], source: this.name, durationMs: 0, totalFound: 0 };
    }
    const results = this.behavior.results ?? [
      {
        id: `mock-${++_sSeq}`,
        content: `Result for: ${request.query}`,
        source: this.name,
        type: "document" as SearchResultType,
        score: 0.9,
        timestamp: new Date().toISOString(),
      },
    ];
    return { results, source: this.name, durationMs: 1, totalFound: results.length };
  }
}

// ── ChromaSearchStrategy ──────────────────────────────────────────────────────

/**
 * Real Chroma vector DB search strategy.
 * Requires a running Chroma instance (default: http://chroma:8000).
 * Set CHROMA_URL to override the endpoint.
 * Set CHROMA_COLLECTION to override the collection name (default: "nexus").
 */
export class ChromaSearchStrategy implements SearchStrategy {
  readonly name: SearchSource = "chroma";
  private chromaUrl: string;
  private collection: string;

  constructor(config: { chromaUrl?: string; collection?: string } = {}) {
    this.chromaUrl = config.chromaUrl ?? process.env.CHROMA_URL ?? "http://chroma:8000";
    this.collection = config.collection ?? process.env.CHROMA_COLLECTION ?? "nexus";
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const t0 = Date.now();
    try {
      const chromaBody: Record<string, unknown> = {
        query_texts: [request.query],
        n_results: request.maxResults ?? 10,
        include: ["documents", "metadatas", "distances"],
      };
      // Multi-tenant ACL: scope results to userId when provided
      if (request.userId) {
        chromaBody["where"] = { user_id: { $eq: request.userId } };
      }

      const resp = await fetch(`${this.chromaUrl}/api/v1/collections/${this.collection}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chromaBody),
      });

      if (!resp.ok) {
        return { results: [], source: "chroma", durationMs: Date.now() - t0, totalFound: 0 };
      }

      const data = (await resp.json()) as {
        documents?: string[][];
        metadatas?: (Record<string, unknown> | null)[][];
        distances?: number[][];
        ids?: string[][];
      };

      const docs = data.documents?.[0] ?? [];
      const metas = data.metadatas?.[0] ?? [];
      const dists = data.distances?.[0] ?? [];
      const ids = data.ids?.[0] ?? [];

      const results: SearchResult[] = docs.map((doc, i) => {
        const meta = metas[i] ?? {};
        return {
          id: ids[i] ?? `chroma-${i}`,
          content: doc,
          source: "chroma" as SearchSource,
          type: (meta?.["type"] as SearchResultType) ?? "document",
          // Chroma distances are L2; convert to 0–1 similarity (clamped)
          score: Math.max(0, Math.min(1, 1 - (dists[i] ?? 0))),
          timestamp: (meta?.["timestamp"] as string) ?? new Date().toISOString(),
          projectId: meta?.["projectId"] as string | undefined,
          metadata: meta ?? undefined,
        };
      });

      return { results, source: "chroma", durationMs: Date.now() - t0, totalFound: results.length };
    } catch {
      // Chroma unreachable — return empty so chain can fall through
      return { results: [], source: "chroma", durationMs: Date.now() - t0, totalFound: 0 };
    }
  }
}

// ── PgFullTextStrategy ────────────────────────────────────────────────────────

/**
 * Postgres full-text search over the memory_entries table using ILIKE.
 * Works with Neon cloud URLs. Falls back gracefully for local non-Neon postgres.
 * Set DATABASE_URL to enable.
 */
export class PgFullTextStrategy implements SearchStrategy {
  // Reuse the "sqlite" source name so existing chain consumers don't break
  readonly name: SearchSource = "sqlite";
  private sql: ReturnType<typeof neon> | null = null;

  constructor(connectionString?: string) {
    const url = connectionString ?? process.env.DATABASE_URL ?? "";
    if (url) {
      try {
        this.sql = neon(url);
      } catch {
        this.sql = null;
      }
    }
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const t0 = Date.now();
    if (!this.sql) {
      return { results: [], source: "sqlite", durationMs: 0, totalFound: 0 };
    }

    try {
      const pattern = `%${request.query.toLowerCase()}%`;
      const limit = request.maxResults ?? 10;
      const userId = request.userId ?? null;

      const rows = await this.sql`
        SELECT
          'mem-' || id::text   AS id,
          text                 AS content,
          'note'               AS type,
          created_at           AS timestamp,
          metadata
        FROM memory_entries
        WHERE LOWER(text) LIKE ${pattern}
          AND (${userId}::text IS NULL OR user_id = ${userId})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const results: SearchResult[] = (rows as Record<string, unknown>[]).map((row, i) => {
        const r = row as Record<string, unknown>;
        return {
          id: (r["id"] as string) ?? `pg-${i}`,
          content: (r["content"] as string) ?? "",
          source: "sqlite" as SearchSource,
          type: (r["type"] as SearchResultType) ?? "note",
          score: 0.75,
          timestamp: (r["timestamp"] as string) ?? new Date().toISOString(),
          metadata: (r["metadata"] as Record<string, unknown>) ?? undefined,
        };
      });

      return { results, source: "sqlite", durationMs: Date.now() - t0, totalFound: results.length };
    } catch {
      return { results: [], source: "sqlite", durationMs: Date.now() - t0, totalFound: 0 };
    }
  }
}

// ── HybridSearchStrategy ──────────────────────────────────────────────────────

/**
 * HybridSearchStrategy — parallel vector + BM25 with RRF fusion.
 *
 * Wraps HybridSearchEngine (from @nexus/hybrid-search).  The vector side is
 * supplied as an injectable VectorSearchAdapter (typically wrapping
 * ChromaSearchStrategy).  BM25 uses an in-process InMemoryBM25 index —
 * documents are indexed on-demand as hits arrive from the vector backend.
 *
 * Use via createDefaultOrchestrator() when CHROMA_URL is set; or construct
 * directly for custom wiring.
 */
export class HybridSearchStrategy implements SearchStrategy {
  readonly name: SearchSource = "hybrid";
  private readonly engine: HybridSearchEngine;
  private readonly bm25: InMemoryBM25;

  constructor(vectorAdapter: VectorSearchAdapter) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    this.bm25 = new InMemoryBM25();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    this.engine = new HybridSearchEngine(vectorAdapter, this.bm25);
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const t0 = Date.now();
    const limit = request.maxResults ?? 10;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const { hits } = await this.engine.search({ query: request.query, limit });

    // Feed vector hits into BM25 for future queries (incremental indexing)
    for (const hit of hits) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
      if (hit.text) this.bm25.add({ id: hit.id, text: hit.text, metadata: hit.metadata });
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unused-vars
    const results: SearchResult[] = hits.map((hit: HybridSearchHit, i: number) => ({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      id: hit.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      content: hit.text ?? "",
      source: "hybrid" as SearchSource,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      type: (hit.metadata?.["type"] as SearchResultType) ?? "document",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      score: hit.score,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      timestamp: (hit.metadata?.["timestamp"] as string) ?? new Date().toISOString(),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      projectId: hit.metadata?.["projectId"] as string | undefined,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      metadata: hit.metadata,
    }));

    // userId ACL: scope results when requested
    const filtered = request.userId
      ? results.filter((r) => !r.metadata?.["user_id"] || r.metadata["user_id"] === request.userId)
      : results;

    return {
      results: filtered,
      source: "hybrid",
      durationMs: Date.now() - t0,
      totalFound: filtered.length,
    };
  }
}

// ── Filter helpers ────────────────────────────────────────────────────────────

export function applyFilters(results: SearchResult[], filters: SearchFilters): SearchResult[] {
  return results.filter((r) => {
    if (filters.projectId && r.projectId !== filters.projectId) return false;
    if (filters.types && !filters.types.includes(r.type)) return false;
    if (filters.minScore !== undefined && r.score < filters.minScore) return false;
    if (filters.after && r.timestamp < filters.after) return false;
    if (filters.before && r.timestamp > filters.before) return false;
    return true;
  });
}

// ── StrategyChain ─────────────────────────────────────────────────────────────

export interface StrategyChainOptions {
  strategies: SearchStrategy[];
  /** If true, continues to next strategy even when current returns results */
  exhaustive?: boolean;
}

/** Strategy chain. */
export class StrategyChain {
  private strategies: SearchStrategy[];
  private exhaustive: boolean;

  constructor(opts: StrategyChainOptions) {
    this.strategies = opts.strategies;
    this.exhaustive = opts.exhaustive ?? false;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const t0 = Date.now();
    let lastResponse: SearchResponse = {
      results: [],
      source: "mock",
      durationMs: 0,
      totalFound: 0,
    };

    for (const strategy of this.strategies) {
      try {
        const response = await strategy.search(request);
        if (!this.exhaustive && response.results.length > 0) {
          return { ...response, durationMs: Date.now() - t0 };
        }
        // Merge results in exhaustive mode; track last in fallback mode
        if (this.exhaustive) {
          lastResponse = {
            results: [...lastResponse.results, ...response.results],
            source: response.source,
            durationMs: Date.now() - t0,
            totalFound: lastResponse.totalFound + response.totalFound,
          };
        } else {
          lastResponse = response;
        }
      } catch {
        // Strategy failed — continue to next
      }
    }
    return { ...lastResponse, durationMs: Date.now() - t0 };
  }

  strategies_(): SearchStrategy[] {
    return this.strategies;
  }
}

// ── TimelineBuilder ───────────────────────────────────────────────────────────

export interface TimelineSegment {
  date: string; // YYYY-MM-DD
  results: SearchResult[];
}

/** Timeline interface definition. */
export interface Timeline {
  segments: TimelineSegment[];
  totalResults: number;
}

/** Timeline builder. */
export class TimelineBuilder {
  /** Groups results by date (day bucket) and sorts segments chronologically. */
  build(results: SearchResult[]): Timeline {
    const buckets = new Map<string, SearchResult[]>();

    for (const r of results) {
      const day = r.timestamp.slice(0, 10); // YYYY-MM-DD
      const bucket = buckets.get(day) ?? [];
      bucket.push(r);
      buckets.set(day, bucket);
    }

    const segments: TimelineSegment[] = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, res]) => ({
        date,
        results: res.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      }));

    return { segments, totalResults: results.length };
  }

  /** Flatten timeline back to a sorted result list. */
  flatten(timeline: Timeline): SearchResult[] {
    return timeline.segments.flatMap((s) => s.results);
  }
}

// ── SearchOrchestrator ────────────────────────────────────────────────────────

export interface SearchOrchestratorOptions {
  chain: StrategyChain;
  timelineBuilder?: TimelineBuilder;
  defaultMaxResults?: number;
}

/** Search orchestrator. */
export class SearchOrchestrator {
  private chain: StrategyChain;
  private timelineBuilder: TimelineBuilder;
  private defaultMaxResults: number;

  constructor(opts: SearchOrchestratorOptions) {
    this.chain = opts.chain;
    this.timelineBuilder = opts.timelineBuilder ?? new TimelineBuilder();
    this.defaultMaxResults = opts.defaultMaxResults ?? 20;
  }

  /** Run search with filters applied, return flat response. */
  async search(request: SearchRequest): Promise<SearchResponse> {
    const req = { ...request, maxResults: request.maxResults ?? this.defaultMaxResults };
    const response = await this.chain.search(req);
    let filtered = request.filters
      ? applyFilters(response.results, request.filters)
      : response.results;
    // userId ACL post-filter (belt-and-suspenders for strategies that ignore it)
    if (request.userId) {
      filtered = filtered.filter(
        (r) => !r.metadata?.["user_id"] || r.metadata["user_id"] === request.userId,
      );
    }
    const sliced = filtered.slice(0, req.maxResults);
    return { ...response, results: sliced, totalFound: filtered.length };
  }

  /** Run search and return a timeline view. */
  async searchTimeline(request: SearchRequest): Promise<Timeline> {
    const response = await this.search(request);
    return this.timelineBuilder.build(response.results);
  }

  getChain(): StrategyChain {
    return this.chain;
  }
  getTimelineBuilder(): TimelineBuilder {
    return this.timelineBuilder;
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

/**
 * Adapt a {@link ChromaSearchStrategy} to @nexus/hybrid-search's
 * {@link VectorSearchAdapter} so its hits feed the RRF fusion engine (the
 * dense leg of {@link HybridSearchStrategy}). Pure object construction — no
 * I/O until `search` is called.
 */
export function chromaAsVectorAdapter(chroma: ChromaSearchStrategy): VectorSearchAdapter {
  return {
    async search(query: string, limit: number): Promise<HybridSearchHit[]> {
      const resp = await chroma.search({ query, maxResults: limit });
      return resp.results.map((r) => ({
        id: r.id,
        score: r.score,
        text: r.content,
        metadata: r.metadata,
      }));
    },
  };
}

/**
 * Build a default SearchOrchestrator wired to real backends when env vars are present.
 *
 * Priority:
 *   1. CHROMA_URL set  → ChromaSearchStrategy as primary
 *   2. DATABASE_URL set → PgFullTextStrategy as secondary (or primary if no Chroma)
 *   3. Neither set      → MockSearchStrategy × 2 for local dev
 *
 * You can override by passing explicit strategies.
 */
export function createDefaultOrchestrator(strategies?: SearchStrategy[]): SearchOrchestrator {
  if (strategies && strategies.length > 0) {
    return new SearchOrchestrator({ chain: new StrategyChain({ strategies }) });
  }

  const resolved: SearchStrategy[] = [];

  if (process.env.CHROMA_URL) {
    const chroma = new ChromaSearchStrategy();
    resolved.push(chroma);
    // Hybrid strategy: vector from Chroma + BM25 RRF fusion
    resolved.push(new HybridSearchStrategy(chromaAsVectorAdapter(chroma)));
  }

  if (process.env.DATABASE_URL) {
    resolved.push(new PgFullTextStrategy());
  }

  if (resolved.length === 0) {
    // Neither configured — use mock strategies for local dev / CI
    resolved.push(new MockSearchStrategy("chroma"), new MockSearchStrategy("sqlite"));
  }

  return new SearchOrchestrator({ chain: new StrategyChain({ strategies: resolved }) });
}

// ── SearxNGSearchStrategy ─────────────────────────────────────────────────────
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

/** SearchStrategy adapter wrapping SearxNG for use in StrategyChain. */
export class SearxNGSearchStrategy implements SearchStrategy {
  readonly name = "mock" as SearchSource; // reuse "mock" slot; override if needed
  private opts: SearxNGOptions;

  constructor(opts: SearxNGOptions = {}) {
    this.opts = opts;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const start = Date.now();
    const { results } = await searchSearxNG(req.query, this.opts);
    const mapped: SearchResult[] = results.slice(0, req.maxResults ?? 10).map((r, i) => ({
      id: `searxng-${i}`,
      content: r.content ?? r.title,
      source: "mock" as SearchSource,
      type: "document" as SearchResultType,
      score: 1 - i * 0.05,
      timestamp: new Date().toISOString(),
      metadata: { url: r.url, title: r.title, author: r.author },
    }));
    return {
      results: mapped,
      source: "mock",
      durationMs: Date.now() - start,
      totalFound: results.length,
    };
  }
}
// ── ExaSearchStrategy (§1.3) ───────────────────────────────────────────────
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

/** SearchStrategy adapter wrapping Exa for use in StrategyChain. */
export class ExaSearchStrategy implements SearchStrategy {
  readonly name = "exa" as SearchSource;
  private opts: ExaOptions;

  constructor(opts: ExaOptions = {}) {
    this.opts = opts;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const start = Date.now();
    const results = await searchExa(req.query, this.opts);
    const mapped = results.slice(0, req.maxResults ?? 10);
    return {
      results: mapped,
      source: "exa",
      durationMs: Date.now() - start,
      totalFound: results.length,
    };
  }
}

// ── BraveSearchStrategy (§1.3) ─────────────────────────────────────────────
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

/** SearchStrategy adapter wrapping Brave for use in StrategyChain. */
export class BraveSearchStrategy implements SearchStrategy {
  readonly name = "brave" as SearchSource;
  private opts: BraveOptions;

  constructor(opts: BraveOptions = {}) {
    this.opts = opts;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const start = Date.now();
    const results = await searchBrave(req.query, this.opts);
    const mapped = results.slice(0, req.maxResults ?? 10);
    return {
      results: mapped,
      source: "brave",
      durationMs: Date.now() - start,
      totalFound: results.length,
    };
  }
}

// ── SerperSearchStrategy (§1.3) ────────────────────────────────────────────
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

/** SearchStrategy adapter wrapping Serper for use in StrategyChain. */
export class SerperSearchStrategy implements SearchStrategy {
  readonly name = "serper" as SearchSource;
  private opts: SerperOptions;

  constructor(opts: SerperOptions = {}) {
    this.opts = opts;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const start = Date.now();
    const results = await searchSerper(req.query, this.opts);
    const mapped = results.slice(0, req.maxResults ?? 10);
    return {
      results: mapped,
      source: "serper",
      durationMs: Date.now() - start,
      totalFound: results.length,
    };
  }
}
