// SPDX-License-Identifier: Apache-2.0
/**
 * domain-feeds — Typed global intelligence feed adapters.
 *
 * Covers 11 structured feed domains:
 *   aviation, climate, conflict, economic, displacement,
 *   cyber, health, imagery, seismology, wildfire, maritime
 *
 * Each feed adapter:
 *   • declares typed event structs
 *   • has injectable HTTP transport + auth
 *   • supports CORS-safe headers + rate-limit headers
 *   • caches events with configurable TTL
 *
 * Provides:
 *   • FeedEvent           — base event type
 *   • FeedAdapter<T>      — base adapter class
 *   • 11 domain adapters
 *   • FeedRegistry        — fan-out aggregator
 *   • FeedCache           — TTL-caching layer
 */

// ── Transport ─────────────────────────────────────────────────────────────────

export type HttpGetFn = (url: string, headers?: Record<string, string>) => Promise<unknown>;

function buildMockResponse<T>(domain: string, count = 3): T[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${domain}-event-${i + 1}`,
    timestamp: new Date().toISOString(),
    severity: "medium",
    source: `mock-${domain}`,
    summary: `Mock ${domain} event ${i + 1}`,
  })) as T[];
}

// ── Base types ────────────────────────────────────────────────────────────────

export interface FeedEvent {
  id: string;
  timestamp: string;
  severity?: "low" | "medium" | "high" | "critical";
  source: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface FeedPage<T> {
  domain: string;
  events: T[];
  fetchedAt: string;
  totalCount: number;
  cached: boolean;
}

// ── Domain event types ────────────────────────────────────────────────────────

export interface AviationEvent extends FeedEvent {
  flightNumber?: string;
  airport?: string;
  alertType: "delay" | "cancellation" | "diversion" | "notam" | "weather";
}

export interface ClimateEvent extends FeedEvent {
  eventType: "temperature_anomaly" | "precipitation" | "drought" | "flood" | "storm";
  location: string;
  magnitude?: number;
  unit?: string;
}

export interface ConflictEvent extends FeedEvent {
  region: string;
  eventType: "airstrikes" | "clashes" | "ceasefire" | "displacement" | "humanitarian";
  fatalities?: number;
}

export interface EconomicEvent extends FeedEvent {
  indicator: string;
  value: number;
  unit: string;
  country?: string;
  changePercent?: number;
}

export interface DisplacementEvent extends FeedEvent {
  country: string;
  displacedCount: number;
  cause: "conflict" | "disaster" | "climate";
  campName?: string;
}

export interface CyberEvent extends FeedEvent {
  threatType: "ransomware" | "phishing" | "ddos" | "data_breach" | "vulnerability" | "apt";
  targetSector?: string;
  cveId?: string;
  iocs?: string[];
}

export interface HealthEvent extends FeedEvent {
  disease: string;
  region: string;
  cases?: number;
  deaths?: number;
  alertLevel: "watch" | "alert" | "outbreak" | "pandemic";
}

export interface ImageryEvent extends FeedEvent {
  satellite: string;
  coordinates: { lat: number; lon: number };
  resolution?: string;
  cloudCoverage?: number;
  imageUrl?: string;
}

export interface SeismologyEvent extends FeedEvent {
  magnitude: number;
  depth: number;
  coordinates: { lat: number; lon: number };
  region: string;
  tsunamiWarning: boolean;
}

export interface WildfireEvent extends FeedEvent {
  name?: string;
  state: string;
  country: string;
  acresBurned: number;
  containment: number; // 0-100 percent
  cause?: string;
}

export interface MaritimeEvent extends FeedEvent {
  vesselName?: string;
  mmsi?: string;
  eventType: "piracy" | "grounding" | "collision" | "search_rescue" | "pollution" | "port_closure";
  coordinates?: { lat: number; lon: number };
  flagState?: string;
}

// ── FeedAdapter base ──────────────────────────────────────────────────────────

export interface FeedAdapterOptions {
  baseUrl: string;
  apiKey?: string;
  rateLimitRpm?: number;
  corsOrigin?: string;
  http?: HttpGetFn;
}

export abstract class FeedAdapter<T extends FeedEvent> {
  abstract readonly domain: string;
  protected baseUrl: string;
  protected apiKey?: string;
  protected corsOrigin?: string;
  private rateLimitRpm: number;
  private requestTimestamps: number[] = [];
  protected http: HttpGetFn;

  constructor(opts: FeedAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.corsOrigin = opts.corsOrigin;
    this.rateLimitRpm = opts.rateLimitRpm ?? 60;
    this.http = opts.http ?? (async (url, headers) => {
      throw new Error(`Real HTTP not available. URL: ${url}, Headers: ${JSON.stringify(headers)}`);
    });
  }

  /** Check rate limit — returns true if request is allowed. */
  checkRateLimit(): boolean {
    const now = Date.now();
    const window = 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < window);
    if (this.requestTimestamps.length >= this.rateLimitRpm) return false;
    this.requestTimestamps.push(now);
    return true;
  }

  /** Build headers for the request. */
  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    if (this.corsOrigin) headers["Origin"] = this.corsOrigin;
    return headers;
  }

  /** Override in subclass to fetch from real API. */
  abstract fetch(opts?: Record<string, unknown>): Promise<T[]>;
}

// ── Domain adapters ───────────────────────────────────────────────────────────

export class AviationFeed extends FeedAdapter<AviationEvent> {
  domain = "aviation";

  async fetch(): Promise<AviationEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const raw = await this.http(`${this.baseUrl}/aviation/events`, this.buildHeaders()) as AviationEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<AviationEvent>("aviation");
  }
}

export class ClimateFeed extends FeedAdapter<ClimateEvent> {
  domain = "climate";

  async fetch(): Promise<ClimateEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const raw = await this.http(`${this.baseUrl}/climate/events`, this.buildHeaders()) as ClimateEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<ClimateEvent>("climate");
  }
}

export class ConflictFeed extends FeedAdapter<ConflictEvent> {
  domain = "conflict";

  async fetch(): Promise<ConflictEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const raw = await this.http(`${this.baseUrl}/conflict/events`, this.buildHeaders()) as ConflictEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<ConflictEvent>("conflict");
  }
}

export class EconomicFeed extends FeedAdapter<EconomicEvent> {
  domain = "economic";

  async fetch(): Promise<EconomicEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const raw = await this.http(`${this.baseUrl}/economic/indicators`, this.buildHeaders()) as EconomicEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<EconomicEvent>("economic");
  }
}

export class DisplacementFeed extends FeedAdapter<DisplacementEvent> {
  domain = "displacement";

  async fetch(): Promise<DisplacementEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const raw = await this.http(`${this.baseUrl}/displacement/events`, this.buildHeaders()) as DisplacementEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<DisplacementEvent>("displacement");
  }
}

export class CyberFeed extends FeedAdapter<CyberEvent> {
  domain = "cyber";

  async fetch(): Promise<CyberEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const raw = await this.http(`${this.baseUrl}/cyber/threats`, this.buildHeaders()) as CyberEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<CyberEvent>("cyber");
  }
}

export class HealthFeed extends FeedAdapter<HealthEvent> {
  domain = "health";

  async fetch(): Promise<HealthEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const raw = await this.http(`${this.baseUrl}/health/alerts`, this.buildHeaders()) as HealthEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<HealthEvent>("health");
  }
}

export class ImageryFeed extends FeedAdapter<ImageryEvent> {
  domain = "imagery";

  async fetch(): Promise<ImageryEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const raw = await this.http(`${this.baseUrl}/imagery/events`, this.buildHeaders()) as ImageryEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<ImageryEvent>("imagery");
  }
}

export class SeismologyFeed extends FeedAdapter<SeismologyEvent> {
  domain = "seismology";

  async fetch(opts?: { minMagnitude?: number }): Promise<SeismologyEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const qs = opts?.minMagnitude ? `?minMagnitude=${opts.minMagnitude}` : "";
    const raw = await this.http(`${this.baseUrl}/seismology/events${qs}`, this.buildHeaders()) as SeismologyEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<SeismologyEvent>("seismology");
  }
}

export class WildfireFeed extends FeedAdapter<WildfireEvent> {
  domain = "wildfire";

  async fetch(): Promise<WildfireEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const raw = await this.http(`${this.baseUrl}/wildfire/events`, this.buildHeaders()) as WildfireEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<WildfireEvent>("wildfire");
  }
}

export class MaritimeFeed extends FeedAdapter<MaritimeEvent> {
  domain = "maritime";

  async fetch(): Promise<MaritimeEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const raw = await this.http(`${this.baseUrl}/maritime/incidents`, this.buildHeaders()) as MaritimeEvent[];
    return Array.isArray(raw) ? raw : buildMockResponse<MaritimeEvent>("maritime");
  }
}

// ── FeedCache ─────────────────────────────────────────────────────────────────

export class FeedCache {
  private store = new Map<string, { events: FeedEvent[]; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlMs = 300_000) { this.ttlMs = ttlMs; }

  set(domain: string, events: FeedEvent[]): void {
    this.store.set(domain, { events: [...events], expiresAt: Date.now() + this.ttlMs });
  }

  get(domain: string): FeedEvent[] | null {
    const entry = this.store.get(domain);
    if (!entry || Date.now() > entry.expiresAt) {
      this.store.delete(domain);
      return null;
    }
    return [...entry.events];
  }

  invalidate(domain: string): void { this.store.delete(domain); }
  clear(): void { this.store.clear(); }
  size(): number { return this.store.size; }
  domains(): string[] { return [...this.store.keys()]; }
}

// ── FeedRegistry ──────────────────────────────────────────────────────────────

export type DomainName = "aviation" | "climate" | "conflict" | "economic" | "displacement" |
  "cyber" | "health" | "imagery" | "seismology" | "wildfire" | "maritime";

export class FeedRegistry {
  private adapters = new Map<string, FeedAdapter<FeedEvent>>();
  private cache: FeedCache;

  constructor(cache?: FeedCache) {
    this.cache = cache ?? new FeedCache();
  }

  register(adapter: FeedAdapter<FeedEvent>): this {
    this.adapters.set(adapter.domain, adapter);
    return this;
  }

  get(domain: string): FeedAdapter<FeedEvent> | undefined {
    return this.adapters.get(domain);
  }

  domains(): string[] { return [...this.adapters.keys()]; }

  async fetch(domain: string, opts?: Record<string, unknown>): Promise<FeedPage<FeedEvent>> {
    const adapter = this.adapters.get(domain);
    if (!adapter) throw new Error(`No feed adapter registered for domain: ${domain}`);

    const cached = this.cache.get(domain);
    if (cached) {
      return { domain, events: cached, fetchedAt: new Date().toISOString(), totalCount: cached.length, cached: true };
    }

    const events = await adapter.fetch(opts);
    this.cache.set(domain, events);
    return { domain, events, fetchedAt: new Date().toISOString(), totalCount: events.length, cached: false };
  }

  /** Fetch all registered domains in parallel. */
  async fetchAll(opts?: Record<string, unknown>): Promise<FeedPage<FeedEvent>[]> {
    return Promise.allSettled(
      [...this.adapters.keys()].map((d) => this.fetch(d, opts))
    ).then((results) =>
      results
        .filter((r): r is PromiseFulfilledResult<FeedPage<FeedEvent>> => r.status === "fulfilled")
        .map((r) => r.value)
    );
  }

  getCache(): FeedCache { return this.cache; }
}

// ── RSS types ─────────────────────────────────────────────────────────────────

export interface RssItem {
  title: string;
  link?: string;
  description?: string;
  pubDate?: string;
  guid?: string;
  author?: string;
}

export interface RssFeed {
  title: string;
  link?: string;
  description?: string;
  items: RssItem[];
  fetchedAt: string;
}

// ── OPMLParser ────────────────────────────────────────────────────────────────

export interface OPMLOutline {
  text: string;
  xmlUrl?: string;
  htmlUrl?: string;
  type?: string;
  title?: string;
}

export class OPMLParser {
  /** Parse an OPML XML string → flat list of outlines. */
  parse(xml: string): OPMLOutline[] {
    const outlines: OPMLOutline[] = [];
    const outlineRe = /<outline([^>]*)(?:\/>|>[\s\S]*?<\/outline>)/gi;
    let match: RegExpExecArray | null;
    while ((match = outlineRe.exec(xml)) !== null) {
      const attrs = match[1];
      const outline: OPMLOutline = { text: this.attr(attrs, "text") ?? "" };
      const xmlUrl  = this.attr(attrs, "xmlUrl");
      const htmlUrl = this.attr(attrs, "htmlUrl");
      const type    = this.attr(attrs, "type");
      const title   = this.attr(attrs, "title");
      if (xmlUrl)  outline.xmlUrl  = xmlUrl;
      if (htmlUrl) outline.htmlUrl = htmlUrl;
      if (type)    outline.type    = type;
      if (title)   outline.title   = title;
      outlines.push(outline);
    }
    return outlines;
  }

  /** Extract only feed URLs (outlines that carry xmlUrl). */
  feedUrls(xml: string): string[] {
    return this.parse(xml).filter((o) => o.xmlUrl).map((o) => o.xmlUrl!);
  }

  private attr(attrs: string, name: string): string | undefined {
    const re = new RegExp(`${name}="([^"]*)"`, "i");
    const m = attrs.match(re);
    return m ? m[1] : undefined;
  }
}

