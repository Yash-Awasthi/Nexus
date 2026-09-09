// SPDX-License-Identifier: Apache-2.0
/**
 * §16.6 split — economic / displacement / cyber / health / imagery adapters.
 * (EconomicFeed · DisplacementFeed · CyberFeed · HealthFeed · ImageryFeed)
 */
import {
  buildMockResponse,
  daysAgo,
  safeFetch,
  FeedAdapter,
  FeedAdapterOptions,
  FeedEvent,
} from "../base.js";
import type {
  CyberEvent,
  DisplacementEvent,
  EconomicEvent,
  HealthEvent,
  ImageryEvent,
} from "../index.js";

// ── Economic — FRED (Federal Reserve Economic Data) ───────────────────────────

const FRED_SERIES: Record<string, string> = {
  DFF: "Fed Funds Rate",
  DGS2: "2Y Treasury",
  DGS10: "10Y Treasury",
  T10Y2Y: "Yield Curve 10Y-2Y",
  CPIAUCSL: "CPI",
  UNRATE: "Unemployment",
  M2SL: "M2 Money Supply",
  VIXCLS: "VIX",
  BAMLH0A0HYM2: "HY Spread",
  DCOILWTICO: "WTI Crude",
  GOLDAMGBD228NLBM: "Gold",
  MORTGAGE30US: "30Y Mortgage",
};

export class EconomicFeed extends FeedAdapter<EconomicEvent> {
  readonly domain = "economic";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://api.stlouisfed.org/fred", ...opts });
    if (!this.apiKey) this.apiKey = process.env["FRED_API_KEY"];
  }

  async fetch(): Promise<EconomicEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    if (!this.apiKey) return buildMockResponse<EconomicEvent>("economic");

    const results = await Promise.allSettled(
      Object.entries(FRED_SERIES).map(async ([id, label]) => {
        const params = new URLSearchParams({
          series_id: id,
          api_key: this.apiKey!,
          file_type: "json",
          sort_order: "desc",
          limit: "5",
          observation_start: daysAgo(90),
        });
        const raw = (await safeFetch(`${this.baseUrl}/series/observations?${params}`)) as {
          observations?: { date: string; value: string }[];
        };
        const obs = (raw?.observations ?? []).filter((o) => o.value !== ".");
        const latest = obs[0];
        if (!latest) return null;
        const value = parseFloat(latest.value);
        const prev = obs[1] ? parseFloat(obs[1].value) : value;
        const changePct = prev !== 0 ? ((value - prev) / Math.abs(prev)) * 100 : 0;
        return {
          id: `fred-${id}-${latest.date}`,
          timestamp: new Date(latest.date).toISOString(),
          severity: (Math.abs(changePct) > 10
            ? "high"
            : Math.abs(changePct) > 5
              ? "medium"
              : "low") as FeedEvent["severity"],
          source: "fred",
          summary: `${label}: ${value} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`,
          indicator: id,
          value,
          unit: label,
          changePercent: changePct,
        } satisfies EconomicEvent;
      }),
    );

    const events: EconomicEvent[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) events.push(r.value);
    }
    return events.length ? events : buildMockResponse<EconomicEvent>("economic");
  }
}

// ── Displacement — ReliefWeb ───────────────────────────────────────────────────

export class DisplacementFeed extends FeedAdapter<DisplacementEvent> {
  readonly domain = "displacement";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://api.reliefweb.int/v1", ...opts });
  }

  async fetch(): Promise<DisplacementEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    try {
      const raw = (await safeFetch(
        `${this.baseUrl}/disasters?filter[field]=type&filter[value]=FL&limit=20&fields[include][]=name&fields[include][]=date&fields[include][]=country`,
      )) as { data?: { id: number; fields?: Record<string, unknown> }[] };
      return (raw?.data ?? []).map((d) => {
        const f = d.fields ?? {};
        const countries = (f["country"] as { name?: string }[] | undefined) ?? [];
        return {
          id: `reliefweb-${d.id}`,
          timestamp: String(
            (f["date"] as { created?: string } | undefined)?.created ?? new Date().toISOString(),
          ),
          severity: "high" as const,
          source: "reliefweb",
          summary: String(f["name"] ?? "Displacement event"),
          country: countries[0]?.name ?? "Unknown",
          displacedCount: 0,
          cause: "disaster" as const,
        };
      });
    } catch {
      return buildMockResponse<DisplacementEvent>("displacement");
    }
  }
}

