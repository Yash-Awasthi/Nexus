// SPDX-License-Identifier: Apache-2.0
/**
 * video-search — LLM-driven video search agent.
 *
 * Provides:
 *   • VideoResult         — typed video result (id, title, url, thumbnail, duration, source)
 *   • VideoSearchRequest  — query + chatHistory + maxResults + filters
 *   • ModelFn             — injectable LLM function
 *   • VideoSearchAgent    — extracts intent, fetches candidates, ranks by relevance
 *   • VideoSearchCache    — TTL-based cache keyed by query
 *   • MockVideoBackend    — in-memory backend for testing
 *   • VideoSearchEngine   — orchestrates agent + cache + backend
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VideoResult {
  id: string;
  title: string;
  url: string;
  thumbnailUrl?: string;
  duration?: number; // seconds
  source: string;    // "youtube" | "vimeo" | "custom" | …
  description?: string;
  publishedAt?: string;
  viewCount?: number;
  relevanceScore?: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface VideoSearchRequest {
  query: string;
  chatHistory?: ChatMessage[];
  maxResults?: number;
  minDuration?: number;   // seconds
  maxDuration?: number;   // seconds
  source?: string;        // filter by source
  forceRefresh?: boolean;
}

export interface VideoSearchResponse {
  results: VideoResult[];
  refinedQuery: string;  // LLM-refined query
  totalFound: number;
  cached: boolean;
}

// ── ModelFn ───────────────────────────────────────────────────────────────────

export type ModelFn = (systemPrompt: string, userMessage: string) => Promise<string>;

// ── VideoBackend ──────────────────────────────────────────────────────────────

export interface VideoBackend {
  search(query: string, maxResults: number): Promise<VideoResult[]>;
}

export class MockVideoBackend implements VideoBackend {
  private catalog: VideoResult[];

  constructor(catalog: VideoResult[] = []) {
    this.catalog = catalog;
  }

  async search(query: string, maxResults: number): Promise<VideoResult[]> {
    const q = query.toLowerCase();
    const matched = this.catalog.filter((v) =>
      v.title.toLowerCase().includes(q) ||
      (v.description?.toLowerCase().includes(q) ?? false)
    );
    return matched.slice(0, maxResults);
  }

  addVideo(video: VideoResult): void { this.catalog.push(video); }
  clear(): void { this.catalog = []; }
  size(): number { return this.catalog.length; }
}

// ── VideoSearchCache ──────────────────────────────────────────────────────────

export class VideoSearchCache {
  private cache = new Map<string, { response: VideoSearchResponse; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) { this.ttlMs = ttlMs; }

  set(query: string, response: VideoSearchResponse): void {
    this.cache.set(query.toLowerCase(), { response, expiresAt: Date.now() + this.ttlMs });
  }

  get(query: string): VideoSearchResponse | null {
    const entry = this.cache.get(query.toLowerCase());
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.cache.delete(query.toLowerCase()); return null; }
    return { ...entry.response, cached: true };
  }

  invalidate(query: string): void { this.cache.delete(query.toLowerCase()); }
  clear(): void { this.cache.clear(); }
  size(): number { return this.cache.size; }
}

// ── IntentExtractor ───────────────────────────────────────────────────────────

export class IntentExtractor {
  private model: ModelFn;

  constructor(model: ModelFn) { this.model = model; }

  async refineQuery(request: VideoSearchRequest): Promise<string> {
    const historyCtx = request.chatHistory
      ?.slice(-4)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n") ?? "";

    const systemPrompt = `You are a video search query optimizer. Given a search query and optional conversation history, output ONLY an improved, specific search query string — no explanation, no quotes, no extra text.`;
    const userMessage = historyCtx
      ? `Conversation:\n${historyCtx}\n\nSearch query: ${request.query}`
      : `Search query: ${request.query}`;

    try {
      const refined = await this.model(systemPrompt, userMessage);
      return refined.trim() || request.query;
    } catch {
      return request.query;
    }
  }
}

// ── VideoRanker ───────────────────────────────────────────────────────────────

export class VideoRanker {
  rank(results: VideoResult[], query: string, filters: {
    minDuration?: number;
    maxDuration?: number;
    source?: string;
  } = {}): VideoResult[] {
    const terms = query.toLowerCase().split(/\s+/);

    let filtered = results.filter((v) => {
      if (filters.source && v.source !== filters.source) return false;
      if (filters.minDuration !== undefined && (v.duration ?? 0) < filters.minDuration) return false;
      if (filters.maxDuration !== undefined && (v.duration ?? Infinity) > filters.maxDuration) return false;
      return true;
    });

    return filtered
      .map((v) => {
        const text = `${v.title} ${v.description ?? ""}`.toLowerCase();
        const matchCount = terms.filter((t) => text.includes(t)).length;
        const termScore = terms.length > 0 ? matchCount / terms.length : 0;
        const popularityBoost = Math.log1p(v.viewCount ?? 0) / 20;
        return { ...v, relevanceScore: termScore * 0.7 + popularityBoost * 0.3 };
      })
      .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
  }
}

// ── VideoSearchAgent ──────────────────────────────────────────────────────────

export class VideoSearchAgent {
  private extractor: IntentExtractor;
  private ranker: VideoRanker;
  private backend: VideoBackend;

  constructor(model: ModelFn, backend: VideoBackend) {
    this.extractor = new IntentExtractor(model);
    this.ranker = new VideoRanker();
    this.backend = backend;
  }

  async search(request: VideoSearchRequest): Promise<VideoSearchResponse> {
    const maxResults = request.maxResults ?? 10;
    const refinedQuery = await this.extractor.refineQuery(request);
    const candidates = await this.backend.search(refinedQuery, maxResults * 2);
    const ranked = this.ranker.rank(candidates, refinedQuery, {
      minDuration: request.minDuration,
      maxDuration: request.maxDuration,
      source: request.source,
    });

    return {
      results: ranked.slice(0, maxResults),
      refinedQuery,
      totalFound: ranked.length,
      cached: false,
    };
  }
}

// ── VideoSearchEngine ─────────────────────────────────────────────────────────

export interface VideoSearchEngineOptions {
  model: ModelFn;
  backend: VideoBackend;
  cacheTtlMs?: number;
}

export class VideoSearchEngine {
  private agent: VideoSearchAgent;
  private cache: VideoSearchCache;

  constructor(opts: VideoSearchEngineOptions) {
    this.agent = new VideoSearchAgent(opts.model, opts.backend);
    this.cache = new VideoSearchCache(opts.cacheTtlMs);
  }

  async search(request: VideoSearchRequest): Promise<VideoSearchResponse> {
    if (!request.forceRefresh) {
      const cached = this.cache.get(request.query);
      if (cached) return cached;
    }

    const response = await this.agent.search(request);
    this.cache.set(request.query, response);
    return response;
  }

  getCache(): VideoSearchCache { return this.cache; }
}
