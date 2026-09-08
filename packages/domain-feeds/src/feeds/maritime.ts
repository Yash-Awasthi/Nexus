// SPDX-License-Identifier: Apache-2.0
/**
 * §16.6 split — maritime adapters.
 * (MaritimeFeed + mmsiFlagState/aisIncident · PortCongestionFeed +
 *  portCongestionSignal) — the §13.1 PortWatch surface lives here too.
 */
import {
  buildMockResponse,
  FeedAdapter,
  FeedAdapterOptions,
  FeedEvent,
} from "../base.js";
// PortCongestionEvent is declared in this file (it ships with the §13.1 feed).
import type { MaritimeEvent } from "../index.js";

// ── Maritime — Digitraffic AIS (Finnish Transport Agency; keyless open data) ───
// Real vessel-position feed (GeoJSON). We surface only ABNORMAL navigational
// states as incidents (aground / not-under-command / AIS-SART); the ~18k routine
// positions (under way, anchored, moored) are not events. Coverage: Finnish/
// Baltic waters. Keyless, but Digitraffic hard-requires gzip and a free-text
// Digitraffic-User identifier header (not a credential).

/** ITU-R M.1371 navigational-status codes → human label. */
const AIS_NAV_STATUS: Record<number, string> = {
  0: "under way using engine",
  1: "at anchor",
  2: "not under command",
  3: "restricted maneuverability",
  4: "constrained by draught",
  5: "moored",
  6: "aground",
  7: "engaged in fishing",
  8: "under way sailing",
  14: "AIS-SART / MOB / EPIRB active",
  15: "undefined",
};

/** navStat → (incident eventType, severity). Only genuinely abnormal states map. */
function aisIncident(
  navStat: number,
): { eventType: MaritimeEvent["eventType"]; severity: FeedEvent["severity"] } | null {
  switch (navStat) {
    case 6:
      return { eventType: "grounding", severity: "high" };
    case 14:
      return { eventType: "search_rescue", severity: "critical" };
    case 2:
      return { eventType: "search_rescue", severity: "high" }; // adrift / disabled
    default:
      return null;
  }
}

interface AisFeature {
  mmsi?: number;
  geometry?: { coordinates?: [number, number] };
  properties?: {
    navStat?: number;
    sog?: number;
    cog?: number;
    heading?: number;
    timestampExternal?: number;
  };
}

/** Vessel metadata row from Digitraffic `/api/ais/v1/vessels` (keyed by MMSI). */
interface AisVessel {
  mmsi?: number;
  name?: string;
  callSign?: string;
  imo?: number;
  shipType?: number;
  destination?: string;
}

/**
 * Maritime Identification Digits (first three MMSI digits) → flag state. Focused
 * on the Baltic/North-Sea region Digitraffic covers plus the major open-registry
 * flags; deterministic, so flag enrichment needs no network call. Unknown MIDs
 * yield `undefined` rather than a wrong guess.
 */
const MMSI_MID_FLAG: Record<number, string> = {
  201: "Albania",
  205: "Belgium",
  209: "Cyprus",
  210: "Cyprus",
  212: "Cyprus",
  211: "Germany",
  218: "Germany",
  219: "Denmark",
  220: "Denmark",
  230: "Finland",
  231: "Faroe Islands",
  232: "United Kingdom",
  233: "United Kingdom",
  234: "United Kingdom",
  235: "United Kingdom",
  236: "Gibraltar",
  237: "Greece",
  238: "Croatia",
  244: "Netherlands",
  245: "Netherlands",
  246: "Netherlands",
  247: "Italy",
  248: "Malta",
  249: "Malta",
  256: "Malta",
  250: "Ireland",
  257: "Norway",
  258: "Norway",
  259: "Norway",
  261: "Poland",
  263: "Portugal",
  265: "Sweden",
  266: "Sweden",
  271: "Turkey",
  272: "Ukraine",
  273: "Russia",
  275: "Latvia",
  276: "Estonia",
  277: "Lithuania",
  338: "United States",
  366: "United States",
  367: "United States",
  368: "United States",
  369: "United States",
  477: "Hong Kong",
  412: "China",
  413: "China",
  440: "South Korea",
  441: "South Korea",
  431: "Japan",
  432: "Japan",
  538: "Marshall Islands",
  563: "Singapore",
  564: "Singapore",
  565: "Singapore",
  566: "Singapore",
  636: "Liberia",
  637: "Liberia",
  352: "Panama",
  353: "Panama",
  354: "Panama",
  355: "Panama",
  356: "Panama",
  357: "Panama",
  370: "Panama",
  371: "Panama",
  372: "Panama",
  373: "Panama",
};

