// SPDX-License-Identifier: Apache-2.0
/**
 * weather-feed — Open-Meteo weather adapter.
 *
 * Provides:
 *   • WeatherRequest   — lat/lng + unit (metric/imperial) + optional params
 *   • WeatherResponse  — temperature, humidity, windSpeed, weatherCode, isDay
 *   • WmoCode          — human-readable WMO weather code interpretation
 *   • WeatherCache     — TTL-based response cache per location
 *   • WeatherClient    — injectable HTTP client wrapper for Open-Meteo API
 *   • WeatherFeed      — main facade; fetch() with cache-first strategy
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type WeatherUnit = "metric" | "imperial";

/** Weather request interface definition. */
export interface WeatherRequest {
  lat: number;
  lng: number;
  unit?: WeatherUnit;
  /** Additional hourly variables (default: none) */
  hourly?: string[];
  /** Whether to include daily forecast summary (default: false) */
  daily?: boolean;
}

/** Current weather interface definition. */
export interface CurrentWeather {
  temperature: number; // °C or °F depending on unit
  windSpeed: number; // km/h or mph
  windDirection: number; // degrees
  weatherCode: number; // WMO weather code
  isDay: boolean;
  time: string; // ISO
}

/** Hourly weather interface definition. */
export interface HourlyWeather {
  time: string[];
  temperature: number[];
  relativeHumidity?: number[];
  precipitation?: number[];
}

/** Daily summary interface definition. */
export interface DailySummary {
  time: string[];
  weatherCode: number[];
  temperatureMax: number[];
  temperatureMin: number[];
  precipitationSum: number[];
}

/** Weather response interface definition. */
export interface WeatherResponse {
  lat: number;
  lng: number;
  timezone: string;
  unit: WeatherUnit;
  current: CurrentWeather;
  hourly?: HourlyWeather;
  daily?: DailySummary;
  fetchedAt: string;
}

// ── WMO weather code interpretation ──────────────────────────────────────────

export const WMO_DESCRIPTIONS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

/** Wmo code. */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WmoCode {
  static describe(code: number): string {
    return WMO_DESCRIPTIONS[code] ?? `Unknown (${code})`;
  }

  static isRain(code: number): boolean {
    return (code >= 51 && code <= 67) || (code >= 80 && code <= 82);
  }

  static isSnow(code: number): boolean {
    return (code >= 71 && code <= 77) || (code >= 85 && code <= 86);
  }

  static isThunder(code: number): boolean {
    return code >= 95 && code <= 99;
  }

  static isClear(code: number): boolean {
    return code === 0 || code === 1;
  }
}

// ── HttpGetFn ─────────────────────────────────────────────────────────────────

export type WeatherHttpGetFn = (url: string) => Promise<unknown>;

// ── Raw Open-Meteo response shape ─────────────────────────────────────────────

interface OpenMeteoCurrentWeather {
  temperature: number;
  windspeed: number;
  winddirection: number;
  weathercode: number;
  is_day: number;
  time: string;
}

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  current_weather: OpenMeteoCurrentWeather;
  hourly?: {
    time: string[];
    temperature_2m?: number[];
    relativehumidity_2m?: number[];
    precipitation?: number[];
  };
  daily?: {
    time: string[];
    weathercode?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
  };
}

// ── WeatherCache ──────────────────────────────────────────────────────────────

export class WeatherCache {
  private cache = new Map<string, { response: WeatherResponse; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlMs = 15 * 60 * 1000) {
    // 15 min default
    this.ttlMs = ttlMs;
  }

  private key(req: WeatherRequest): string {
    return `${req.lat.toFixed(2)},${req.lng.toFixed(2)},${req.unit ?? "metric"}`;
  }

  set(req: WeatherRequest, response: WeatherResponse): void {
    this.cache.set(this.key(req), { response, expiresAt: Date.now() + this.ttlMs });
  }

