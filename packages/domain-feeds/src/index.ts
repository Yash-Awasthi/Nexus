// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/domain-feeds — Real-world global intelligence feed adapters.
 *
 * 17 live data domains with real API implementations:
 *   aviation (OpenSky), climate (NOAA), conflict (ACLED),
 *   economic (FRED), displacement (ReliefWeb), cyber (CISA KEV),
 *   health (WHO/ReliefWeb), imagery (mock), seismology (USGS),
 *   wildfire (NASA FIRMS), maritime (AIS/mock), port-congestion (IMF PortWatch),
 *   market (Yahoo Finance), sanctions (OFAC/OpenSanctions),
 *   radiation (Safecast), space (Space-Track), patents (USPTO)
 *
 * Higher-order services:
 *   SweepOrchestrator — parallel fan-out, TTL cache, per-run snapshots
 *   DeltaEngine       — threshold-aware change detection across numeric + count metrics
 *   TelegramAlerter   — FLASH / PRIORITY / ROUTINE multi-tier alert system
 *
 * §16.6: the shared infrastructure (helpers, FeedEvent/FeedPage, FeedAdapter
 * base, FeedCache/FeedRegistry/Sweep/Delta/Telegram) lives in `./base.js` and
 * the per-domain adapters live in `./feeds/*.ts` (aviation-climate-conflict,
 * economy-displacement-cyber-health, seismo-wildfire, maritime, market-intel,
 * research-legal). This module is the barrel: domain event types + the default
 * registry + legacy services, re-exporting base and feeds — the public API is
 * unchanged.
 */

import {
  FeedAdapter,
  FeedCache,
  FeedEvent,
  FeedPage,
  FeedRegistry,
  HttpGetFn,
  DeltaEngine,
  SweepOrchestrator,
  TelegramAlerter,
} from "./base.js";
import { AviationFeed, ClimateFeed, ConflictFeed } from "./feeds/aviation-climate-conflict.js";
import {
  CyberFeed,
  DisplacementFeed,
  EconomicFeed,
  HealthFeed,
  ImageryFeed,
} from "./feeds/economy-displacement-cyber-health.js";
import { SeismologyFeed, WildfireFeed } from "./feeds/seismo-wildfire.js";
import { MaritimeFeed, PortCongestionFeed } from "./feeds/maritime.js";
import {
  MarketFeed,
  RadiationFeed,
  RedditFeed,
  SanctionsFeed,
  TechNewsFeed,
} from "./feeds/market-intel.js";
import {
  ArxivFeed,
  EdgarFeed,
  EurLexFeed,
  LegislativeFeed,
  PreprintsFeed,
} from "./feeds/research-legal.js";

export * from "./base.js";
export * from "./feeds/aviation-climate-conflict.js";
export * from "./feeds/economy-displacement-cyber-health.js";
export * from "./feeds/seismo-wildfire.js";
export * from "./feeds/maritime.js";
export * from "./feeds/market-intel.js";
export * from "./feeds/research-legal.js";

// ── Domain event types ─────────────────────────────────────────────────────────

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
  containment: number;
  cause?: string;
}

export interface MaritimeEvent extends FeedEvent {
  vesselName?: string;
  mmsi?: string;
  eventType: "piracy" | "grounding" | "collision" | "search_rescue" | "pollution" | "port_closure";
  coordinates?: { lat: number; lon: number };
  flagState?: string;
}

/** Live market quote — Yahoo Finance (no API key required). */
export interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  currency: string;
  exchange: string;
  marketState: string;
  history: { date: string; close: number }[];
}

export interface MarketEvent extends FeedEvent {
  symbol: string;
  price: number;
  changePct: number;
  marketState: string;
}

/** OFAC / CISA sanctions entry. */
export interface SanctionEvent extends FeedEvent {
  entity: string;
  program: string;
  listType: "ofac" | "cisa" | "opensanctions";
  cveId?: string;
  dueDate?: string;
  ransomwareLinked?: boolean;
}

/** Radiation monitor reading (Safecast). */
export interface RadiationEvent extends FeedEvent {
  lat: number;
  lon: number;
  cpm: number;
  usvh: number;
  deviceId?: string;
}

/** Hacker News front-page story (social / tech signals). */
export interface TechNewsEvent extends FeedEvent {
  title: string;
  url?: string;
  points: number;
  comments: number;
  author?: string;
}

/** Reddit post (social signals). */
export interface RedditEvent extends FeedEvent {
  title: string;
  url?: string;
  subreddit: string;
  score: number;
  comments: number;
  author?: string;
  permalink?: string;
}

/** bioRxiv/medRxiv preprint (scientific signals). */
export interface PreprintEvent extends FeedEvent {
  title: string;
  doi: string;
  authors?: string;
  category?: string;
  date: string;
  version?: string;
  url?: string;
  /** Journal DOI once the preprint is published, if any. */
  published?: string;
}