/** Derive a flag state from an MMSI's Maritime Identification Digits. */
export function mmsiFlagState(mmsi: string | number | undefined): string | undefined {
  if (mmsi === undefined) return undefined;
  const digits = String(mmsi).replace(/\D/g, "");
  if (digits.length < 3) return undefined;
  return MMSI_MID_FLAG[Number(digits.slice(0, 3))];
}

/** Options for {@link MaritimeFeed}; adds vessel-name enrichment to the base set. */
export type MaritimeFeedOptions = Partial<FeedAdapterOptions> & {
  /**
   * When true, incidents are enriched with human-readable vessel names via a
   * second Digitraffic `/vessels` fetch (joined by MMSI) plus MID-derived flag
   * states. Off by default: it costs an extra request and names are rarely
   * needed for the abnormal-state incidents this feed surfaces.
   */
  enrichVesselNames?: boolean;
};

export class MaritimeFeed extends FeedAdapter<MaritimeEvent> {
  readonly domain = "maritime";
  private readonly enrichVesselNames: boolean;

  constructor(opts: MaritimeFeedOptions = {}) {
    super({ baseUrl: "https://meri.digitraffic.fi/api/ais/v1", ...opts });
    this.enrichVesselNames = opts.enrichVesselNames ?? false;
  }

  async fetch(): Promise<MaritimeEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const url = `${this.baseUrl}/locations`;
    // Digitraffic returns 406 without gzip; identify ourselves per its fair-use
    // policy (free-text string, not a secret).
    const headers = {
      ...this.buildHeaders(),
      "Accept-Encoding": "gzip",
      "Digitraffic-User": "nexus/domain-feeds",
    };

    try {
      const raw = (await this.http(url, headers)) as { features?: AisFeature[] } | null;
      // Malformed/unexpected payload → mock fallback (shared adapter contract).
      // A well-formed FeatureCollection with no abnormal vessels stays an honest
      // empty result below.
      if (!raw || !Array.isArray(raw.features)) return buildMockResponse<MaritimeEvent>("maritime");
      const features = raw.features;
      const events: MaritimeEvent[] = [];
      for (const f of features) {
        const navStat = f.properties?.navStat;
        if (navStat === undefined) continue;
        const incident = aisIncident(navStat);
        if (!incident) continue;
        const [lon, lat] = f.geometry?.coordinates ?? [undefined, undefined];
        const ms = f.properties?.timestampExternal;
        const status = AIS_NAV_STATUS[navStat] ?? `navStat ${navStat}`;
        events.push({
          id: `ais-${f.mmsi ?? "unknown"}`,
          timestamp: ms ? new Date(ms).toISOString() : new Date().toISOString(),
          severity: incident.severity,
          source: "digitraffic",
          summary: `Vessel MMSI ${f.mmsi ?? "?"} ${status}`,
          eventType: incident.eventType,
          mmsi: f.mmsi !== undefined ? String(f.mmsi) : undefined,
          coordinates: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
          metadata: {
            navStat,
            navStatus: status,
            sog: f.properties?.sog,
            cog: f.properties?.cog,
            heading: f.properties?.heading,
          },
        });
      }
      // A successful call with no abnormal vessels is a real empty result — do
      // NOT fabricate mock data here; mock only covers a hard failure (catch).
      // Opt-in: attach human-readable vessel names + flag states (§13.2).
      if (this.enrichVesselNames && events.length > 0) await this.enrichEvents(events);
      return events;
    } catch {
      return buildMockResponse<MaritimeEvent>("maritime");
    }
  }

  /**
   * Enrich incidents in place with a MID-derived flag state (deterministic, no
   * network) and, from a second Digitraffic `/vessels` fetch joined by MMSI, the
   * vessel name / call sign / destination. Best-effort: any failure of the second
   * fetch leaves incidents with just the flag state — it never throws (so it
   * cannot trip the caller's mock fallback) and never drops an incident.
   */
  private async enrichEvents(events: MaritimeEvent[]): Promise<void> {
    for (const e of events) e.flagState = mmsiFlagState(e.mmsi) ?? e.flagState;

    try {
      const headers = {
        ...this.buildHeaders(),
        "Accept-Encoding": "gzip",
        "Digitraffic-User": "nexus/domain-feeds",
      };
      const raw = (await this.http(`${this.baseUrl}/vessels`, headers)) as AisVessel[] | null;
      if (!Array.isArray(raw)) return; // unexpected shape → keep flag-only enrichment
      const byMmsi = new Map<string, AisVessel>();
      for (const v of raw) {
        if (v.mmsi !== undefined) byMmsi.set(String(v.mmsi), v);
      }
      for (const e of events) {
        const v = e.mmsi !== undefined ? byMmsi.get(e.mmsi) : undefined;
        if (!v) continue;
        const name = v.name?.trim();
        if (name) {
          e.vesselName = name;
          // Prefer the human-readable name over the bare MMSI in the summary.
          e.summary = e.summary.replace(`MMSI ${e.mmsi ?? "?"}`, `${name} (MMSI ${e.mmsi ?? "?"})`);
        }
        e.metadata = {
          ...(e.metadata ?? {}),
          ...(v.callSign ? { callSign: v.callSign } : {}),
          ...(v.imo ? { imo: v.imo } : {}),
          ...(v.shipType !== undefined ? { shipType: v.shipType } : {}),
          ...(v.destination ? { destination: v.destination } : {}),
        };
      }
    } catch {
      // Enrichment is best-effort; incidents keep their flag state.
    }
  }
}

