// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LOCALE_MAP,
  EU_COUNTRIES,
  lookupLocale,
  isEuCountry,
  MockMmdbReader,
  GeoIpCache,
  GeoIpResolver,
  isPrivateIp,
  normalizeIp,
  PeriodicCacheRefresher,
  type RawMmdbRecord,
  type GeoIpRecord,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const US_RAW: RawMmdbRecord = {
  country: { names: { en: "United States" }, iso_code: "US" },
  continent: { names: { en: "North America" } },
  city: { names: { en: "New York" } },
  location: { latitude: 40.71, longitude: -74.00, time_zone: "America/New_York" },
  postal: { code: "10001" },
};

const DE_RAW: RawMmdbRecord = {
  country: { names: { en: "Germany" }, iso_code: "DE" },
  continent: { names: { en: "Europe" } },
  location: { latitude: 51.5, longitude: 10.0, time_zone: "Europe/Berlin" },
};

// ── lookupLocale / isEuCountry ────────────────────────────────────────────────

describe("lookupLocale", () => {
  it("returns correct BCP-47 locale for known countries", () => {
    expect(lookupLocale("US")).toBe("en-US");
    expect(lookupLocale("DE")).toBe("de-DE");
    expect(lookupLocale("JP")).toBe("ja-JP");
    expect(lookupLocale("SA")).toBe("ar-SA");
    expect(lookupLocale("IN")).toBe("hi-IN");
    expect(lookupLocale("BR")).toBe("pt-BR");
  });

  it("returns en-XX fallback for unknown country code", () => {
    expect(lookupLocale("ZZ")).toBe("en-ZZ");
  });

  it("LOCALE_MAP has at least 40 entries", () => {
    expect(Object.keys(LOCALE_MAP).length).toBeGreaterThanOrEqual(40);
  });
});

describe("isEuCountry", () => {
  it("returns true for EU member states", () => {
    expect(isEuCountry("DE")).toBe(true);
    expect(isEuCountry("FR")).toBe(true);
    expect(isEuCountry("PL")).toBe(true);
  });

  it("returns false for non-EU countries", () => {
    expect(isEuCountry("US")).toBe(false);
    expect(isEuCountry("GB")).toBe(false); // Brexit
    expect(isEuCountry("JP")).toBe(false);
  });
});

// ── isPrivateIp / normalizeIp ─────────────────────────────────────────────────

describe("isPrivateIp", () => {
  it("detects loopback", () => { expect(isPrivateIp("127.0.0.1")).toBe(true); });
  it("detects 10.x.x.x", () => { expect(isPrivateIp("10.0.0.1")).toBe(true); });
  it("detects 192.168.x.x", () => { expect(isPrivateIp("192.168.1.1")).toBe(true); });
  it("detects 172.16.x.x", () => { expect(isPrivateIp("172.16.0.1")).toBe(true); });
  it("detects 172.31.x.x", () => { expect(isPrivateIp("172.31.255.255")).toBe(true); });
  it("returns false for public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
  });
  it("detects IPv6 loopback", () => { expect(isPrivateIp("::1")).toBe(true); });
  it("detects IPv6 link-local", () => { expect(isPrivateIp("fe80::1")).toBe(true); });
});

describe("normalizeIp", () => {
  it("strips IPv4-mapped IPv6 prefix", () => {
    expect(normalizeIp("::ffff:8.8.8.8")).toBe("8.8.8.8");
  });
  it("trims whitespace", () => { expect(normalizeIp("  8.8.8.8  ")).toBe("8.8.8.8"); });
  it("leaves plain IPv4 unchanged", () => { expect(normalizeIp("1.2.3.4")).toBe("1.2.3.4"); });
});

// ── MockMmdbReader ────────────────────────────────────────────────────────────

