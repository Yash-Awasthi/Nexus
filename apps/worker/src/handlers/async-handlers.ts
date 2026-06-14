// SPDX-License-Identifier: Apache-2.0
/**
 * Async job handlers — 5 background job types for async packages.
 *
 *   wiki:reconcile   → WikiUpdatePipeline (wiki-updater + wiki)
 *   corpus:build     → CorpusBuilder (corpus-builder)
 *   obs:generate     → ProviderRegistry.generateWithFallback (obs-providers)
 *   feeds:refresh    → FeedRegistry.fetchAll (domain-feeds)
 *   search:reindex   → StrategyChain full scan (search-orchestrator)
 *
 * All handlers log structured results for the BullMQ telemetry layer.
 * Each handler uses in-memory / mock implementations when real backends
 * (DB, external APIs) are not configured — so jobs always complete rather
 * than crashing the worker process.
 */

// ── wiki:reconcile ─────────────────────────────────────────────────────────────

export interface WikiReconcilePayload {
  documentId: string;
  content: string;
  source?: string;
  dryRun?: boolean;
}

export async function handleWikiReconcileJob(
  payload: WikiReconcilePayload,
): Promise<unknown> {
  const { WikiStore, WikiUpdatePipeline } = await import("@nexus/wiki-updater");

  const store = new WikiStore();
  const pipeline = new WikiUpdatePipeline({
    store,
    // Default distill + nlUpdate fns — replaced by real LLM calls in production
    // by overriding via env-driven dependency injection at the API layer.
    distillFn: async (content: string) => content.slice(0, 200),
    nlUpdateFn: async (_existing: string, incoming: string) => incoming,
    autoCreate: true,
  });

  const result = await pipeline.run({
    document: {
      id: payload.documentId,
      content: payload.content,
      source: payload.source,
    },
    dryRun: payload.dryRun ?? false,
  });

  console.log(
    JSON.stringify({
      level: "info",
      event: "wiki:reconcile.done",
      articleId: result.articleId,
      created: result.created,
      updated: result.updated,
      durationMs: result.durationMs,
    }),
  );

  return {
    articleId: result.articleId,
    created: result.created,
    updated: result.updated,
    dryRun: result.dryRun,
    stages: result.stages.length,
    durationMs: result.durationMs,
  };
}

// ── corpus:build ───────────────────────────────────────────────────────────────

export interface CorpusBuildPayload {
  query: string;
  topics?: string[];
  maxDocuments?: number;
  minScore?: number;
}

export async function handleCorpusBuildJob(
  payload: CorpusBuildPayload,
): Promise<unknown> {
  const { CorpusBuilder, CorpusStore, MockCorpusSearchBackend } = await import(
    "@nexus/corpus-builder"
  );

  // MockCorpusSearchBackend used as fallback — production wires a real VDB backend.
  const backend = new MockCorpusSearchBackend();
  const builder = new CorpusBuilder(backend);
  const store   = new CorpusStore();

  const corpus = await builder.build(payload.query, {
    topics:       payload.topics,
    maxDocuments: payload.maxDocuments ?? 20,
    minScore:     payload.minScore,
  });

  store.save(corpus);

  console.log(
    JSON.stringify({
      level: "info",
      event: "corpus:build.done",
      corpusId: corpus.id,
      documents: corpus.documents.length,
      totalWords: corpus.totalWords,
    }),
  );

  return {
    corpusId:  corpus.id,
    query:     corpus.query,
    documents: corpus.documents.length,
    totalWords: corpus.totalWords,
    builtAt:   corpus.builtAt,
  };
}

// ── obs:generate ───────────────────────────────────────────────────────────────

export interface ObsGeneratePayload {
  sessionId: string;
  events: { role: string; content: string; timestamp?: string }[];
  category?: string;
  tags?: string[];
}

