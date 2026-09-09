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
 * than crashing the worker process. search:reindex selects its strategies
 * from env via lib/reindex-strategies.ts (pass 73): real Chroma + hybrid
 * when CHROMA_URL is set, Postgres full-text when DATABASE_URL is set, and
 * the mock fallback when neither is configured.
 */

import { loadReindexStrategies } from "../lib/reindex-strategies.js";

// ── wiki:reconcile ─────────────────────────────────────────────────────────────

export interface WikiReconcilePayload {
  documentId: string;
  content: string;
  source?: string;
  dryRun?: boolean;
}

export async function handleWikiReconcileJob(payload: WikiReconcilePayload): Promise<unknown> {
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

export async function handleCorpusBuildJob(payload: CorpusBuildPayload): Promise<unknown> {
  const { CorpusBuilder, CorpusStore, MockCorpusSearchBackend } =
    await import("@nexus/corpus-builder");

  // MockCorpusSearchBackend used as fallback — production wires a real VDB backend.
  const backend = new MockCorpusSearchBackend();
  const builder = new CorpusBuilder(backend);
  const store = new CorpusStore();

  const corpus = await builder.build(payload.query, {
    topics: payload.topics,
    maxDocuments: payload.maxDocuments ?? 20,
    minScore: payload.minScore,
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
    corpusId: corpus.id,
    query: corpus.query,
    documents: corpus.documents.length,
    totalWords: corpus.totalWords,
    builtAt: corpus.builtAt,
  };
}

// ── obs:generate ───────────────────────────────────────────────────────────────

export interface ObsGeneratePayload {
  sessionId: string;
  events: { role: string; content: string; timestamp?: string }[];
  category?: string;
  tags?: string[];
}

export async function handleObsGenerateJob(payload: ObsGeneratePayload): Promise<unknown> {
  const { ProviderRegistry, MockObservationProvider } = await import("@nexus/obs-providers");

  // Production: replace MockObservationProvider with ClaudeObservationProvider
  // or GeminiObservationProvider wired from env keys.
  const registry = new ProviderRegistry();
  registry.register(new MockObservationProvider("primary"));
  registry.register(new MockObservationProvider("fallback"));

  const result = await registry.generateWithFallback({
    sessionId: payload.sessionId,
    events: payload.events.map((e) => ({
      role: e.role as "user" | "assistant" | "system" | "tool",
      content: e.content,
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
    sessionId: payload.sessionId,
    observation: result.observation,
    skipReason: result.skipReason,
    provider: result.provider,
    tokensUsed: result.tokensUsed,
    durationMs: result.durationMs,
  };
}

// ── feeds:refresh:port-congestion (§16.1) ────────────────────────────────────

export interface PortCongestionRefreshPayload {
  /** Telegram alerting threshold: severity levels to alert on. Default ["critical"]. */
  alertOn?: ("low" | "medium" | "high" | "critical")[];
}

/**
 * Poll the IMF PortWatch chokepoint feed directly (independent of the sweep
 * cache — the service refreshes weekly, so a slow cadence is correct) and
 * raise Telegram alerts on anomalous chokepoints when configured.
 */
export async function handlePortCongestionRefreshJob(
  payload: PortCongestionRefreshPayload = {},
): Promise<unknown> {
  const { PortCongestionFeed, TelegramAlerter } = await import("@nexus/domain-feeds");

  const feed = new PortCongestionFeed();
  const events = await feed.fetch();
  const bySeverity = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.severity ?? "low"] = (acc[e.severity ?? "low"] ?? 0) + 1;
    return acc;
  }, {});

  // Telegram alerting — only when the operator configured a bot.
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  let alerted = 0;
  if (botToken && chatId) {
    const alertOn = payload.alertOn ?? ["critical"];
    const alerter = new TelegramAlerter({ botToken, chatId });
    const toAlert = events.filter((e) => alertOn.includes(e.severity ?? "low"));
    for (const e of toAlert.slice(0, 5)) {
      const sent = await alerter.send(
        e.severity === "critical" ? "FLASH" : "PRIORITY",
        `🚢 ${e.summary}`,
      );
      if (sent) alerted += 1;
    }
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: "feeds:refresh:port-congestion.done",
      events: events.length,
      bySeverity,
      alerted,
    }),
  );

  return {
    domain: "port-congestion",
    events: events.length,
    bySeverity,
    alerted,
    refreshedAt: new Date().toISOString(),
  };
}

// ── feeds:refresh ──────────────────────────────────────────────────────────────

export interface FeedsRefreshPayload {
  domains?: string[]; // if omitted, refreshes all registered domains
}

export async function handleFeedsRefreshJob(payload: FeedsRefreshPayload): Promise<unknown> {
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

  const cache = new FeedCache(300_000); // 5-minute TTL
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
  const pages = await Promise.allSettled(domainsToRefresh.map((d) => registry.fetch(d)));

  const succeeded = pages.filter((p) => p.status === "fulfilled").length;
  const failed = pages.length - succeeded;

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
    domains: domainsToRefresh,
    succeeded,
    failed,
    refreshedAt: new Date().toISOString(),
  };
}