  get(req: WeatherRequest): WeatherResponse | null {
    const entry = this.cache.get(this.key(req));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(this.key(req));
      return null;
    }
    return entry.response;
  }

  invalidate(req: WeatherRequest): void {
    this.cache.delete(this.key(req));
  }
  clear(): void {
    this.cache.clear();
  }
  size(): number {
    return this.cache.size;
  }
}

// ── WeatherClient ─────────────────────────────────────────────────────────────

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

/** Weather client. */
export class WeatherClient {
  private http: WeatherHttpGetFn;

  constructor(http?: WeatherHttpGetFn) {
    this.http =
      http ??
      (async (url) => {
        const res = await fetch(url);
        return res.json();
      });
  }

  async fetch(req: WeatherRequest): Promise<WeatherResponse> {
    const unit = req.unit ?? "metric";
    const params = new URLSearchParams({
      latitude: String(req.lat),
      longitude: String(req.lng),
      current_weather: "true",
      temperature_unit: unit === "metric" ? "celsius" : "fahrenheit",
      windspeed_unit: unit === "metric" ? "kmh" : "mph",
    });

    if (req.hourly && req.hourly.length > 0) {
      params.set("hourly", req.hourly.join(","));
    }
    if (req.daily) {
      params.set("daily", "weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum");
      params.set("timezone", "auto");
    }

    const url = `${OPEN_METEO_BASE}?${params.toString()}`;
    const raw = (await this.http(url)) as OpenMeteoResponse;
    return this._parse(raw, unit);
  }

  private _parse(raw: OpenMeteoResponse, unit: WeatherUnit): WeatherResponse {
    const cw = raw.current_weather;
    const current: CurrentWeather = {
      temperature: cw.temperature,
      windSpeed: cw.windspeed,
      windDirection: cw.winddirection,
      weatherCode: cw.weathercode,
      isDay: cw.is_day === 1,
      time: cw.time,
    };

    const response: WeatherResponse = {
      lat: raw.latitude,
      lng: raw.longitude,
      timezone: raw.timezone,
      unit,
      current,
      fetchedAt: new Date().toISOString(),
    };

    if (raw.hourly) {
      response.hourly = {
        time: raw.hourly.time,
        temperature: raw.hourly.temperature_2m ?? [],
        relativeHumidity: raw.hourly.relativehumidity_2m,
        precipitation: raw.hourly.precipitation,
      };
    }

    if (raw.daily) {
      response.daily = {
        time: raw.daily.time,
        weatherCode: raw.daily.weathercode ?? [],
        temperatureMax: raw.daily.temperature_2m_max ?? [],
        temperatureMin: raw.daily.temperature_2m_min ?? [],
        precipitationSum: raw.daily.precipitation_sum ?? [],
      };
    }

    return response;
  }
}

// ── WeatherFeed (main facade) ─────────────────────────────────────────────────

export interface WeatherFeedOptions {
  http?: WeatherHttpGetFn;
  cacheTtlMs?: number;
}

/** Weather feed. */
export class WeatherFeed {
  private client: WeatherClient;
  private cache: WeatherCache;

  constructor(opts: WeatherFeedOptions = {}) {
    this.client = new WeatherClient(opts.http);
    this.cache = new WeatherCache(opts.cacheTtlMs);
  }

  /** Fetch weather, using cache when fresh. */
  async fetch(
    req: WeatherRequest,
    forceRefresh = false,
  ): Promise<{ response: WeatherResponse; cached: boolean }> {
    if (!forceRefresh) {
      const cached = this.cache.get(req);
      if (cached) return { response: cached, cached: true };
    }

    const response = await this.client.fetch(req);
    this.cache.set(req, response);
    return { response, cached: false };
  }

  /** Bulk fetch for multiple locations (parallel). */
  async fetchAll(
    requests: WeatherRequest[],
  ): Promise<{ response: WeatherResponse; cached: boolean }[]> {
    return Promise.all(requests.map((r) => this.fetch(r)));
  }

  getCache(): WeatherCache {
    return this.cache;
  }
}
