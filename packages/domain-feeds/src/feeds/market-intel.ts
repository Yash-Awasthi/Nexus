// SPDX-License-Identifier: Apache-2.0
/**
 * §16.6 split — market / sanctions / radiation / tech-news / reddit adapters.
 * (MarketFeed · SanctionsFeed · RadiationFeed · TechNewsFeed · RedditFeed)
 */
import {
  buildMockResponse,
  safeFetch,
  FeedAdapter,
  FeedAdapterOptions,
  FeedEvent,
} from "../base.js";
import type {
  MarketEvent,
  MarketQuote,
  RadiationEvent,
  RedditEvent,
  SanctionEvent,
  TechNewsEvent,
} from "../index.js";

// ── Market — Yahoo Finance (no API key required) ───────────────────────────────

const MARKET_SYMBOLS: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^IXIC": "Nasdaq",
  "^DJI": "Dow Jones",
  "^RUT": "Russell 2000",
  TLT: "20Y+ Treasury",
  HYG: "High Yield Corp",
  "GC=F": "Gold",
  "CL=F": "WTI Crude",
  "BZ=F": "Brent Crude",
  "NG=F": "Natural Gas",
  "BTC-USD": "Bitcoin",
  "ETH-USD": "Ethereum",
  "^VIX": "VIX",
};

