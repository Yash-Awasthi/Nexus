// SPDX-License-Identifier: Apache-2.0
/**
 * search-orchestrator — Strategy-chain search with timeline output.
 *
 * Provides:
 *   • SearchStrategy      — injectable strategy interface (Chroma/SQLite/Hybrid)
 *   • SearchResult        — typed result with source + score
 *   • SearchFilters       — date/project/type filters
 *   • StrategyChain       — ordered fallback chain (first non-empty result wins)
 *   • TimelineBuilder     — groups results into dated timeline segments
 *   • SearchOrchestrator  — facade: filters → chain → timeline
 *   • MockSearchStrategy  — configurable in-memory test double
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SearchSource = "chroma" | "sqlite" | "hybrid" | "mock";
export type SearchResultType = "document" | "message" | "code" | "event" | "note";

export interface SearchResult {
  id: string;
  content: string;
  source: SearchSource;
  type: SearchResultType;
  score: number;          // 0–1
  timestamp: string;      // ISO-8601
  projectId?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchFilters {
  projectId?: string;
  types?: SearchResultType[];
  after?: string;   // ISO-8601 lower bound
  before?: string;  // ISO-8601 upper bound
  minScore?: number;
}

export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
  maxResults?: number;
}

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

  strategies_(): SearchStrategy[] { return this.strategies; }
}

// ── TimelineBuilder ───────────────────────────────────────────────────────────

export interface TimelineSegment {
  date: string;            // YYYY-MM-DD
  results: SearchResult[];
}

export interface Timeline {
  segments: TimelineSegment[];
  totalResults: number;
}

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
    const filtered = request.filters
      ? applyFilters(response.results, request.filters)
      : response.results;
    const sliced = filtered.slice(0, req.maxResults);
    return { ...response, results: sliced, totalFound: filtered.length };
  }

  /** Run search and return a timeline view. */
  async searchTimeline(request: SearchRequest): Promise<Timeline> {
    const response = await this.search(request);
    return this.timelineBuilder.build(response.results);
  }

  getChain(): StrategyChain { return this.chain; }
  getTimelineBuilder(): TimelineBuilder { return this.timelineBuilder; }
}

// ── Convenience factory ───────────────────────────────────────────────────────

export function createDefaultOrchestrator(
  strategies: SearchStrategy[] = [new MockSearchStrategy("chroma"), new MockSearchStrategy("sqlite")],
): SearchOrchestrator {
  const chain = new StrategyChain({ strategies });
  return new SearchOrchestrator({ chain });
}