// ── Cyber — CISA Known Exploited Vulnerabilities (no key) ─────────────────────

const CISA_KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

export class CyberFeed extends FeedAdapter<CyberEvent> {
  readonly domain = "cyber";
  private _cache: { events: CyberEvent[]; ts: number } | null = null;

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: CISA_KEV_URL, ...opts });
  }

  async fetch(opts?: { recentDays?: number }): Promise<CyberEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const recentDays = (opts?.recentDays as number | undefined) ?? 30;

    // Cache for 6 hours — CISA KEV updates infrequently
    if (this._cache && Date.now() - this._cache.ts < 6 * 3600_000) {
      return this._cache.events;
    }

    try {
      const raw = (await this.http(this.baseUrl, this.buildHeaders())) as {
        vulnerabilities?: {
          cveID: string;
          vendorProject: string;
          product: string;
          vulnerabilityName: string;
          dateAdded: string;
          dueDate: string;
          knownRansomwareCampaignUse: string;
          requiredAction: string;
          shortDescription?: string;
        }[];
      };

      const cutoff = new Date(Date.now() - recentDays * 86_400_000);
      const vulns = (raw?.vulnerabilities ?? []).filter((v) => {
        const d = new Date(v.dateAdded);
        return !isNaN(d.getTime()) && d >= cutoff;
      });

      const events: CyberEvent[] = vulns.slice(0, 100).map((v) => ({
        id: v.cveID,
        timestamp: new Date(v.dateAdded).toISOString(),
        severity: (v.knownRansomwareCampaignUse === "Known"
          ? "critical"
          : "high") as FeedEvent["severity"],
        source: "cisa-kev",
        summary: `${v.cveID}: ${v.vulnerabilityName} (${v.vendorProject} ${v.product})`,
        threatType: (v.knownRansomwareCampaignUse === "Known"
          ? "ransomware"
          : "vulnerability") as CyberEvent["threatType"],
        cveId: v.cveID,
        metadata: {
          dueDate: v.dueDate,
          requiredAction: v.requiredAction,
          ransomware: v.knownRansomwareCampaignUse,
          description: v.shortDescription,
        },
      }));

      this._cache = { events, ts: Date.now() };
      return events.length ? events : buildMockResponse<CyberEvent>("cyber");
    } catch {
      return buildMockResponse<CyberEvent>("cyber");
    }
  }
}

// ── Health — WHO / ReliefWeb disease alerts ────────────────────────────────────

export class HealthFeed extends FeedAdapter<HealthEvent> {
  readonly domain = "health";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://api.reliefweb.int/v1", ...opts });
  }

  async fetch(): Promise<HealthEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    try {
      const raw = (await safeFetch(
        `${this.baseUrl}/reports?filter[field]=primary_type&filter[value]=EP&limit=20&fields[include][]=title&fields[include][]=date&fields[include][]=country&fields[include][]=body-html`,
      )) as { data?: { id: number; fields?: Record<string, unknown> }[] };

      return (raw?.data ?? []).map((r) => {
        const f = r.fields ?? {};
        const countries = (f["country"] as { name?: string }[] | undefined) ?? [];
        const title = String(f["title"] ?? "");
        return {
          id: `reliefweb-health-${r.id}`,
          timestamp: String(
            (f["date"] as { created?: string } | undefined)?.created ?? new Date().toISOString(),
          ),
          severity: "high" as const,
          source: "reliefweb-health",
          summary: title,
          disease: this._extractDisease(title),
          region: countries[0]?.name ?? "Global",
          alertLevel: "alert" as const,
        };
      });
    } catch {
      return buildMockResponse<HealthEvent>("health");
    }
  }

  private _extractDisease(title: string): string {
    const t = title.toLowerCase();
    const known = [
      "cholera",
      "ebola",
      "mpox",
      "monkeypox",
      "dengue",
      "covid",
      "influenza",
      "plague",
      "measles",
      "polio",
    ];
    for (const d of known) if (t.includes(d)) return d;
    return "unknown";
  }
}

// ── Imagery — kept as mock (satellite APIs require significant auth) ───────────

export class ImageryFeed extends FeedAdapter<ImageryEvent> {
  readonly domain = "imagery";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://imagery.placeholder", ...opts });
  }

  async fetch(): Promise<ImageryEvent[]> {
    return buildMockResponse<ImageryEvent>("imagery");
  }
}
