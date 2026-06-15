// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  WmoCode,
  WMO_DESCRIPTIONS,
  WeatherCache,
  WeatherClient,
  WeatherFeed,
  type WeatherRequest,
  type WeatherHttpGetFn,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const US_WEATHER_RAW = {
  latitude: 40.71,
  longitude: -74.0,
  timezone: "America/New_York",
  current_weather: {
    temperature: 22.5,
    windspeed: 15.0,
    winddirection: 270,
    weathercode: 0,
    is_day: 1,
    time: "2024-01-01T12:00",
  },
};

const RAIN_RAW = {
  ...US_WEATHER_RAW,
  current_weather: { ...US_WEATHER_RAW.current_weather, weathercode: 61, is_day: 0 },
};

function makeHttp(response: unknown): WeatherHttpGetFn {
  return async () => response;
}

function makeReq(overrides: Partial<WeatherRequest> = {}): WeatherRequest {
  return { lat: 40.71, lng: -74.0, ...overrides };
}

// ── WmoCode ───────────────────────────────────────────────────────────────────

describe("WmoCode", () => {
  it("describe returns human-readable description", () => {
    expect(WmoCode.describe(0)).toBe("Clear sky");
    expect(WmoCode.describe(61)).toBe("Slight rain");
    expect(WmoCode.describe(95)).toBe("Thunderstorm");
  });

  it("describe returns Unknown for unrecognised code", () => {
    expect(WmoCode.describe(999)).toContain("999");
  });

  it("isRain returns true for rain codes", () => {
    expect(WmoCode.isRain(51)).toBe(true);
    expect(WmoCode.isRain(63)).toBe(true);
    expect(WmoCode.isRain(80)).toBe(true);
    expect(WmoCode.isRain(0)).toBe(false);
  });

  it("isSnow returns true for snow codes", () => {
    expect(WmoCode.isSnow(71)).toBe(true);
    expect(WmoCode.isSnow(75)).toBe(true);
    expect(WmoCode.isSnow(85)).toBe(true);
    expect(WmoCode.isSnow(0)).toBe(false);
  });

  it("isThunder returns true for thunderstorm codes", () => {
    expect(WmoCode.isThunder(95)).toBe(true);
    expect(WmoCode.isThunder(99)).toBe(true);
    expect(WmoCode.isThunder(80)).toBe(false);
  });

  it("isClear returns true for clear sky codes", () => {
    expect(WmoCode.isClear(0)).toBe(true);
    expect(WmoCode.isClear(1)).toBe(true);
    expect(WmoCode.isClear(3)).toBe(false);
  });

  it("WMO_DESCRIPTIONS has entries", () => {
    expect(Object.keys(WMO_DESCRIPTIONS).length).toBeGreaterThan(10);
  });
});

// ── WeatherCache ──────────────────────────────────────────────────────────────

