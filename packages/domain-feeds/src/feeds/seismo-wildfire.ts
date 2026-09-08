// SPDX-License-Identifier: Apache-2.0
/**
 * §16.6 split — seismology / wildfire adapters.
 * (SeismologyFeed · WildfireFeed)
 */
import {
  buildMockResponse,
  safeFetch,
  FeedAdapter,
  FeedAdapterOptions,
  FeedEvent,
} from "../base.js";
import type { SeismologyEvent, WildfireEvent } from "../index.js";

// ── Seismology — USGS (no key required) ───────────────────────────────────────

export class SeismologyFeed extends FeedAdapter<SeismologyEvent> {
  readonly domain = "seismology";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://earthquake.usgs.gov", ...opts });
  }

  async fetch(opts?: { minMagnitude?: number }): Promise<SeismologyEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    const min = opts?.minMagnitude;
    // Build URL — append minMagnitude as query param when provided
    let url = `${this.baseUrl}/earthquakes/feed/v1.0/summary`;
    if (min !== undefined) url += `?minMagnitude=${min}`;

    try {
      const raw = await this.http(url, this.buildHeaders());
      // Accept a direct SeismologyEvent array
      if (Array.isArray(raw)) {
        return raw as SeismologyEvent[];
      }
      // Handle USGS GeoJSON format { features: [...] }
      type USGSFeature = {
        id: string;
        properties: Record<string, unknown>;
        geometry: { coordinates: number[] };
      };
      const features = (raw as { features?: USGSFeature[] } | null)?.features ?? [];
      if (!Array.isArray(features) || features.length === 0) {
        return buildMockResponse<SeismologyEvent>("seismology");
      }
      return features.map((f) => {
        const p = f.properties;
        const [lon, lat, depth] = f.geometry.coordinates;
        const mag = Number(p["mag"] ?? 0);
        return {
          id: f.id,
          timestamp: new Date(Number(p["time"] ?? Date.now())).toISOString(),
          severity: (mag >= 7
            ? "critical"
            : mag >= 6
              ? "high"
              : mag >= 5
                ? "medium"
                : "low") as FeedEvent["severity"],
          source: "usgs",
          summary: `M${mag.toFixed(1)} — ${String(p["place"] ?? "Unknown")}`,
          magnitude: mag,
          depth: Number(depth ?? 0),
          coordinates: { lat: Number(lat ?? 0), lon: Number(lon ?? 0) },
          region: String(p["place"] ?? "Unknown"),
          tsunamiWarning: Number(p["tsunami"] ?? 0) === 1,
          metadata: { felt: p["felt"], alert: p["alert"], url: p["url"] },
        };
      });
    } catch {
      return buildMockResponse<SeismologyEvent>("seismology");
    }
  }
}

// ── Wildfire — NASA FIRMS (API key: FIRMS_MAP_KEY) ─────────────────────────────

export class WildfireFeed extends FeedAdapter<WildfireEvent> {
  readonly domain = "wildfire";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://firms.modaps.eosdis.nasa.gov/api/area/csv", ...opts });
    if (!this.apiKey) this.apiKey = process.env["FIRMS_MAP_KEY"];
  }

  async fetch(): Promise<WildfireEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    if (!this.apiKey) return buildMockResponse<WildfireEvent>("wildfire");

    try {
      const url = `${this.baseUrl}/${this.apiKey}/VIIRS_SNPP_NRT/-180,-90,180,90/1`;
      const csv = (await safeFetch(url, { headers: { "User-Agent": "NexusIntel/1.0" } })) as string;
      if (typeof csv !== "string") return buildMockResponse<WildfireEvent>("wildfire");

      const lines = csv.trim().split("\n");
      const headers = lines[0]?.split(",") ?? [];
      const events: WildfireEvent[] = [];

      for (const line of lines.slice(1, 101)) {
        const vals = line.split(",");
        const row: Record<string, string> = {};
        headers.forEach((h, i) => {
          row[h.trim()] = vals[i]?.trim() ?? "";
        });

        const lat = parseFloat(row["latitude"] ?? "0");
        const lon = parseFloat(row["longitude"] ?? "0");
        const frp = parseFloat(row["frp"] ?? "0");
        const brightness = parseFloat(row["bright_ti4"] ?? row["bright_t31"] ?? "300");

        events.push({
          id: `firms-${row["acq_date"]}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
          timestamp: `${row["acq_date"]}T${(row["acq_time"] ?? "0000").replace(/(\d{2})(\d{2})/, "$1:$2")}:00Z`,
          severity: (frp > 500
            ? "critical"
            : frp > 100
              ? "high"
              : frp > 10
                ? "medium"
                : "low") as FeedEvent["severity"],
          source: "nasa-firms",
          summary: `Thermal anomaly at ${lat.toFixed(2)}, ${lon.toFixed(2)} — FRP ${frp.toFixed(0)} MW`,
          name: undefined,
          state: row["satellite"] ?? "VIIRS",
          country: "Global",
          acresBurned: 0,
          containment: 0,
          metadata: {
            lat,
            lon,
            frp,
            brightness,
            satellite: row["satellite"],
            confidence: row["confidence"],
          },
        });
      }

      return events.length ? events : buildMockResponse<WildfireEvent>("wildfire");
    } catch {
      return buildMockResponse<WildfireEvent>("wildfire");
    }
  }
}

