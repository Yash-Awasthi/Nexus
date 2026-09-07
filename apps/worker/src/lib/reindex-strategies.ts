// SPDX-License-Identifier: Apache-2.0
/**
 * reindex-strategies — env → strategy selection for the worker's search:reindex
 * job (pass 73).
 *
 * The job previously ran a permanent MockSearchStrategy stub. Selection is
 * extracted here as a small pure function of an injected env so the wiring is
 * testable offline (construction only — nothing here performs a search or
 * connects): when a Chroma endpoint is configured the real Chroma strategy
 * plus the hybrid RRF-fusion strategy (vector from Chroma + in-process BM25)
 * run, when DATABASE_URL is set the Postgres full-text strategy over
 * memory_entries runs, and with neither configured a single mock fallback
 * keeps offline/default behavior exactly as it was. Ordering follows
 * @nexus/search-orchestrator's documented priority (Chroma/hybrid first,
 * Postgres second).
 *
 * The package is lazy-loaded (dynamic import) because its module pulls in the
 * Neon client at import time; this module only statically imports the type.
 */
import type { SearchStrategy } from "@nexus/search-orchestrator";

export interface ReindexEnv {
  /** Chroma endpoint (CHROMA_URL). When set → chroma + hybrid strategies. */
  chromaUrl?: string;
  /** Chroma collection name override (CHROMA_COLLECTION). */
  chromaCollection?: string;
  /** Neon/Postgres URL (DATABASE_URL). When set → Pg full-text strategy. */
  databaseUrl?: string;
}

/** Select the search strategies for a reindex run from an injected env. */
export async function loadReindexStrategies(env: ReindexEnv): Promise<SearchStrategy[]> {
  const {
    ChromaSearchStrategy,
    HybridSearchStrategy,
    MockSearchStrategy,
    PgFullTextStrategy,
    chromaAsVectorAdapter,
  } = await import("@nexus/search-orchestrator");

  const resolved: SearchStrategy[] = [];
  if (env.chromaUrl) {
    const chroma = new ChromaSearchStrategy({
      chromaUrl: env.chromaUrl,
      ...(env.chromaCollection ? { collection: env.chromaCollection } : {}),
    });
    resolved.push(chroma, new HybridSearchStrategy(chromaAsVectorAdapter(chroma)));
  }
  if (env.databaseUrl) {
    resolved.push(new PgFullTextStrategy(env.databaseUrl));
  }
  if (resolved.length === 0) {
    // Neither backend configured — mock fallback (the pre-pass default).
    resolved.push(new MockSearchStrategy("mock"));
  }
  return resolved;
}