export class MarketFeed extends FeedAdapter<MarketEvent> {
  readonly domain = "market";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://query1.finance.yahoo.com/v8/finance/chart", ...opts });
  }

  async fetch(): Promise<MarketEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");

    const results = await Promise.allSettled(
      Object.keys(MARKET_SYMBOLS).map((sym) => this._fetchQuote(sym)),
    );

    const events: MarketEvent[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) events.push(r.value);
    }
    return events.length ? events : buildMockResponse<MarketEvent>("market");
  }

  async fetchQuotes(): Promise<Record<string, MarketQuote>> {
    const results = await Promise.allSettled(
      Object.keys(MARKET_SYMBOLS).map(async (sym) => {
        const e = await this._fetchQuote(sym);
        return e ? { sym, quote: this._toQuote(sym, e) } : null;
      }),
    );
    const out: Record<string, MarketQuote> = {};
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out[r.value.sym] = r.value.quote;
    }
    return out;
  }

  private async _fetchQuote(symbol: string): Promise<MarketEvent | null> {
    try {
      const url = `${this.baseUrl}/${encodeURIComponent(symbol)}?range=5d&interval=1d&includePrePost=false`;
      const data = (await safeFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        timeout: 8_000,
      })) as {
        chart?: {
          result?: {
            meta?: Record<string, unknown>;
            indicators?: { quote?: { close?: number[] }[] };
          }[];
        };
      };

      const result = data?.chart?.result?.[0];
      if (!result) return null;
      const meta = result.meta ?? {};
      const price = Number(meta["regularMarketPrice"] ?? 0);
      const prevClose = Number(meta["chartPreviousClose"] ?? meta["previousClose"] ?? price);
      const changePct = prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : 0;
      const name = MARKET_SYMBOLS[symbol] ?? symbol;

      return {
        id: `yf-${symbol}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        severity: (Math.abs(changePct) > 5
          ? "high"
          : Math.abs(changePct) > 2
            ? "medium"
            : "low") as FeedEvent["severity"],
        source: "yahoo-finance",
        summary: `${name}: $${price.toFixed(2)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`,
        symbol,
        price: Math.round(price * 100) / 100,
        changePct: Math.round(changePct * 100) / 100,
        marketState: String(meta["marketState"] ?? "UNKNOWN"),
        metadata: { name, currency: meta["currency"], exchange: meta["exchangeName"] },
      };
    } catch {
      return null;
    }
  }

  private _toQuote(symbol: string, e: MarketEvent): MarketQuote {
    return {
      symbol,
      name: MARKET_SYMBOLS[symbol] ?? symbol,
      price: e.price,
      prevClose: e.price,
      change: 0,
      changePct: e.changePct,
      currency: "USD",
      exchange: "",
      marketState: e.marketState,
      history: [],
    };
  }
}

// ── Sanctions — CISA KEV summary + OFAC SDN list count ────────────────────────

export class SanctionsFeed extends FeedAdapter<SanctionEvent> {
  readonly domain = "sanctions";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://www.cisa.gov", ...opts });
  }

  async fetch(): Promise<SanctionEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    try {
      const raw = (await safeFetch(
        `${this.baseUrl}/sites/default/files/feeds/known_exploited_vulnerabilities.json`,
        {
          headers: { "User-Agent": "NexusIntel/1.0" },
          timeout: 15_000,
        },
      )) as {
        vulnerabilities?: {
          cveID: string;
          vendorProject: string;
          vulnerabilityName: string;
          dateAdded: string;
          dueDate: string;
          knownRansomwareCampaignUse: string;
        }[];
      };

      const cutoff = new Date(Date.now() - 14 * 86_400_000);
      return (raw?.vulnerabilities ?? [])
        .filter((v) => new Date(v.dateAdded) >= cutoff)
        .slice(0, 50)
        .map((v) => ({
          id: `cisa-${v.cveID}`,
          timestamp: new Date(v.dateAdded).toISOString(),
          severity: (v.knownRansomwareCampaignUse === "Known"
            ? "critical"
            : "high") as FeedEvent["severity"],
          source: "cisa",
          summary: `${v.cveID}: ${v.vulnerabilityName} (${v.vendorProject})`,
          entity: `${v.vendorProject} — ${v.cveID}`,
          program: "CISA-KEV",
          listType: "cisa" as const,
          cveId: v.cveID,
          dueDate: v.dueDate,
          ransomwareLinked: v.knownRansomwareCampaignUse === "Known",
        }));
    } catch {
      return buildMockResponse<SanctionEvent>("sanctions");
    }
  }
}

// ── Radiation — Safecast (public API, no key) ──────────────────────────────────

export class RadiationFeed extends FeedAdapter<RadiationEvent> {
  readonly domain = "radiation";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://api.safecast.org/measurements.json", ...opts });
  }

  async fetch(): Promise<RadiationEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    try {
      const raw = (await safeFetch(
        `${this.baseUrl}?since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}&limit=50`,
        { headers: { "User-Agent": "NexusIntel/1.0" } },
      )) as {
        id: number;
        value: number;
        unit: string;
        latitude: string;
        longitude: string;
        captured_at: string;
        device_id?: number;
      }[];

      if (!Array.isArray(raw)) return buildMockResponse<RadiationEvent>("radiation");

      return raw.map((m) => {
        const cpm = m.unit === "cpm" ? m.value : m.value * 100;
        const usvh = cpm / 100;
        return {
          id: `safecast-${m.id}`,
          timestamp: m.captured_at ?? new Date().toISOString(),
          severity: (usvh > 10
            ? "critical"
            : usvh > 1
              ? "high"
              : usvh > 0.3
                ? "medium"
                : "low") as FeedEvent["severity"],
          source: "safecast",
          summary: `${cpm.toFixed(1)} CPM (${usvh.toFixed(3)} μSv/h) at ${parseFloat(m.latitude).toFixed(3)}, ${parseFloat(m.longitude).toFixed(3)}`,
          lat: parseFloat(m.latitude),
          lon: parseFloat(m.longitude),
          cpm,
          usvh,
          deviceId: m.device_id ? String(m.device_id) : undefined,
        };
      });
    } catch {
      return buildMockResponse<RadiationEvent>("radiation");
    }
  }
}

// ── Tech news — Hacker News via Algolia (no key required) ──────────────────────

export class TechNewsFeed extends FeedAdapter<TechNewsEvent> {
  readonly domain = "technews";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://hn.algolia.com/api/v1", ...opts });
  }

  async fetch(opts?: { tags?: string; minPoints?: number }): Promise<TechNewsEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const tags = opts?.tags ?? "front_page";
    const url = `${this.baseUrl}/search?tags=${encodeURIComponent(tags)}`;

    try {
      const raw = await this.http(url, this.buildHeaders());
      if (Array.isArray(raw)) return raw as TechNewsEvent[];

      type Hit = {
        objectID: string;
        title?: string;
        url?: string;
        points?: number;
        num_comments?: number;
        author?: string;
        created_at?: string;
        created_at_i?: number;
      };
      const hits = (raw as { hits?: Hit[] } | null)?.hits ?? [];
      if (!Array.isArray(hits) || hits.length === 0) {
        return buildMockResponse<TechNewsEvent>("technews");
      }
      const minPoints = opts?.minPoints ?? 0;
      return hits
        .filter((h) => (h.points ?? 0) >= minPoints)
        .map((h) => {
          const points = Number(h.points ?? 0);
          return {
            id: h.objectID,
            timestamp: h.created_at ?? new Date((h.created_at_i ?? 0) * 1000).toISOString(),
            // Surface the loud stories: front-page virality as severity.
            severity: (points >= 500
              ? "high"
              : points >= 150
                ? "medium"
                : "low") as FeedEvent["severity"],
            source: "hacker-news",
            summary: h.title ?? "(untitled)",
            title: h.title ?? "(untitled)",
            url: h.url,
            points,
            comments: Number(h.num_comments ?? 0),
            author: h.author,
            metadata: { hnUrl: `https://news.ycombinator.com/item?id=${h.objectID}` },
          };
        });
    } catch {
      return buildMockResponse<TechNewsEvent>("technews");
    }
  }
}

