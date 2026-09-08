// SPDX-License-Identifier: Apache-2.0
/**
 * §16.6 split — aviation / climate / conflict adapters.
 * (AviationFeed · ClimateFeed · ConflictFeed + ACLED auth helper)
 */
import {
  buildMockResponse,
  daysAgo,
  safeFetch,
  FeedAdapter,
  FeedAdapterOptions,
  FeedEvent,
} from "../base.js";
import type { AviationEvent, ClimateEvent, ConflictEvent } from "../index.js";

// ── Aviation — OpenSky Network (no key required) ───────────────────────────────

export class AviationFeed extends FeedAdapter<AviationEvent> {
  readonly domain = "aviation";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://opensky-network.org", ...opts });
  }

  async fetch(): Promise<AviationEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    try {
      const raw = await this.http(`${this.baseUrl}/aviation/events`, this.buildHeaders());
      // Accept a direct AviationEvent array (used by tests / custom APIs)
      if (Array.isArray(raw)) {
        return raw.length === 0 ? (raw as AviationEvent[]) : (raw as AviationEvent[]);
      }
      // Fall back: try OpenSky { states: unknown[][] } format
      const states = (raw as { states?: unknown[][] } | null)?.states ?? [];
      if (!Array.isArray(states) || states.length === 0) {
        return buildMockResponse<AviationEvent>("aviation");
      }
      return (states as unknown[][]).slice(0, 50).map((s, i) => ({
        id: `opensky-${String(s[0] ?? i)}`,
        timestamp: new Date().toISOString(),
        severity: "low" as const,
        source: "opensky",
        summary: `Flight ${String(s[1] ?? "UNKNOWN").trim() || "UNKNOWN"} from ${String(s[2] ?? "?")}`,
        flightNumber: String(s[1] ?? "").trim() || undefined,
        alertType: "notam" as const,
        metadata: {
          icao24: s[0],
          origin_country: s[2],
          lon: s[5],
          lat: s[6],
          altitude: s[7],
          velocity: s[9],
        },
      }));
    } catch {
      return buildMockResponse<AviationEvent>("aviation");
    }
  }
}

// ── Climate — NOAA NCEI ────────────────────────────────────────────────────────

export class ClimateFeed extends FeedAdapter<ClimateEvent> {
  readonly domain = "climate";

  constructor(opts: Partial<FeedAdapterOptions> = {}) {
    super({ baseUrl: "https://www.ncdc.noaa.gov/cdo-web/api/v2", ...opts });
  }

  async fetch(): Promise<ClimateEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    if (!this.apiKey) return buildMockResponse<ClimateEvent>("climate");
    try {
      const raw = (await this.http(
        `${this.baseUrl}/data?datasetid=GHCND&datatypeid=TMAX&limit=10&startdate=${daysAgo(2)}&enddate=${daysAgo(0)}`,
        { ...this.buildHeaders(), token: this.apiKey },
      )) as { results?: Record<string, unknown>[] };
      return (raw?.results ?? []).map((r, i) => ({
        id: `noaa-${String(r.station ?? i)}-${String(r.date ?? i)}`,
        timestamp: String(r.date ?? new Date().toISOString()),
        severity: "low" as const,
        source: "noaa",
        summary: `TMAX ${r.value}°C at ${r.station}`,
        eventType: "temperature_anomaly" as const,
        location: String(r.station ?? "Unknown"),
        magnitude: Number(r.value ?? 0) / 10,
        unit: "°C",
      }));
    } catch {
      return buildMockResponse<ClimateEvent>("climate");
    }
  }
}

// ── Conflict — ACLED (email + password auth, dual strategy) ───────────────────

interface AcledSession {
  cookies: string | null;
  token: string | null;
  method: "cookie" | "oauth" | null;
  expires: number;
}

let _acledSession: AcledSession = { cookies: null, token: null, method: null, expires: 0 };