/** SEC EDGAR filing (regulatory signal). */
export interface FilingEvent extends FeedEvent {
  /** Form type, e.g. "8-K", "10-K", "4", "144". */
  formType: string;
  /** Filing company or person name. */
  company: string;
  /** SEC CIK number, when parseable from the entry title. */
  cik?: string;
  /** Accession number, e.g. "0001477932-26-004135". */
  accessionNumber: string;
  /** Filing date (YYYY-MM-DD), parsed from the summary. */
  filedDate?: string;
  /** URL to the filing index page. */
  url?: string;
}

/** US Congress bill / resolution (legislative signal). */
export interface LegislationEvent extends FeedEvent {
  congress: number;
  /** Bill type, e.g. "HR", "S", "HJRES". */
  billType: string;
  billNumber: string;
  title: string;
  /** Origin chamber, "House" or "Senate". */
  chamber?: string;
  /** Text of the most recent action. */
  latestAction?: string;
  /** Date (YYYY-MM-DD) of the most recent action. */
  actionDate?: string;
  /** API referrer URL for the bill. */
  url?: string;
}

/** EU legislative act (directive / regulation / decision) from EUR-Lex. */
export interface DirectiveEvent extends FeedEvent {
  /** CELEX identifier, e.g. "32026L1472". */
  celex: string;
  /** Document type derived from the CELEX descriptor: Directive / Regulation / Decision / … */
  docType: string;
  /** Full act title. */
  title: string;
  /** Authoring institution(s) (dc:creator), e.g. "European Parliament, Council…". */
  author?: string;
  /** URL to the act on EUR-Lex. */
  url?: string;
  /** Publication date (ISO), parsed from the RSS pubDate when present. */
  published?: string;
}

// ── createDefaultRegistry — wires all adapters with env-based config ───────────

export function createDefaultRegistry(): FeedRegistry {
  const cache = new FeedCache(300_000); // 5-min TTL
  const registry = new FeedRegistry(cache);

  registry
    .register(new AviationFeed())
    .register(new ClimateFeed({ apiKey: process.env["NOAA_API_KEY"] }))
    .register(new ConflictFeed())
    .register(new EconomicFeed())
    .register(new DisplacementFeed())
    .register(new CyberFeed())
    .register(new HealthFeed())
    .register(new ImageryFeed())
    .register(new SeismologyFeed())
    .register(new WildfireFeed())
    .register(new MaritimeFeed())
    .register(new PortCongestionFeed())
    .register(new MarketFeed())
    .register(new SanctionsFeed())
    .register(new RadiationFeed())
    .register(new TechNewsFeed())
    .register(new RedditFeed())
    .register(new PreprintsFeed())
    .register(new ArxivFeed())
    .register(new EdgarFeed())
    .register(new LegislativeFeed())
    .register(new EurLexFeed());

  return registry;
}

// ── RSS / OPML (preserved from original) ─────────────────────────────────────

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

export interface OPMLOutline {
  text: string;
  xmlUrl?: string;
  htmlUrl?: string;
  type?: string;
  title?: string;
}

export class OPMLParser {
  parse(xml: string): OPMLOutline[] {
    if (xml.length > 500_000) throw new Error("OPML input too large");
    const outlines: OPMLOutline[] = [];
    const re = /<outline([^>]*)(?:\/>|>[\s\S]*?<\/outline>)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const attrs = m[1] ?? "";
      const o: OPMLOutline = { text: this._attr(attrs, "text") ?? "" };
      const xmlUrl = this._attr(attrs, "xmlUrl");
      const htmlUrl = this._attr(attrs, "htmlUrl");
      const type = this._attr(attrs, "type");
      const title = this._attr(attrs, "title");
      if (xmlUrl) o.xmlUrl = xmlUrl;
      if (htmlUrl) o.htmlUrl = htmlUrl;
      if (type) o.type = type;
      if (title) o.title = title;
      outlines.push(o);
    }
    return outlines;
  }

  feedUrls(xml: string): string[] {
    return this.parse(xml)
      .filter((o) => o.xmlUrl)
      .map((o) => o.xmlUrl!);
  }

  private _attr(attrs: string, name: string): string | undefined {
    if (attrs.length > 10_000) return undefined;
    const m = attrs.match(new RegExp(`${name}="([^"]*)"`, "i"));
    return m ? m[1] : undefined;
  }
}

export class RssFeedAdapter {
  readonly feedUrl: string;
  private http: HttpGetFn;
  private maxItems: number;