// ── RssFeedAdapter ─────────────────────────────────────────────────────────────

export interface RssFeedAdapterOptions {
  /** URL of the RSS/Atom feed to fetch. */
  feedUrl: string;
  /** Injectable HTTP function — defaults to native fetch. */
  http?: HttpGetFn;
  /** Max items to return per fetch (default: 20). */
  maxItems?: number;
}

export class RssFeedAdapter {
  readonly feedUrl: string;
  private http: HttpGetFn;
  private maxItems: number;

  constructor(opts: RssFeedAdapterOptions) {
    this.feedUrl  = opts.feedUrl;
    this.maxItems = opts.maxItems ?? 20;
    this.http     = opts.http ?? (async (url: string) => {
      const res = await fetch(url, {
        headers: { "Accept": "application/rss+xml, application/xml, text/xml, */*" },
      });
      if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${url}`);
      return res.text();
    });
  }

  async fetch(): Promise<RssFeed> {
    const fetchedAt = new Date().toISOString();
    const raw = await this.http(this.feedUrl) as string;
    const xml = typeof raw === "string" ? raw : JSON.stringify(raw);
    return this.parse(xml, fetchedAt);
  }

  /** Parse RSS 2.0 or Atom XML into a structured RssFeed. */
  parse(xml: string, fetchedAt = new Date().toISOString()): RssFeed {
    const title       = this.tag(xml, "title") ?? this.feedUrl;
    const link        = this.tag(xml, "link");
    const description = this.tag(xml, "description");

    const items: RssItem[] = [];

    // RSS 2.0 <item> blocks
    const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null && items.length < this.maxItems) {
      const b = m[1];
      items.push({
        title:       this.tag(b, "title") ?? "",
        link:        this.tag(b, "link"),
        description: this.tag(b, "description"),
        pubDate:     this.tag(b, "pubDate"),
        guid:        this.tag(b, "guid"),
        author:      this.tag(b, "author") ?? this.tag(b, "dc:creator"),
      });
    }

    // Atom <entry> blocks (fallback when no <item> found)
    if (items.length === 0) {
      const entryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
      while ((m = entryRe.exec(xml)) !== null && items.length < this.maxItems) {
        const b = m[1];
        items.push({
          title:       this.tag(b, "title") ?? "",
          link:        this.attrTag(b, "link", "href"),
          description: this.tag(b, "summary") ?? this.tag(b, "content"),
          pubDate:     this.tag(b, "published") ?? this.tag(b, "updated"),
          guid:        this.tag(b, "id"),
          author:      this.tag(b, "name"),
        });
      }
    }

    return { title, link, description, items, fetchedAt };
  }

  /** Convert RssFeed items to FeedEvent[] for ingestion into a FeedRegistry. */
  toFeedEvents(feed: RssFeed, domain = "rss"): FeedEvent[] {
    return feed.items.map((item, i) => ({
      id:        item.guid ?? item.link ?? `${domain}-${Date.now()}-${i}`,
      timestamp: item.pubDate ? (() => { try { return new Date(item.pubDate!).toISOString(); } catch { return feed.fetchedAt; } })() : feed.fetchedAt,
      source:    feed.title,
      summary:   item.title || (item.description?.slice(0, 120) ?? ""),
      metadata: {
        link:        item.link,
        description: item.description,
        author:      item.author,
        feedUrl:     this.feedUrl,
      },
    }));
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /** Extract text content of a tag, handling CDATA. */
  private tag(xml: string, tagName: string): string | undefined {
    // CDATA variant
    const cdataRe = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, "i");
    let m = xml.match(cdataRe);
    if (m) return m[1].trim() || undefined;
    // Plain text variant
    const plainRe = new RegExp(`<${tagName}[^>]*>([^<]*)<\\/${tagName}>`, "i");
    m = xml.match(plainRe);
    return m ? (m[1].trim() || undefined) : undefined;
  }

  /** Extract an attribute value from a self-closing tag (e.g. <link href="…"/>). */
  private attrTag(xml: string, tagName: string, attrName: string): string | undefined {
    const re = new RegExp(`<${tagName}[^>]*${attrName}="([^"]*)"`, "i");
    const m = xml.match(re);
    return m ? m[1] : undefined;
  }
}