async function acledAuthenticate(email: string, password: string): Promise<AcledSession> {
  if (_acledSession.method && Date.now() < _acledSession.expires) return _acledSession;

  // Try OAuth first
  try {
    const body = new URLSearchParams({
      username: email,
      password,
      grant_type: "password",
      client_id: "acled",
    });
    const res = await fetch("https://acleddata.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { access_token?: string };
      if (data.access_token) {
        _acledSession = {
          cookies: null,
          token: data.access_token,
          method: "oauth",
          expires: Date.now() + 23 * 3600_000,
        };
        return _acledSession;
      }
    }
  } catch {
    /* fall through */
  }

  // Cookie fallback
  try {
    const res = await fetch("https://acleddata.com/user/login?_format=json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: email, pass: password }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const setCookies =
      (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const cookieStr = setCookies.map((c) => c.split(";")[0]).join("; ");
    if (cookieStr) {
      _acledSession = {
        cookies: cookieStr,
        token: null,
        method: "cookie",
        expires: Date.now() + 12 * 3600_000,
      };
      return _acledSession;
    }
  } catch {
    /* fall through */
  }

  return { cookies: null, token: null, method: null, expires: 0 };
}

export class ConflictFeed extends FeedAdapter<ConflictEvent> {
  readonly domain = "conflict";
  private email: string;
  private password: string;

  constructor(opts: Partial<FeedAdapterOptions> & { email?: string; password?: string } = {}) {
    super({ baseUrl: "https://acleddata.com", ...opts });
    this.email = opts.email ?? process.env["ACLED_EMAIL"] ?? "";
    this.password = opts.password ?? process.env["ACLED_PASSWORD"] ?? "";
  }

  async fetch(opts?: { days?: number }): Promise<ConflictEvent[]> {
    if (!this.checkRateLimit()) throw new Error("Rate limit exceeded");
    if (!this.email || !this.password) return buildMockResponse<ConflictEvent>("conflict");

    const days = (opts?.days as number | undefined) ?? 7;
    const session = await acledAuthenticate(this.email, this.password);
    if (!session.method) return buildMockResponse<ConflictEvent>("conflict");

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (session.method === "oauth" && session.token)
      headers["Authorization"] = `Bearer ${session.token}`;
    if (session.method === "cookie" && session.cookies) headers["Cookie"] = session.cookies;

    const params = new URLSearchParams({
      _format: "json",
      limit: "500",
      event_date: `${daysAgo(days)}|${daysAgo(0)}`,
      event_date_where: "BETWEEN",
    });

    try {
      const raw = (await safeFetch(`${this.baseUrl}/api/acled/read?${params}`, {
        headers,
        timeout: 25_000,
      })) as {
        data?: Record<string, unknown>[];
      };
      return (raw?.data ?? []).map((e, i) => ({
        id: String(e["data_id"] ?? `acled-${i}`),
        timestamp: String(e["timestamp"] ?? new Date().toISOString()),
        severity: this._severity(Number(e["fatalities"] ?? 0)),
        source: "acled",
        summary: String(e["notes"] ?? `${e["event_type"]} in ${e["country"]}`).slice(0, 200),
        region: String(e["region"] ?? "Unknown"),
        eventType: this._eventType(String(e["event_type"] ?? "")),
        fatalities: Number(e["fatalities"] ?? 0),
        metadata: {
          country: e["country"],
          location: e["location"],
          lat: e["latitude"],
          lon: e["longitude"],
        },
      }));
    } catch {
      return buildMockResponse<ConflictEvent>("conflict");
    }
  }

  private _severity(fatalities: number): FeedEvent["severity"] {
    if (fatalities > 50) return "critical";
    if (fatalities > 10) return "high";
    if (fatalities > 0) return "medium";
    return "low";
  }

  private _eventType(raw: string): ConflictEvent["eventType"] {
    const r = raw.toLowerCase();
    if (r.includes("displace")) return "displacement";
    if (r.includes("ceasefire")) return "ceasefire";
    if (r.includes("airstr") || r.includes("explosion")) return "airstrikes";
    if (r.includes("humanitarian")) return "humanitarian";
    return "clashes";
  }
}