  constructor(opts: { feedUrl: string; http?: HttpGetFn; maxItems?: number }) {
    this.feedUrl = opts.feedUrl;
    this.maxItems = opts.maxItems ?? 20;
    this.http =
      opts.http ??
      ((url: string) =>
        fetch(url, {
          headers: { Accept: "application/rss+xml, application/xml, text/xml, */*" },
        }).then((r) => {
          if (!r.ok) throw new Error(`RSS fetch failed: ${r.status} ${url}`);
          return r.text();
        }));
  }

  async fetch(): Promise<RssFeed> {
    const fetchedAt = new Date().toISOString();
    const raw = (await this.http(this.feedUrl)) as string;
    return this.parse(typeof raw === "string" ? raw : JSON.stringify(raw), fetchedAt);
  }

  parse(xml: string, fetchedAt = new Date().toISOString()): RssFeed {
    if (xml.length > 500_000) throw new Error("feed payload too large");
    const title = this._tag(xml, "title") ?? this.feedUrl;
    const link = this._tag(xml, "link");
    const description = this._tag(xml, "description");
    const items: RssItem[] = [];

    const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null && items.length < this.maxItems) {
      const b = m[1] ?? "";
      items.push({
        title: this._tag(b, "title") ?? "",
        link: this._tag(b, "link"),
        description: this._tag(b, "description"),
        pubDate: this._tag(b, "pubDate"),
        guid: this._tag(b, "guid"),
        author: this._tag(b, "author") ?? this._tag(b, "dc:creator"),
      });
    }

    if (!items.length) {
      const entryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
      while ((m = entryRe.exec(xml)) !== null && items.length < this.maxItems) {
        const b = m[1] ?? "";
        items.push({
          title: this._tag(b, "title") ?? "",
          link: this._attrTag(b, "link", "href"),
          description: this._tag(b, "summary") ?? this._tag(b, "content"),
          pubDate: this._tag(b, "published") ?? this._tag(b, "updated"),
          guid: this._tag(b, "id"),
          author: this._tag(b, "name"),
        });
      }
    }

    return { title, link, description, items, fetchedAt };
  }

  toFeedEvents(feed: RssFeed, domain = "rss"): FeedEvent[] {
    return feed.items.map((item, i) => ({
      id: item.guid ?? item.link ?? `${domain}-${Date.now()}-${i}`,
      timestamp: item.pubDate
        ? (() => {
            try {
              return new Date(item.pubDate!).toISOString();
            } catch {
              return feed.fetchedAt;
            }
          })()
        : feed.fetchedAt,
      source: feed.title,
      summary: item.title || (item.description?.slice(0, 120) ?? ""),
      metadata: {
        link: item.link,
        description: item.description,
        author: item.author,
        feedUrl: this.feedUrl,
      },
    }));
  }

  private _tag(xml: string, tagName: string): string | undefined {
    if (xml.length > 500_000) return undefined;
    let m = xml.match(
      new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, "i"),
    );
    if (m) return (m[1] ?? "").trim() || undefined;
    m = xml.match(new RegExp(`<${tagName}[^>]*>([^<]*)<\\/${tagName}>`, "i"));
    return m ? (m[1] ?? "").trim() || undefined : undefined;
  }

  private _attrTag(xml: string, tagName: string, attrName: string): string | undefined {
    const m = xml.match(new RegExp(`<${tagName}[^>]*${attrName}="([^"]*)"`, "i"));
    return m ? m[1] : undefined;
  }
}

// ── SecEdgarFeed — SEC EDGAR Company Filings ──────────────────────────────────
//
// SEC EDGAR public API — no auth required.
// Key endpoints extracted from OpenBB openbb_sec provider (Apache 2.0).
// User-Agent must identify you per SEC EDGAR access policy (set SEC_USER_AGENT).
//
// APIs:
//   Company tickers: https://www.sec.gov/files/company_tickers.json
//   Filings:         https://data.sec.gov/submissions/CIK{padded}.json
//   Company facts:   https://data.sec.gov/api/xbrl/companyfacts/CIK{padded}.json
//   Full-text search: https://efts.sec.gov/LATEST/search-index?q=...&forms=10-K

export interface SecTicker {
  cik: number;
  ticker: string;
  title: string;
}

export interface SecFiling {
  accessionNumber: string;
  filingDate: string;
  form: string;
  primaryDocument?: string;
  items?: string;
  size?: number;
}

export interface SecCompanyFilings {
  cik: string;
  name: string;
  sic?: string;
  sicDescription?: string;
  filings: SecFiling[];
}

export interface SecCompanyFact {
  concept: string; // e.g. "us-gaap/Assets"
  unit: string; // e.g. "USD"
  label: string;
  values: {
    end: string; // period end date ISO
    val: number;
    form: string; // 10-K, 10-Q, etc.
    accn: string;
    fy?: number;
    fp?: string;
  }[];
}

export class SecEdgarFeed {
  private baseUrl = "https://data.sec.gov";
  private secUrl = "https://www.sec.gov";
  private userAgent: string;