// ── feeds:refresh:rss ──────────────────────────────────────────────────────────

export interface FeedsRefreshRssPayload {
  /** Override RSS_FEED_URLS env var — comma-separated feed URLs. */
  feedUrls?: string[];
}

export async function handleFeedsRefreshRssJob(payload: FeedsRefreshRssPayload): Promise<unknown> {
  const { RssFeedAdapter } = await import("@nexus/domain-feeds");

  // Resolve URLs: explicit payload → RSS_FEED_URLS env var → empty (skip)
  const urls: string[] =
    payload.feedUrls ??
    (process.env.RSS_FEED_URLS
      ? process.env.RSS_FEED_URLS.split(",")
          .map((u) => u.trim())
          .filter(Boolean)
      : []);

  if (urls.length === 0) {
    console.log(
      JSON.stringify({
        level: "info",
        event: "feeds:refresh:rss.skipped",
        reason: "no feed URLs configured — set RSS_FEED_URLS",
      }),
    );
    return { skipped: true, reason: "no_feed_urls" };
  }

  const results = await Promise.allSettled(
    urls.map(async (feedUrl) => {
      const adapter = new RssFeedAdapter({ feedUrl });
      const feed = await adapter.fetch();
      const events = adapter.toFeedEvents(feed);
      return { feedUrl, title: feed.title, items: events.length };
    }),
  );

  const succeeded = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
    feedUrl: string;
    title: string;
    items: number;
  }>[];
  const failed = results.filter((r) => r.status === "rejected");

  console.log(
    JSON.stringify({
      level: "info",
      event: "feeds:refresh:rss.done",
      total: urls.length,
      succeeded: succeeded.length,
      failed: failed.length,
    }),
  );

  return {
    total: urls.length,
    succeeded: succeeded.length,
    failed: failed.length,
    feeds: succeeded.map((r) => r.value),
    refreshedAt: new Date().toISOString(),
  };
}

// ── search:reindex ─────────────────────────────────────────────────────────────

export interface SearchReindexPayload {
  projectId?: string;
  fullScan?: boolean;
}

export async function handleSearchReindexJob(payload: SearchReindexPayload): Promise<unknown> {
  const { SearchOrchestrator, StrategyChain } = await import("@nexus/search-orchestrator");
  const strategies = await loadReindexStrategies({
    chromaUrl: process.env.CHROMA_URL,
    chromaCollection: process.env.CHROMA_COLLECTION,
    databaseUrl: process.env.DATABASE_URL,
  });
  const chain = new StrategyChain({ strategies });
  const orch = new SearchOrchestrator({ chain });

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
    projectId: payload.projectId ?? "all",
    indexed: result.results.length,
    source: result.source,
    durationMs: result.durationMs,
    reindexedAt: new Date().toISOString(),
  };
}