describe("MockMmdbReader", () => {
  it("get returns configured record", () => {
    const reader = new MockMmdbReader({ "8.8.8.8": US_RAW });
    expect(reader.get("8.8.8.8")).toEqual(US_RAW);
  });

  it("get returns null for unknown IP when no default", () => {
    const reader = new MockMmdbReader();
    expect(reader.get("1.2.3.4")).toBeNull();
  });

  it("get returns defaultRecord for unknown IP", () => {
    const reader = new MockMmdbReader({}, DE_RAW);
    expect(reader.get("1.2.3.4")).toEqual(DE_RAW);
  });

  it("set adds new entry", () => {
    const reader = new MockMmdbReader();
    reader.set("1.1.1.1", US_RAW);
    expect(reader.get("1.1.1.1")).toEqual(US_RAW);
  });

  it("delete removes entry", () => {
    const reader = new MockMmdbReader({ "8.8.8.8": US_RAW });
    reader.delete("8.8.8.8");
    expect(reader.get("8.8.8.8")).toBeNull();
  });

  it("clear removes all entries", () => {
    const reader = new MockMmdbReader({ "8.8.8.8": US_RAW, "1.1.1.1": DE_RAW });
    reader.clear();
    expect(reader.get("8.8.8.8")).toBeNull();
  });
});

// ── GeoIpCache ────────────────────────────────────────────────────────────────

const stubRecord = (ip: string): GeoIpRecord => ({
  ip, country: "US", countryCode: "US", continent: "NA",
  lat: 0, lng: 0, timezone: "UTC", locale: "en-US", isEu: false,
});

