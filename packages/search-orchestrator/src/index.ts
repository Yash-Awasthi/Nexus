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

export type SearchSource = "chroma" | "sqlite" | "hybrid" | "mock";
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
      const results: SearchResult[] = rows.map((row, i) => {
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
    const chromaAsVector: VectorSearchAdapter = {
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
    resolved.push(new HybridSearchStrategy(chromaAsVector));
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