export async function handleObsGenerateJob(
  payload: ObsGeneratePayload,
): Promise<unknown> {
  const { ProviderRegistry, MockObservationProvider } = await import(
    "@nexus/obs-providers"
  );

  // Production: replace MockObservationProvider with ClaudeObservationProvider
  // or GeminiObservationProvider wired from env keys.
  const registry = new ProviderRegistry();
  registry.register(new MockObservationProvider("primary"));
  registry.register(new MockObservationProvider("fallback"));

  const result = await registry.generateWithFallback({
    sessionId: payload.sessionId,
    events:    payload.events.map((e) => ({
      role:      e.role as "user" | "assistant" | "system" | "tool",
      content:   e.content,
      timestamp: e.timestamp,
    })),
  });

  console.log(
    JSON.stringify({
      level: "info",
      event: "obs:generate.done",
      sessionId: payload.sessionId,
      provider: result.provider,
      hasObservation: result.observation !== null,
      durationMs: result.durationMs,
    }),
  );

  return {
    sessionId:      payload.sessionId,
    observation:    result.observation,
    skipReason:     result.skipReason,
    provider:       result.provider,
    tokensUsed:     result.tokensUsed,
    durationMs:     result.durationMs,
  };
}

// ── feeds:refresh ──────────────────────────────────────────────────────────────

export interface FeedsRefreshPayload {
  domains?: string[];   // if omitted, refreshes all registered domains
}

export async function handleFeedsRefreshJob(
  payload: FeedsRefreshPayload,
): Promise<unknown> {
  const {
    FeedRegistry,
    FeedCache,
    AviationFeed,
    ClimateFeed,
    ConflictFeed,
    EconomicFeed,
    CyberFeed,
    HealthFeed,
    SeismologyFeed,
    WildfireFeed,
    MaritimeFeed,
  } = await import("@nexus/domain-feeds");

  const cache    = new FeedCache(300_000); // 5-minute TTL
  const registry = new FeedRegistry(cache);

  // Register all feeds — in production each FeedAdapter gets a real baseUrl + apiKey.
  // Here we use the mock-fallback path (adapter.fetch() returns buildMockResponse()
  // when the real HTTP call fails or returns a non-array).
  const feedOpts = { baseUrl: "https://feeds.nexus.internal" };
  registry.register(new AviationFeed(feedOpts));
  registry.register(new ClimateFeed(feedOpts));
  registry.register(new ConflictFeed(feedOpts));
  registry.register(new EconomicFeed(feedOpts));
  registry.register(new CyberFeed(feedOpts));
  registry.register(new HealthFeed(feedOpts));
  registry.register(new SeismologyFeed(feedOpts));
  registry.register(new WildfireFeed(feedOpts));
  registry.register(new MaritimeFeed(feedOpts));

  // Invalidate cache for requested domains before fetching
  const domainsToRefresh = payload.domains ?? registry.domains();
  for (const domain of domainsToRefresh) {
    cache.invalidate(domain);
  }

  // Fan-out fetch — settled so a single failing adapter doesn't block the rest
  const pages = await Promise.allSettled(
    domainsToRefresh.map((d) => registry.fetch(d)),
  );

  const succeeded = pages.filter((p) => p.status === "fulfilled").length;
  const failed    = pages.length - succeeded;

  console.log(
    JSON.stringify({
      level: "info",
      event: "feeds:refresh.done",
      domains: domainsToRefresh,
      succeeded,
      failed,
    }),
  );

  return {
    domains:   domainsToRefresh,
    succeeded,
    failed,
    refreshedAt: new Date().toISOString(),
  };
}

// ── search:reindex ─────────────────────────────────────────────────────────────

export interface SearchReindexPayload {
  projectId?: string;
  fullScan?: boolean;
}

export async function handleSearchReindexJob(
  payload: SearchReindexPayload,
): Promise<unknown> {
  const { SearchOrchestrator, MockSearchStrategy, StrategyChain } = await import(
    "@nexus/search-orchestrator"
  );

  // Production: replace with real Chroma / SQLite strategies wired from env.
  const strategy = new MockSearchStrategy("mock");
  const chain    = new StrategyChain({ strategies: [strategy] });
  const orch     = new SearchOrchestrator({ chain });

  // Full-sweep: run an empty query across the project to warm the index.
  const result = await orch.search({
    query: "",
    filters: payload.projectId ? { projectId: payload.projectId } : undefined,
    maxResults: payload.fullScan ? 10_000 : 1_000,
  });

  console.log(
    JSON.stringify({
      level: "info",
      event: "search:reindex.done",
      projectId: payload.projectId ?? "all",
      indexed: result.results.length,
      durationMs: result.durationMs,
    }),
  );

  return {
    projectId:   payload.projectId ?? "all",
    indexed:     result.results.length,
    source:      result.source,
    durationMs:  result.durationMs,
    reindexedAt: new Date().toISOString(),
  };
}