describe("GeoIpCache", () => {
  it("set and get returns record", () => {
    const cache = new GeoIpCache();
    cache.set("1.2.3.4", stubRecord("1.2.3.4"));
    expect(cache.get("1.2.3.4")).not.toBeNull();
  });

  it("get returns null for missing key", () => {
    const cache = new GeoIpCache();
    expect(cache.get("1.2.3.4")).toBeNull();
  });

  it("returns null after TTL expires", async () => {
    const cache = new GeoIpCache(10); // 10ms TTL
    cache.set("1.2.3.4", stubRecord("1.2.3.4"));
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("1.2.3.4")).toBeNull();
  });

  it("invalidate removes specific key", () => {
    const cache = new GeoIpCache();
    cache.set("1.2.3.4", stubRecord("1.2.3.4"));
    cache.invalidate("1.2.3.4");
    expect(cache.get("1.2.3.4")).toBeNull();
  });

  it("clear removes all entries", () => {
    const cache = new GeoIpCache();
    cache.set("1.2.3.4", stubRecord("1.2.3.4"));
    cache.set("5.6.7.8", stubRecord("5.6.7.8"));
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("prune removes expired entries", async () => {
    const cache = new GeoIpCache(10);
    cache.set("1.2.3.4", stubRecord("1.2.3.4"));
    await new Promise((r) => setTimeout(r, 20));
    // Size still 1 until pruned (deleted on get, not preemptively)
    const pruned = cache.prune();
    expect(pruned).toBe(1);
    expect(cache.size()).toBe(0);
  });
});

// ── GeoIpResolver ─────────────────────────────────────────────────────────────

describe("GeoIpResolver", () => {
  it("resolves US IP correctly", () => {
    const reader = new MockMmdbReader({ "8.8.8.8": US_RAW });
    const resolver = new GeoIpResolver({ reader });
    const rec = resolver.resolve("8.8.8.8");
    expect(rec.countryCode).toBe("US");
    expect(rec.country).toBe("United States");
    expect(rec.timezone).toBe("America/New_York");
    expect(rec.locale).toBe("en-US");
    expect(rec.isEu).toBe(false);
    expect(rec.city).toBe("New York");
    expect(rec.postalCode).toBe("10001");
    expect(rec.lat).toBeCloseTo(40.71);
  });

  it("resolves EU German IP with isEu: true", () => {
    const reader = new MockMmdbReader({ "85.1.1.1": DE_RAW });
    const resolver = new GeoIpResolver({ reader });
    const rec = resolver.resolve("85.1.1.1");
    expect(rec.countryCode).toBe("DE");
    expect(rec.isEu).toBe(true);
    expect(rec.locale).toBe("de-DE");
  });

  it("returns private fallback for loopback", () => {
    const reader = new MockMmdbReader();
    const resolver = new GeoIpResolver({ reader });
    const rec = resolver.resolve("127.0.0.1");
    expect(rec.ip).toBe("127.0.0.1");
    expect(rec.countryCode).toBe("XX");
    expect(rec.timezone).toBe("UTC");
  });

  it("returns fallback with custom privateIpFallback", () => {
    const reader = new MockMmdbReader();
    const resolver = new GeoIpResolver({
      reader,
      privateIpFallback: { countryCode: "IN", locale: "hi-IN", timezone: "Asia/Kolkata" },
    });
    const rec = resolver.resolve("192.168.1.1");
    expect(rec.countryCode).toBe("IN");
    expect(rec.timezone).toBe("Asia/Kolkata");
  });

  it("strips IPv4-mapped IPv6 prefix", () => {
    const reader = new MockMmdbReader({ "8.8.8.8": US_RAW });
    const resolver = new GeoIpResolver({ reader });
    const rec = resolver.resolve("::ffff:8.8.8.8");
    expect(rec.countryCode).toBe("US");
  });

  it("uses cache on second call", () => {
    const reader = new MockMmdbReader({ "8.8.8.8": US_RAW });
    const getSpy = vi.spyOn(reader, "get");
    const resolver = new GeoIpResolver({ reader });
    resolver.resolve("8.8.8.8");
    resolver.resolve("8.8.8.8");
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("resolveAll resolves multiple IPs", () => {
    const reader = new MockMmdbReader({ "8.8.8.8": US_RAW, "85.1.1.1": DE_RAW });
    const resolver = new GeoIpResolver({ reader });
    const results = resolver.resolveAll(["8.8.8.8", "85.1.1.1"]);
    expect(results).toHaveLength(2);
    expect(results[0]!.countryCode).toBe("US");
    expect(results[1]!.countryCode).toBe("DE");
  });

  it("invalidate removes from cache and re-fetches", () => {
    const reader = new MockMmdbReader({ "8.8.8.8": US_RAW });
    const getSpy = vi.spyOn(reader, "get");
    const resolver = new GeoIpResolver({ reader });
    resolver.resolve("8.8.8.8");
    resolver.invalidate("8.8.8.8");
    resolver.resolve("8.8.8.8");
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it("returns fallback record for unknown IP with no MMDB entry", () => {
    const reader = new MockMmdbReader(); // returns null for all
    const resolver = new GeoIpResolver({ reader });
    const rec = resolver.resolve("123.123.123.123");
    expect(rec.countryCode).toBe("XX");
    expect(rec.ip).toBe("123.123.123.123");
  });
});

// ── PeriodicCacheRefresher ────────────────────────────────────────────────────

describe("PeriodicCacheRefresher", () => {
  it("start sets isRunning to true, stop sets false", () => {
    const cache = new GeoIpCache();
    const refresher = new PeriodicCacheRefresher(cache, 1_000_000);
    refresher.start();
    expect(refresher.isRunning).toBe(true);
    refresher.stop();
    expect(refresher.isRunning).toBe(false);
  });

  it("start is idempotent", () => {
    const cache = new GeoIpCache();
    const refresher = new PeriodicCacheRefresher(cache, 1_000_000);
    refresher.start();
    refresher.start(); // second call is no-op
    expect(refresher.isRunning).toBe(true);
    refresher.stop();
  });

  it("stop before start is safe", () => {
    const cache = new GeoIpCache();
    const refresher = new PeriodicCacheRefresher(cache, 1_000_000);
    expect(() => refresher.stop()).not.toThrow();
  });
});