// ── Port congestion — IMF PortWatch (keyless ArcGIS FeatureServer) ─────────────
// Daily transit counts + capacity at maritime chokepoints (Suez, Panama, Hormuz,
// Bosphorus, …). Served from a public ArcGIS Online feature service (GET only,
// no token). Congestion ≈ transit count vs the trailing-mean `capacity` field.
// Refreshed weekly (Tue 09:00 ET). Live probe of the service is a Gate; the
// adapter itself is built against the documented response envelope and tested
// with mocked fetch against a real-shape ArcGIS payload.

export interface PortCongestionEvent extends FeedEvent {
  /** Chokepoint name, e.g. "Suez Canal". */
  chokepoint: string;
  /** IMF portid when present in the row. */
  portId?: string;
  /** Daily transit count (n_total). */
  transitCount: number;
  /** Trailing-mean capacity (capacity field). */
  capacity: number;
  /** transitCount / capacity — >1 = transits above the trailing mean. */
  congestionRatio: number;
  eventType: "congestion" | "closure" | "underutilized" | "normal";
}

export type PortCongestionOptions = Partial<FeedAdapterOptions> & {
  /** Also emit within-band (normal) rows as low-severity events. Default false. */
  includeNormal?: boolean;
  /** Max ArcGIS pages (5000 rows each) fetched per sweep. Default 4. */
  maxPages?: number;
  /** ArcGIS `where` clause. Default "1=1" (all rows). */
  where?: string;
};

const PORTWATCH_SERVICE =
  "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services/Daily_Chokepoints_Data/FeatureServer/0";

/** ArcGIS FeatureServer `query` page size (service max is 5000). */
const PORTWATCH_PAGE_SIZE = 5000;

/**
 * Derive the congestion signal from the transit-vs-capacity anomaly.
 * A ratio ≥1.02 means transits run above the trailing mean (congestion); a
 * collapse to ≤15% of a meaningful capacity (≥10 ships/day) reads as a
 * chokepoint closure (e.g. Suez blocked) — the other direction of the same
 * anomaly. Returns null for rows that are not an anomaly (caller filters).
 */
export function portCongestionSignal(
  transitCount: number,
  capacity: number,
): { eventType: PortCongestionEvent["eventType"]; severity: FeedEvent["severity"] } | null {
  if (capacity <= 0) return null; // no baseline → no signal
  const ratio = transitCount / capacity;
  if (ratio >= 1.15) return { eventType: "congestion", severity: "high" };
  if (ratio >= 1.02) return { eventType: "congestion", severity: "medium" };
  if (ratio <= 0.15 && capacity >= 10) return { eventType: "closure", severity: "critical" };
  if (ratio <= 0.5) return { eventType: "underutilized", severity: "low" };
  return { eventType: "normal", severity: "low" };
}

