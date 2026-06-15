// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/federated-connectors — Federated search across multiple connector instances.
 *
 * Design
 * ──────
 *   SearchableConnector        — minimal interface any searchable connector must implement
 *   FederatedConnectorRegistry — register connectors, run federated searches concurrently
 *   FederatedSearchResult      — merged, deduped, sorted output with per-source error info
 *   NullSearchConnector        — test stub that returns pre-configured results
 *
 * Dedup strategies
 * ────────────────
 *   "id"    — exact match on result.id (default)
 *   "title" — case-insensitive trimmed title match
 *   "url"   — exact URL match, falls back to id when result.url is absent
 *
 * Usage
 * ─────
 * ```ts
 * import { FederatedConnectorRegistry } from "@nexus/federated-connectors";
 *
 * const fed = new FederatedConnectorRegistry();
 * fed.register(githubConnector);
 * fed.register(slackConnector);
 *
 * const result = await fed.search({ query: "authentication bug", limit: 20 });
 * console.log(result.results);   // merged, deduped, score-sorted
 * console.log(result.errors);    // per-source failures
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  /** Stable unique identifier within the source system. */
  id: string;
  /** Human-readable title or subject. */
  title: string;
  /** Short excerpt or preview of the document. */
  excerpt: string;
  /** Source connector id (populated automatically by the registry). */
  source: string;
  /** Optional canonical URL. */
  url?: string;
  /** Relevance score in [0, 1] — used for cross-source sort. */
  score?: number;
  /** Arbitrary source-specific metadata. */
  metadata?: Record<string, unknown>;
}

/** Searchable connector interface definition. */
export interface SearchableConnector {
  /** Unique identifier for this connector instance. */
  id: string;
  search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
}

/** Dedup strategy type alias. */
export type DedupStrategy = "id" | "title" | "url";

/** Federated search options interface definition. */
export interface FederatedSearchOptions {
  query: string;
  /** Maximum results after dedup + sort. Default 10. */
  limit?: number;
  /** Deduplication strategy. Default "id". */
  dedupBy?: DedupStrategy;
  /** Per-connector search timeout in ms. Default 5 000. */
  timeoutMs?: number;
}

/** Connector error interface definition. */
export interface ConnectorError {
  source: string;
  error: string;
}

/** Federated search result interface definition. */
export interface FederatedSearchResult {
  results: SearchResult[];
  /** Connector ids that returned results successfully. */
  sources: string[];
  /** Total result count before dedup and limit slicing. */
  totalBeforeDedup: number;
  durationMs: number;
  errors: ConnectorError[];
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class FederatedConnectorRegistry {
  private readonly connectors = new Map<string, SearchableConnector>();

  register(connector: SearchableConnector): void {
    this.connectors.set(connector.id, connector);
  }

  unregister(id: string): boolean {
    return this.connectors.delete(id);
  }

  has(id: string): boolean {
    return this.connectors.has(id);
  }

  listIds(): string[] {
    return [...this.connectors.keys()];
  }

  /**
   * Run the same query against all registered connectors concurrently.
   * Per-connector failures are captured in result.errors rather than thrown.
   */
  async search(opts: FederatedSearchOptions): Promise<FederatedSearchResult> {
    const { query, limit = 10, dedupBy = "id", timeoutMs = 5_000 } = opts;
    const connectors = [...this.connectors.values()];
    const start = Date.now();

    const settled = await Promise.allSettled(
      connectors.map((c) =>
        Promise.race<SearchResult[]>([
          c.search(query, { limit }).then((results) =>
            results.map((r) => ({ ...r, source: c.id })),
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Connector "${c.id}" timed out after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]),
      ),
    );

    const allResults: SearchResult[] = [];
    const errors: ConnectorError[] = [];
    const sources: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      const connector = connectors[i]!;
      if (outcome.status === "fulfilled") {
        sources.push(connector.id);
        allResults.push(...outcome.value);
      } else {
        errors.push({
          source: connector.id,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
      }
    }

    const totalBeforeDedup = allResults.length;
    const deduped = deduplicate(allResults, dedupBy);
    const sorted = deduped
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);

    return {
      results: sorted,
      sources,
      totalBeforeDedup,
      durationMs: Date.now() - start,
      errors,
    };
  }
}

// ── Dedup helper ─────────────────────────────────────────────────────────────

function deduplicate(results: SearchResult[], by: DedupStrategy): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    let key: string;
    switch (by) {
      case "title":
        key = r.title.toLowerCase().trim();
        break;
      case "url":
        key = r.url ?? r.id;
        break;
      default:
        key = r.id;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Test stub ─────────────────────────────────────────────────────────────────

export interface NullSearchConnectorOptions {
  id: string;
  results?: SearchResult[];
  /** If set, search() rejects with this error message. */
  errorMessage?: string;
  /** Artificial delay before resolving, in ms. Default 0. */
  delayMs?: number;
}

/**
 * Test stub implementing SearchableConnector.
 * Returns a fixed list of results (or throws a fixed error) for any query.
 */
export class NullSearchConnector implements SearchableConnector {
  readonly id: string;
  private readonly _results: SearchResult[];
  private readonly _errorMessage?: string;
  private readonly _delayMs: number;

  constructor(opts: NullSearchConnectorOptions) {
    this.id = opts.id;
    this._results = opts.results ?? [];
    this._errorMessage = opts.errorMessage;
    this._delayMs = opts.delayMs ?? 0;
  }

  async search(_query: string, opts?: { limit?: number }): Promise<SearchResult[]> {
    if (this._delayMs > 0) {
      await new Promise((r) => setTimeout(r, this._delayMs));
    }
    if (this._errorMessage) throw new Error(this._errorMessage);
    const limit = opts?.limit ?? this._results.length;
    return this._results.slice(0, limit).map((r) => ({ ...r, source: this.id }));
  }
}
