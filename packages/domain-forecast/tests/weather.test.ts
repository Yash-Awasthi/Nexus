// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { weatherHandler } from "../src/index.js";

const GEO = { results: [{ name: "Paris", country: "France", latitude: 48.85, longitude: 2.35 }] };
const DAILY = {
  daily: {
    time: ["2026-09-29", "2026-09-30"],
    temperature_2m_max: [27.9, 22.9],
    temperature_2m_min: [17.4, 18.5],
    precipitation_probability_max: [3, 78],
    weather_code: [1, 61],
  },
};

function fakeFetch(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    const body = url.includes("geocoding") ? GEO : DAILY;
    return { ok: true, json: async () => body };
  };
}

describe("weatherHandler without an OpenWeather key", () => {
  it("geocodes the city and forecasts each day from Open-Meteo", async () => {
    const calls: string[] = [];
    const handler = weatherHandler("Paris", { apiKey: "", fetchFn: fakeFetch(calls) });
    const res = await handler.generate({ domain: "geo", horizon: "7d" });
    expect(calls[0]).toContain("geocoding-api.open-meteo.com/v1/search?name=Paris");
    expect(calls[1]).toContain("latitude=48.85&longitude=2.35");
    expect(res.summary).toBe("Paris, France: mainly clear, 17–28°C");
    expect(res.indicators).toMatchObject({ source: "open-meteo" });
    expect(res.scenarios.map((s) => s.label)).toEqual(["2026-09-29", "2026-09-30"]);
    expect(res.scenarios[1]).toMatchObject({
      description: "slight rain, 19–23°C, 78% chance of rain",
      probability: 0.78,
    });
  });

  it("says so when the city is unknown", async () => {
    const handler = weatherHandler("Nowhere", {
      apiKey: "",
      fetchFn: async () => ({ ok: true, json: async () => ({}) }),
    });
    const res = await handler.generate({ domain: "geo", horizon: "7d" });
    expect(res.summary).toMatch(/No place called "Nowhere"/);
    expect(res.scenarios).toEqual([]);
  });
});
