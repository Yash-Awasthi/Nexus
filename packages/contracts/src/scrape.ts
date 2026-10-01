// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/contracts — scraping types
 *
 * Shared request/response shapes for nexus-ingest ↔ @nexus/api communication.
 * These types are the source of truth; the OpenAPI schema is generated from them.
 */

// ── Scrape sources ─────────────────────────────────────────────────────────────

export const SCRAPE_SOURCES = [
  "bloomberg",
  "reuters",
  "edgar",
  "yahoo",
  "cnbc",
  "ft",
  "benzinga",
  "google_news",
  "google_serp",
  "investingcom",
  "marketwatch",
  "rss",
  "seekingalpha",
] as const;

export type ScrapeSource = (typeof SCRAPE_SOURCES)[number];

// ── Requests ───────────────────────────────────────────────────────────────────

export interface ScrapeRequest {
  source: ScrapeSource;
  /** Maximum number of articles to return (default: 20) */
  maxArticles?: number;
  /** Only include articles newer than this many hours (default: 2) */
  maxAgeHours?: number;
}

export interface BatchScrapeRequest {
  sources: ScrapeSource[];
  maxArticles?: number;
  maxAgeHours?: number;
}

// ── Article output ─────────────────────────────────────────────────────────────

export interface ArticleOut {
  url: string;
  title: string;
  text: string;
  source: string;
  publishedAt: string | null;
  ageHours: number | null;
  rawTickers: string[];
}

// ── Financial event output ─────────────────────────────────────────────────────

export type Verdict = "INVEST" | "OBSERVE" | "CAUTIOUS" | "PULL_OUT";

export type EventType =
  | "earnings"
  | "guidance"
  | "price_target_change"
  | "analyst_upgrade"
  | "analyst_downgrade"
  | "merger_acquisition"
  | "regulatory_decision"
  | "product_launch"
  | "management_change"
  | "market_movement"
  | "investment_activity"
  | "geopolitical_event"
  | "bankrupt"
  | "ipo"
  | "other";

export interface FinEventOut {
  subject: string;
  eventType: EventType;
  tickers: string[];
  impactDirection: "positive" | "negative" | "mixed" | "neutral";
  signalScore: number;
  confidence: number;
  verdict: Verdict;
  heuristicImpact: number;
  divergenceFlag: boolean;
  sources: string[];
  articles: string[];
  timestamp: string;
  reasoning: string;
  magnitude: "low" | "medium" | "high";
  novelty: "breaking" | "standard" | "follow_up" | "rehash";
  actionability: "low" | "medium" | "high";
  affectedEntities: string[];
  secondOrderEffects: string[];
  sectorImpact: string;
  keyMetrics: Record<string, unknown>;
}

// ── Responses ─────────────────────────────────────────────────────────────────

export interface ScrapeResponse {
  source: ScrapeSource;
  articles: ArticleOut[];
  events: FinEventOut[];
  durationMs: number;
  scrapedAt: string;
}

export interface BatchScrapeResponse {
  results: ScrapeResponse[];
  totalArticles: number;
  totalEvents: number;
  durationMs: number;
  scrapedAt: string;
}

// ── Ingested event (pushed to @nexus/api) ─────────────────────────────────────

export interface IngestedEvent {
  id: string;
  source: ScrapeSource;
  event: FinEventOut;
  ingestedAt: string;
}