describe("WeatherCache", () => {
  it("set and get returns response", () => {
    const cache = new WeatherCache();
    const req = makeReq();
    const response = {
      lat: 40.71,
      lng: -74.0,
      timezone: "UTC",
      unit: "metric" as const,
      current: {
        temperature: 20,
        windSpeed: 10,
        windDirection: 180,
        weatherCode: 0,
        isDay: true,
        time: "t",
      },
      fetchedAt: "f",
    };
    cache.set(req, response);
    expect(cache.get(req)).not.toBeNull();
  });

  it("returns null for missing key", () => {
    const cache = new WeatherCache();
    expect(cache.get(makeReq())).toBeNull();
  });

  it("expires after TTL", async () => {
    const cache = new WeatherCache(10); // 10ms TTL
    const req = makeReq();
    cache.set(req, {
      lat: 0,
      lng: 0,
      timezone: "UTC",
      unit: "metric" as const,
      current: {
        temperature: 0,
        windSpeed: 0,
        windDirection: 0,
        weatherCode: 0,
        isDay: true,
        time: "",
      },
      fetchedAt: "",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get(req)).toBeNull();
  });

  it("keys are scoped by lat/lng/unit", () => {
    const cache = new WeatherCache();
    const stub = {
      lat: 0,
      lng: 0,
      timezone: "UTC",
      unit: "metric" as const,
      current: {
        temperature: 0,
        windSpeed: 0,
        windDirection: 0,
        weatherCode: 0,
        isDay: true,
        time: "",
      },
      fetchedAt: "",
    };
    cache.set(makeReq({ lat: 1, lng: 1 }), { ...stub, lat: 1, lng: 1 });
    cache.set(makeReq({ lat: 2, lng: 2 }), { ...stub, lat: 2, lng: 2 });
    expect(cache.size()).toBe(2);
  });

  it("invalidate removes a key", () => {
    const cache = new WeatherCache();
    const req = makeReq();
    const stub = {
      lat: 0,
      lng: 0,
      timezone: "UTC",
      unit: "metric" as const,
      current: {
        temperature: 0,
        windSpeed: 0,
        windDirection: 0,
        weatherCode: 0,
        isDay: true,
        time: "",
      },
      fetchedAt: "",
    };
    cache.set(req, stub);
    cache.invalidate(req);
    expect(cache.get(req)).toBeNull();
  });

  it("clear removes all entries", () => {
    const cache = new WeatherCache();
    const stub = {
      lat: 0,
      lng: 0,
      timezone: "UTC",
      unit: "metric" as const,
      current: {
        temperature: 0,
        windSpeed: 0,
        windDirection: 0,
        weatherCode: 0,
        isDay: true,
        time: "",
      },
      fetchedAt: "",
    };
    cache.set(makeReq({ lat: 1 }), stub);
    cache.set(makeReq({ lat: 2 }), stub);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

// ── WeatherClient ─────────────────────────────────────────────────────────────

describe("WeatherClient", () => {
  it("parses current weather fields", async () => {
    const client = new WeatherClient(makeHttp(US_WEATHER_RAW));
    const result = await client.fetch(makeReq());
    expect(result.current.temperature).toBe(22.5);
    expect(result.current.windSpeed).toBe(15.0);
    expect(result.current.weatherCode).toBe(0);
    expect(result.current.isDay).toBe(true);
    expect(result.timezone).toBe("America/New_York");
    expect(result.unit).toBe("metric");
    expect(result.lat).toBeCloseTo(40.71);
    expect(result.lng).toBeCloseTo(-74.0);
  });

  it("parses isDay=false when is_day=0", async () => {
    const client = new WeatherClient(makeHttp(RAIN_RAW));
    const result = await client.fetch(makeReq());
    expect(result.current.isDay).toBe(false);
  });

  it("uses imperial unit when requested", async () => {
    let capturedUrl = "";
    const client = new WeatherClient(async (url) => {
      capturedUrl = url;
      return US_WEATHER_RAW;
    });
    await client.fetch(makeReq({ unit: "imperial" }));
    expect(capturedUrl).toContain("fahrenheit");
    expect(capturedUrl).toContain("mph");
  });

  it("uses metric unit by default", async () => {
    let capturedUrl = "";
    const client = new WeatherClient(async (url) => {
      capturedUrl = url;
      return US_WEATHER_RAW;
    });
    await client.fetch(makeReq());
    expect(capturedUrl).toContain("celsius");
    expect(capturedUrl).toContain("kmh");
  });

  it("includes lat/lng in URL", async () => {
    let capturedUrl = "";
    const client = new WeatherClient(async (url) => {
      capturedUrl = url;
      return US_WEATHER_RAW;
    });
    await client.fetch(makeReq({ lat: 51.5, lng: -0.12 }));
    expect(capturedUrl).toContain("latitude=51.5");
    expect(capturedUrl).toContain("longitude=-0.12");
  });

  it("includes hourly params when requested", async () => {
    let capturedUrl = "";
    const client = new WeatherClient(async (url) => {
      capturedUrl = url;
      return US_WEATHER_RAW;
    });
    await client.fetch(makeReq({ hourly: ["temperature_2m", "precipitation"] }));
    expect(capturedUrl).toContain("hourly=temperature_2m%2Cprecipitation");
  });

  it("parses hourly data when present", async () => {
    const raw = {
      ...US_WEATHER_RAW,
      hourly: {
        time: ["2024-01-01T00:00", "2024-01-01T01:00"],
        temperature_2m: [20, 21],
        relativehumidity_2m: [55, 60],
        precipitation: [0, 0.5],
      },
    };
    const client = new WeatherClient(makeHttp(raw));
    const result = await client.fetch(makeReq({ hourly: ["temperature_2m"] }));
    expect(result.hourly?.time).toHaveLength(2);
    expect(result.hourly?.relativeHumidity).toEqual([55, 60]);
  });

  it("parses daily data when present", async () => {
    const raw = {
      ...US_WEATHER_RAW,
      daily: {
        time: ["2024-01-01", "2024-01-02"],
        weathercode: [0, 61],
        temperature_2m_max: [25, 20],
        temperature_2m_min: [15, 10],
        precipitation_sum: [0, 2.5],
      },
    };
    const client = new WeatherClient(makeHttp(raw));
    const result = await client.fetch(makeReq({ daily: true }));
    expect(result.daily?.time).toHaveLength(2);
    expect(result.daily?.weatherCode).toEqual([0, 61]);
    expect(result.daily?.precipitationSum).toEqual([0, 2.5]);
  });

  it("fetchedAt is an ISO string", async () => {
    const client = new WeatherClient(makeHttp(US_WEATHER_RAW));
    const result = await client.fetch(makeReq());
    expect(() => new Date(result.fetchedAt)).not.toThrow();
  });
});

// ── WeatherFeed ───────────────────────────────────────────────────────────────

describe("WeatherFeed", () => {
  it("first fetch returns cached: false", async () => {
    const feed = new WeatherFeed({ http: makeHttp(US_WEATHER_RAW) });
    const { cached } = await feed.fetch(makeReq());
    expect(cached).toBe(false);
  });

  it("second fetch returns cached: true", async () => {
    let callCount = 0;
    const feed = new WeatherFeed({
      http: async () => {
        callCount++;
        return US_WEATHER_RAW;
      },
    });
    await feed.fetch(makeReq());
    const { cached } = await feed.fetch(makeReq());
    expect(cached).toBe(true);
    expect(callCount).toBe(1);
  });

  it("forceRefresh bypasses cache", async () => {
    let callCount = 0;
    const feed = new WeatherFeed({
      http: async () => {
        callCount++;
        return US_WEATHER_RAW;
      },
    });
    await feed.fetch(makeReq());
    await feed.fetch(makeReq(), true);
    expect(callCount).toBe(2);
  });

  it("fetchAll resolves all requests in parallel", async () => {
    const feed = new WeatherFeed({ http: makeHttp(US_WEATHER_RAW) });
    const results = await feed.fetchAll([makeReq({ lat: 1 }), makeReq({ lat: 2 })]);
    expect(results).toHaveLength(2);
  });

  it("getCache returns the WeatherCache instance", () => {
    const feed = new WeatherFeed();
    expect(feed.getCache()).toBeDefined();
  });
});