  constructor(opts: { userAgent?: string } = {}) {
    // SEC requires a real User-Agent identifying you: "Company Name email@domain.com"
    this.userAgent = opts.userAgent ?? process.env.SEC_USER_AGENT ?? "NexusBot nexus@example.com";
  }

  private get _headers() {
    return {
      "User-Agent": this.userAgent,
      "Accept-Encoding": "gzip, deflate",
      Accept: "application/json",
    };
  }

  private async _fetch<T>(url: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, { headers: this._headers, signal: ctrl.signal });
      if (!res.ok) throw new Error(`SEC EDGAR ${res.status}: ${url}`);
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Pad CIK to 10 digits (SEC standard). */
  private _padCik(cik: number | string): string {
    return String(Number(cik)).padStart(10, "0");
  }

  /** Resolve a ticker symbol to a CIK number. Returns null if not found. */
  async tickerToCik(ticker: string): Promise<number | null> {
    type TickerMap = Record<string, { cik_str: number; ticker: string; title: string }>;
    const data = await this._fetch<TickerMap>(`${this.secUrl}/files/company_tickers.json`);
    const upper = ticker.toUpperCase();
    for (const entry of Object.values(data)) {
      if (entry.ticker.toUpperCase() === upper) return entry.cik_str;
    }
    return null;
  }

  /** Fetch recent filings for a company by CIK or ticker symbol. */
  async getFilings(
    cikOrTicker: number | string,
    opts: { formType?: string; limit?: number } = {},
  ): Promise<SecCompanyFilings> {
    let cik: number | string = cikOrTicker;
    if (typeof cikOrTicker === "string" && !/^\d+$/.test(cikOrTicker)) {
      const resolved = await this.tickerToCik(cikOrTicker);
      if (!resolved) throw new Error(`Unknown ticker: ${cikOrTicker}`);
      cik = resolved;
    }
    const padded = this._padCik(cik);
    type RawSubmissions = {
      name: string;
      sic?: string;
      sicDescription?: string;
      filings: {
        recent: {
          accessionNumber: string[];
          filingDate: string[];
          form: string[];
          primaryDocument?: string[];
          items?: string[];
          size?: number[];
        };
      };
    };
    const raw = await this._fetch<RawSubmissions>(`${this.baseUrl}/submissions/CIK${padded}.json`);
    const recent = raw.filings.recent;
    let filings: SecFiling[] = recent.accessionNumber.map((acc, i) => ({
      accessionNumber: acc,
      filingDate: recent.filingDate[i] ?? "",
      form: recent.form[i] ?? "",
      primaryDocument: recent.primaryDocument?.[i],
      items: recent.items?.[i],
      size: recent.size?.[i],
    }));
    if (opts.formType) {
      filings = filings.filter((f) => f.form === opts.formType);
    }
    if (opts.limit) filings = filings.slice(0, opts.limit);
    return {
      cik: padded,
      name: raw.name,
      sic: raw.sic,
      sicDescription: raw.sicDescription,
      filings,
    };
  }

  /** Fetch XBRL structured company facts (balance sheet, income statement, etc). */
  async getCompanyFacts(cikOrTicker: number | string): Promise<SecCompanyFact[]> {
    let cik: number | string = cikOrTicker;
    if (typeof cikOrTicker === "string" && !/^\d+$/.test(cikOrTicker)) {
      const resolved = await this.tickerToCik(cikOrTicker);
      if (!resolved) throw new Error(`Unknown ticker: ${cikOrTicker}`);
      cik = resolved;
    }
    const padded = this._padCik(cik);
    type RawFacts = {
      facts: Record<
        string,
        Record<
          string,
          {
            label: string;
            description?: string;
            units: Record<
              string,
              { end: string; val: number; form: string; accn: string; fy?: number; fp?: string }[]
            >;
          }
        >
      >;
    };
    const raw = await this._fetch<RawFacts>(
      `${this.baseUrl}/api/xbrl/companyfacts/CIK${padded}.json`,
    );
    const results: SecCompanyFact[] = [];
    for (const [taxonomy, concepts] of Object.entries(raw.facts)) {
      for (const [name, data] of Object.entries(concepts)) {
        for (const [unit, values] of Object.entries(data.units)) {
          results.push({
            concept: `${taxonomy}/${name}`,
            unit,
            label: data.label,
            values: values.map((v) => ({
              end: v.end,
              val: v.val,
              form: v.form,
              accn: v.accn,
              fy: v.fy,
              fp: v.fp,
            })),
          });
        }
      }
    }
    return results;
  }