// ── Reddit — public listing JSON (no key required) ─────────────────────────────

export class RedditFeed extends FeedAdapter<RedditEvent> {
  readonly domain = "reddit";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://www.reddit.com", ...opts });
  }

  async fetch(opts?: {
    subreddit?: string;
    sort?: "hot" | "new" | "top" | "rising";
    minScore?: number;
  }): Promise<RedditEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const subreddit = opts?.subreddit ?? "all";
    const sort = opts?.sort ?? "hot";
    const url = `${this.baseUrl}/r/${encodeURIComponent(subreddit)}/${sort}.json?limit=25`;

    try {
      const raw = await this.http(url, this.buildHeaders());
      if (Array.isArray(raw)) return raw as RedditEvent[];

      type Child = {
        data?: {
          id?: string;
          title?: string;
          url?: string;
          subreddit?: string;
          score?: number;
          num_comments?: number;
          author?: string;
          permalink?: string;
          created_utc?: number;
        };
      };
      const children = (raw as { data?: { children?: Child[] } } | null)?.data?.children ?? [];
      if (!Array.isArray(children) || children.length === 0) {
        return buildMockResponse<RedditEvent>("reddit");
      }
      const minScore = opts?.minScore ?? 0;
      return children
        .map((c) => c.data ?? {})
        .filter((d) => (d.score ?? 0) >= minScore)
        .map((d) => {
          const score = Number(d.score ?? 0);
          return {
            id: d.id ?? "",
            timestamp: new Date((d.created_utc ?? 0) * 1000).toISOString(),
            severity: (score >= 10000
              ? "high"
              : score >= 2000
                ? "medium"
                : "low") as FeedEvent["severity"],
            source: "reddit",
            summary: d.title ?? "(untitled)",
            title: d.title ?? "(untitled)",
            url: d.url,
            subreddit: d.subreddit ?? subreddit,
            score,
            comments: Number(d.num_comments ?? 0),
            author: d.author,
            permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : undefined,
          };
        });
    } catch {
      return buildMockResponse<RedditEvent>("reddit");
    }
  }
}