/** One ArcGIS `attributes` row from the Daily_Chokepoints_Data layer. */
interface PortWatchAttributes {
  ObjectId?: number;
  date?: number | string;
  year?: number;
  month?: number;
  day?: number;
  portid?: string | number;
  portname?: string;
  n_container?: number;
  n_dry_bulk?: number;
  n_general_cargo?: number;
  n_roro?: number;
  n_tanker?: number;
  n_cargo?: number;
  n_total?: number;
  capacity?: number;
  [key: string]: unknown;
}

export class PortCongestionFeed extends FeedAdapter<PortCongestionEvent> {
  readonly domain = "port-congestion";
  private readonly includeNormal: boolean;
  private readonly maxPages: number;
  private readonly where: string;

  constructor(opts: PortCongestionOptions = {}) {
    super({ baseUrl: PORTWATCH_SERVICE, ...opts });
    this.includeNormal = opts.includeNormal ?? false;
    this.maxPages = opts.maxPages ?? 4;
    this.where = opts.where ?? "1=1";
  }

  async fetch(opts?: { where?: string }): Promise<PortCongestionEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const where = opts?.where ?? this.where;

    try {
      // Count first (returnCountOnly=true), then paginate with resultOffset.
      const count = await this.queryCount(where);
      if (count <= 0) return []; // honest empty — no mock fabrication

      const events: PortCongestionEvent[] = [];
      for (let page = 0; page < this.maxPages; page++) {
        const offset = page * PORTWATCH_PAGE_SIZE;
        if (offset >= count) break;
        const raw = (await this.http(this.pageUrl(where, offset), this.buildHeaders())) as
          | { features?: { attributes?: PortWatchAttributes }[] }
          | null;
        // Malformed/unexpected payload → mock fallback (shared adapter contract).
        if (!raw || !Array.isArray(raw.features)) return buildMockResponse<PortCongestionEvent>("port-congestion");
        events.push(...this.parseFeatures(raw.features));
        if (offset + PORTWATCH_PAGE_SIZE >= count) break;
      }
      return events;
    } catch {
      return buildMockResponse<PortCongestionEvent>("port-congestion");
    }
  }

  private async queryCount(where: string): Promise<number> {
    const url = `${this.baseUrl}/query?where=${encodeURIComponent(where)}&outFields=*&f=json&returnCountOnly=true`;
    const raw = (await this.http(url, this.buildHeaders())) as { count?: number } | null;
    if (!raw || typeof raw.count !== "number") return 0;
    return raw.count;
  }

  private pageUrl(where: string, offset: number): string {
    return (
      `${this.baseUrl}/query?where=${encodeURIComponent(where)}&outFields=*&f=json` +
      `&resultOffset=${offset}&resultRecordCount=${PORTWATCH_PAGE_SIZE}`
    );
  }

  private parseFeatures(features: { attributes?: PortWatchAttributes }[]): PortCongestionEvent[] {
    const events: PortCongestionEvent[] = [];
    for (const f of features) {
      const a = f.attributes ?? {};
      const transitCount = Number(a.n_total ?? 0);
      const capacity = Number(a.capacity ?? 0);
      const signal = portCongestionSignal(transitCount, capacity);
      if (!signal) continue;
      if (signal.eventType === "normal" && !this.includeNormal) continue;

      const name = String(a.portname ?? "Unknown").trim() || "Unknown";
      const portId = a.portid !== undefined ? String(a.portid) : undefined;
      const ms = Number(a.date ?? 0);
      const date = ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
      const ratio = capacity > 0 ? transitCount / capacity : 0;

      events.push({
        id: `portcongestion-${portId ?? name}-${ms > 0 ? String(ms) : String(a.ObjectId ?? events.length)}`,
        timestamp: date,
        severity: signal.severity,
        source: "imf-portwatch",
        summary: `${name}: ${transitCount} transits vs capacity ${capacity} (${ratio.toFixed(2)}×)`,
        chokepoint: name,
        portId,
        transitCount,
        capacity,
        congestionRatio: Math.round(ratio * 100) / 100,
        eventType: signal.eventType,
        metadata: {
          objectId: a.ObjectId,
          year: a.year,
          month: a.month,
          day: a.day,
          n_container: a.n_container,
          n_dry_bulk: a.n_dry_bulk,
          n_general_cargo: a.n_general_cargo,
          n_roro: a.n_roro,
          n_tanker: a.n_tanker,
          n_cargo: a.n_cargo,
        },
      });
    }
    return events;
  }
}