  /** Full-text search across SEC filings (EFTS). Returns filing metadata. */
  async searchFilings(
    query: string,
    opts: { forms?: string; limit?: number } = {},
  ): Promise<{ accessionNo: string; filingDate: string; formType: string; entityName: string }[]> {
    const params = new URLSearchParams({ q: query, dateRange: "custom" });
    if (opts.forms) params.set("forms", opts.forms);
    const url = `https://efts.sec.gov/LATEST/search-index?${params}&_source=period_of_report,file_date,form_type,entity_name`;
    type EftsResponse = { hits: { hits: { _source: Record<string, string>; _id: string }[] } };
    const data = await this._fetch<EftsResponse>(url);
    return (data.hits?.hits ?? []).slice(0, opts.limit ?? 20).map((h) => ({
      accessionNo: h._id,
      filingDate: h._source["file_date"] ?? "",
      formType: h._source["form_type"] ?? "",
      entityName: h._source["entity_name"] ?? "",
    }));
  }
}

// ── WorldBankFeed — World Bank Development Indicators ────────────────────────
//
// No auth required. Annual data — cache 24h.
// API: https://api.worldbank.org/v2/country/{iso3}/{indicator}
// Extracted from WorldMonitor (AGPL-3.0 — patterns ported to original impl).

export interface WorldBankRecord {
  countryCode: string;
  countryName: string;
  indicatorCode: string;
  indicatorName: string;
  year: number;
  value: number;
}

// Common indicator codes
export const WB_INDICATORS = {
  GDP_PPP: "NY.GDP.MKTP.PP.CD",
  GDP_GROWTH: "NY.GDP.MKTP.KD.ZG",
  INFLATION: "FP.CPI.TOTL.ZG",
  UNEMPLOYMENT: "SL.UEM.TOTL.ZS",
  INTERNET_USERS: "IT.NET.USER.ZS",
  R_AND_D_PCT_GDP: "GB.XPD.RSDV.GD.ZS",
  MILITARY_PCT_GDP: "MS.MIL.XPND.GD.ZS",
  CO2_EMISSIONS: "EN.ATM.CO2E.PC",
} as const;

export const WB_DEFAULT_COUNTRIES = [
  "USA",
  "CHN",
  "JPN",
  "DEU",
  "KOR",
  "GBR",
  "IND",
  "ISR",
  "SGP",
  "FRA",
  "CAN",
  "AUS",
  "BRA",
  "SAU",
  "TUR",
  "ZAF",
  "NGA",
];

export class WorldBankFeed {
  private baseUrl = "https://api.worldbank.org/v2";

  async fetchIndicator(
    indicatorCode: string,
    opts: { countries?: string[]; yearsBack?: number } = {},
  ): Promise<WorldBankRecord[]> {
    const countries = (opts.countries ?? WB_DEFAULT_COUNTRIES).join(";");
    const curYear = new Date().getFullYear();
    const startYear = curYear - (opts.yearsBack ?? 5);
    const url = `${this.baseUrl}/country/${countries}/indicator/${indicatorCode}?format=json&date=${startYear}:${curYear}&per_page=1000`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: ctrl.signal,
      });
      if (!res.ok) return [];
      const data = (await res.json()) as [unknown, Record<string, unknown>[]?];
      if (!Array.isArray(data) || !data[1]) return [];
      const indicatorName = (data[1][0] as any)?.indicator?.value ?? indicatorCode;
      return data[1]
        .filter((r: any) => r.countryiso3code && r.value !== null)
        .map((r: any): WorldBankRecord => ({
          countryCode: r.countryiso3code ?? r.country?.id ?? "",
          countryName: r.country?.value ?? "",
          indicatorCode,
          indicatorName,
          year: parseInt(r.date, 10) || 0,
          value: r.value,
        }));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── UnhcrDisplacementFeed — UNHCR Population Statistics ──────────────────────
//
// No auth required. Annual data — extremely slow-moving, cache 12h+.
// API: https://api.unhcr.org/population/v1/population/
// Extracted from WorldMonitor displacement module (AGPL-3.0 — original impl).

export interface UnhcrRecord {
  originIso3: string;
  originName: string;
  asylumIso3: string;
  asylumName: string;
  refugees: number;
  asylumSeekers: number;
  idps: number;
  stateless: number;
}

export class UnhcrDisplacementFeed {
  private baseUrl = "https://api.unhcr.org/population/v1/population";

  async fetchYear(year?: number): Promise<UnhcrRecord[]> {
    const y = year ?? new Date().getFullYear() - 1; // UNHCR lags ~1 year
    const limit = 10000;
    const all: UnhcrRecord[] = [];

    for (let page = 1; page <= 25; page++) {
      const url = `${this.baseUrl}/?year=${y}&limit=${limit}&page=${page}&coo_all=true&coa_all=true`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
          signal: ctrl.signal,
        });
        if (!res.ok) break;
        const data = (await res.json()) as { results?: unknown[]; next?: string };
        const items = data.results ?? [];
        if (!items.length) break;
        for (const r of items as any[]) {
          all.push({
            originIso3: r.coo_iso ?? "",
            originName: r.coo_name ?? "",
            asylumIso3: r.coa_iso ?? "",
            asylumName: r.coa_name ?? "",
            refugees: r.refugees ?? 0,
            asylumSeekers: r.asylum_seekers ?? 0,
            idps: r.idps ?? 0,
            stateless: r.stateless ?? 0,
          });
        }
        if (!data.next) break;
      } finally {
        clearTimeout(timer);
      }
    }
    return all;
  }

  /** Total displacement figures aggregated by origin country. */
  aggregateByOrigin(
    records: UnhcrRecord[],
  ): Map<string, { iso3: string; name: string; total: number }> {
    const m = new Map<string, { iso3: string; name: string; total: number }>();
    for (const r of records) {
      const k = r.originIso3;
      const existing = m.get(k) ?? { iso3: k, name: r.originName, total: 0 };
      existing.total += r.refugees + r.asylumSeekers + r.idps + r.stateless;
      m.set(k, existing);
    }
    return m;
  }
}

// ── NgaNavWarningFeed — NGA Maritime Broadcast Warnings ──────────────────────
//
// US National Geospatial-Intelligence Agency NAVAREA broadcast warnings.
// No auth required. Updates daily — cache 1h is safe.
// API: https://msi.nga.mil/api/publications/broadcast-warn
// Extracted from WorldMonitor maritime module (AGPL-3.0 — original impl).

export interface NgaNavWarning {
  id: string;
  title: string;
  text: string;
  area: string;
  issuedAt: number; // Unix ms
  authority: string;
}

export class NgaNavWarningFeed {
  private url = "https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A";

  private _parseDate(s: unknown): number {
    if (!s || typeof s !== "string") return 0;
    const m = s.match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
    if (!m) return Date.parse(s) || 0;
    const months: Record<string, number> = {
      JAN: 0,
      FEB: 1,
      MAR: 2,
      APR: 3,
      MAY: 4,
      JUN: 5,
      JUL: 6,
      AUG: 7,
      SEP: 8,
      OCT: 9,
      NOV: 10,
      DEC: 11,
    };
    const [, dd, hhmm, mon, yyyy] = m;
    return Date.UTC(
      +yyyy!,
      months[mon!.toUpperCase()] ?? 0,
      +dd!,
      +hhmm!.slice(0, 2),
      +hhmm!.slice(2, 4),
    );
  }

  async fetch(area?: string): Promise<NgaNavWarning[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(this.url, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: ctrl.signal,
      });
      if (!res.ok) return [];
      const data = (await res.json()) as unknown[] | { broadcast_warn?: unknown[] };
      const raw: any[] = Array.isArray(data) ? data : ((data as any).broadcast_warn ?? []);
      let warnings: NgaNavWarning[] = raw.map((w): NgaNavWarning => ({
        id: `${w.navArea ?? ""}-${w.msgYear ?? ""}-${w.msgNumber ?? ""}`,
        title: `NAVAREA ${w.navArea ?? ""} ${w.msgNumber ?? ""}/${w.msgYear ?? ""}`,
        text: w.text ?? "",
        area: `${w.navArea ?? ""}${w.subregion ? " " + w.subregion : ""}`,
        issuedAt: this._parseDate(w.issueDate),
        authority: w.authority ?? "",
      }));
      if (area) {
        const aLow = area.toLowerCase();
        warnings = warnings.filter(
          (w) => w.area.toLowerCase().includes(aLow) || w.text.toLowerCase().includes(aLow),
        );
      }
      return warnings;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── TET Pipeline abstraction ───────────────────────────────────────────────────
// Ported from OpenBB: Fetcher<Q, R> generic in
// openbb_platform/core/openbb_core/provider/abstract/fetcher.py
// Pattern: every data provider follows Transform → Extract → Transform:
//   transformQuery   — coerce raw caller params to a typed query object
//   extractData      — hit the upstream API; return raw payload
//   transformData    — normalize raw payload into typed domain records
// Callers use fetchData() which runs the full pipeline in one call.

/** Base type for typed domain query parameters. */
export type DomainQueryParams = Record<string, unknown>;

/** Base type for a single domain data record; extra fields are allowed. */
export type DomainDataRecord = Record<string, unknown>;

/**
 * Result wrapper that pairs data with optional metadata returned by the
 * upstream provider (rate-limit headers, pagination cursors, etc.).
 * Ported from OpenBB: AnnotatedResult<T> in
 * openbb_platform/core/openbb_core/provider/abstract/annotated_result.py
 */
export interface AnnotatedFeedResult<T> {
  result: T | null;
  metadata?: Record<string, unknown>;
}

/**
 * Abstract base class for domain feed fetchers implementing the TET pipeline.
 *
 * Subclass and implement the three abstract methods; call `fetchData()` from
 * application code to run the full Transform → Extract → Transform cycle.
 *
 * @example
 * ```ts
 * class YahooEquityFetcher extends DomainFetcher<EquityHistoricalQuery, OHLCVRecord[]> {
 *   transformQuery(p) { return { symbol: String(p.symbol).toUpperCase(), limit: p.limit ?? 30 }; }
 *   async extractData(q) { return fetchYahoo(q.symbol, q.limit); }
 *   transformData(_, raw) { return (raw as YahooBar[]).map(toOHLCV); }
 * }
 * const bars = await new YahooEquityFetcher().fetchData({ symbol: "AAPL" });
 * ```
 */
export abstract class DomainFetcher<Q extends DomainQueryParams, R> {
  /** Coerce raw caller params into a typed query object. */
  abstract transformQuery(params: Record<string, unknown>): Q;

  /** Call the upstream API and return the raw payload. */
  abstract extractData(query: Q, credentials?: Record<string, string>): Promise<unknown>;

  /** Normalize the raw payload into typed domain records. */
  abstract transformData(query: Q, data: unknown): R | AnnotatedFeedResult<R>;

  /** Run the full TET pipeline. */
  async fetchData(
    params: Record<string, unknown>,
    credentials?: Record<string, string>,
  ): Promise<R | AnnotatedFeedResult<R>> {
    const query = this.transformQuery(params);
    const raw = await this.extractData(query, credentials);
    return this.transformData(query, raw);
  }
}

/**
 * Registry of named domain feed providers.
 * Ported from OpenBB: Registry in
 * openbb_platform/core/openbb_core/provider/registry.py
 */
export class FeedProviderRegistry {
  private readonly _providers = new Map<string, DomainFetcher<DomainQueryParams, unknown>>();

  register(name: string, fetcher: DomainFetcher<DomainQueryParams, unknown>): this {
    this._providers.set(name.toLowerCase(), fetcher);
    return this;
  }

  get(name: string): DomainFetcher<DomainQueryParams, unknown> | undefined {
    return this._providers.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this._providers.has(name.toLowerCase());
  }

  names(): string[] {
    return [...this._providers.keys()];
  }

  size(): number {
    return this._providers.size;
  }
}

// ── Standard financial data interfaces ────────────────────────────────────────
// Ported from OpenBB standard models:
//   openbb_platform/core/openbb_core/provider/standard_models/equity_historical.py
//   openbb_platform/core/openbb_core/provider/standard_models/equity_quote.py
//   openbb_platform/core/openbb_core/provider/standard_models/company_news.py
// These standardize the market domain adapter outputs already present above.

/**
 * OHLCV bar — standard Open, High, Low, Close, Volume record.
 * Maps to OpenBB's EquityHistoricalData; covers equities, ETFs, crypto, futures.
 */
export interface OHLCVRecord {
  /** ISO-8601 date (`YYYY-MM-DD`) or datetime (`YYYY-MM-DDTHH:mm:ssZ`). */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Trade volume; optional for derived / synthetic series. */
  volume?: number;
  /** Volume-weighted average price for the period. */
  vwap?: number;
}

/**
 * Real-time equity quote: best bid/ask + last trade snapshot.
 * Maps to OpenBB's EquityQuoteData.
 */
export interface EquityQuoteRecord {
  symbol: string;
  /** Price of the last trade. */
  lastPrice?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  /** Previous session close. */
  prevClose?: number;
  /** Absolute change from prevClose. */
  change?: number;
  /** Change as a decimal fraction (e.g., 0.015 = 1.5%). */
  changePercent?: number;
  yearHigh?: number;
  yearLow?: number;
  exchange?: string;
  /** ISO-8601 timestamp of the last trade. */
  lastTimestamp?: string;
}

/**
 * Financial or market news article.
 * Maps to OpenBB's CompanyNewsData / WorldNewsData.
 */
export interface FinancialNewsRecord {
  title: string;
  url: string;
  /** ISO-8601 publish timestamp. */
  publishedAt: string;
  source?: string;
  /** Ticker symbols referenced by the article. */
  symbols?: string[];
  summary?: string;
  sentiment?: "positive" | "negative" | "neutral";
  images?: string[];
}

// ── Academic Research Domain Feed ─────────────────────────────────────────────
// Extracted from: thedotmack/claude-scholar agents/ + CLAUDE.md
// Supports literature review pipelines: search → collect → screen → analyse → synthesise

/** How a paper was sourced for import. */
export type PaperSourceKind = "doi" | "arxiv" | "url" | "pdf" | "manual";

/** Status of a paper import attempt into a reference manager. */
export type PaperImportStatus =
  "imported_paper" | "saved_webpage" | "duplicate" | "skipped" | "failed";

/** Academic sub-collection role within a research review project. */
export type ResearchSubCollection =
  "core_papers" | "methods" | "applications" | "baselines" | "to_read";

/** A single academic paper record. */
export interface AcademicPaper {
  /** Opaque key (e.g. Zotero item key or internal UUID). */
  key: string;
  title: string;
  authors: string[];
  /** Conference or journal name. */
  venue?: string;
  year?: number;
  doi?: string;
  arxivId?: string;
  abstract?: string;
  url?: string;
  pdfUrl?: string;
  /** Whether full text has been retrieved for deep analysis. */
  fullTextAvailable: boolean;
  /** ISO-8601 timestamp when added to the collection. */
  addedAt: string;
  /** Source used to import this paper. */
  sourceKind: PaperSourceKind;
  importStatus: PaperImportStatus;
  subCollection?: ResearchSubCollection;
  tags?: string[];
}

/** Result of a single paper import attempt. */
export interface PaperImportResult {
  paperKey?: string;
  title?: string;
  doi?: string;
  arxivId?: string;
  sourceKind: PaperSourceKind;
  status: PaperImportStatus;
  pdfAttached: boolean;
  message?: string;
}

/** A Zotero-style sub-collection inside a research project. */
export interface ResearchSubCollectionRecord {
  key: string;
  name: string;
  role: ResearchSubCollection;
  parentCollectionKey: string;
  paperKeys: string[];
}

/**
 * Top-level research collection grouping papers by topic.
 * Naming convention: Research-{Topic}-{YYYY-MM}
 */
export interface ResearchCollection {
  key: string;
  /** e.g. "Research-TransformerInterpretability-2026-06" */
  name: string;
  topic: string;
  createdAt: string;
  subCollections: ResearchSubCollectionRecord[];
  totalPapers: number;
}

/** Query parameters for an academic paper search. */
export interface PaperSearchQuery {
  keywords: string[];
  /** Venue filters e.g. ["NeurIPS", "ICML", "ICLR", "ACL", "CVPR"]. */
  venues?: string[];
  yearFrom?: number;
  yearTo?: number;
  maxResults?: number;
  /** Exclude papers already in this collection. */
  dedupeCollectionKey?: string;
}

/** A mined writing pattern entry from a paper. */
export interface WritingPatternEntry {
  /** Short name for the pattern. */
  name: string;
  /** Paper it was extracted from. */
  sourceTitle: string;
  sourceVenue?: string;
  sourceYear?: number;
  /** When to apply this pattern. */
  useWhen: string;
  patterns: string[];
  /** Section applicability: intro / methods / results / rebuttal. */
  applicableSections?: Array<"intro" | "methods" | "results" | "rebuttal">;
}

/** A canonical writing memory store aggregated across mined papers. */
export interface PaperWritingMemory {
  writingPatterns: WritingPatternEntry[];
  structureSignals: WritingPatternEntry[];
  reusablePhrasing: WritingPatternEntry[];
  venueSpecificSignals: WritingPatternEntry[];
  sourceIndex: { title: string; venue?: string; year?: number; key: string }[];
  lastUpdatedAt: string;
}

/** A full literature review output produced by the review pipeline. */
export interface LiteratureReviewOutput {
  collectionKey: string;
  topic: string;
  generatedAt: string;
  paperCount: number;
  /** Thematic groups: each group has a label and list of paper keys. */
  thematicGroups: { label: string; paperKeys: string[] }[];
  researchGaps: string[];
  researchTrends: string[];
  /** Path to the generated literature-review.md if written to disk. */
  markdownPath?: string;
  /** Path to the generated references.bib if exported. */
  bibTexPath?: string;
}

/**
 * Build the standard research collection name.
 * e.g. buildCollectionName("TransformerInterpretability") → "Research-TransformerInterpretability-2026-06"
 */
export function buildCollectionName(topic: string, date?: Date): string {
  const d = date ?? new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const slug = topic.replace(/\s+/g, "");
  return `Research-${slug}-${yyyy}-${mm}`;
}

/** Default sub-collection structure for a research project. */
export const DEFAULT_SUB_COLLECTIONS: ResearchSubCollection[] = [
  "core_papers",
  "methods",
  "applications",
  "baselines",
  "to_read",
];

/** Human-readable labels for sub-collection roles. */
export const SUB_COLLECTION_LABELS: Record<ResearchSubCollection, string> = {
  core_papers: "Core Papers",
  methods: "Methods",
  applications: "Applications",
  baselines: "Baselines",
  to_read: "To-Read",
};

/**
 * Token-overlap deduplication check (title-based).
 * Returns true if two titles are likely the same paper (ratio > 0.8).
 */
export function titlesAreDuplicate(a: string, b: string): boolean {
  const normalise = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean);
  const setA = new Set(normalise(a));
  const setB = new Set(normalise(b));
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 && intersection / union > 0.8;
}
