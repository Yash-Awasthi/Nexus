// SPDX-License-Identifier: Apache-2.0
/**
 * geoip — IP → locale / timezone / country resolver.
 *
 * Provides:
 *   • GeoIpRecord     — resolved geo data for an IP
 *   • MmdbReader      — injectable interface (real: maxmind reader, test: mock)
 *   • MockMmdbReader  — in-memory test double with programmable responses
 *   • LocaleMap       — 40+ country-code → BCP-47 locale mappings
 *   • GeoIpCache      — TTL-based cache (default 30-day)
 *   • GeoIpResolver   — main facade; resolve() + background refresh stub
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GeoIpRecord {
  ip: string;
  country: string;        // "United States"
  countryCode: string;    // "US" (ISO 3166-1 alpha-2)
  continent: string;      // "North America"
  city?: string;
  lat: number;
  lng: number;
  timezone: string;       // IANA tz, e.g. "America/New_York"
  locale: string;         // BCP-47, e.g. "en-US"
  isEu: boolean;
  postalCode?: string;
}

export interface RawMmdbRecord {
  country?: { names?: { en?: string }; iso_code?: string };
  continent?: { names?: { en?: string } };
  city?: { names?: { en?: string } };
  location?: { latitude?: number; longitude?: number; time_zone?: string };
  postal?: { code?: string };
}

// ── Locale map (40+ countries) ────────────────────────────────────────────────

export const LOCALE_MAP: Record<string, string> = {
  AF: "fa-AF", AL: "sq-AL", DZ: "ar-DZ", AR: "es-AR", AM: "hy-AM",
  AU: "en-AU", AT: "de-AT", AZ: "az-AZ", BH: "ar-BH", BY: "be-BY",
  BE: "nl-BE", BR: "pt-BR", BG: "bg-BG", CA: "en-CA", CL: "es-CL",
  CN: "zh-CN", CO: "es-CO", HR: "hr-HR", CZ: "cs-CZ", DK: "da-DK",
  EG: "ar-EG", EE: "et-EE", FI: "fi-FI", FR: "fr-FR", GE: "ka-GE",
  DE: "de-DE", GR: "el-GR", HK: "zh-HK", HU: "hu-HU", IN: "hi-IN",
  ID: "id-ID", IR: "fa-IR", IQ: "ar-IQ", IE: "en-IE", IL: "he-IL",
  IT: "it-IT", JP: "ja-JP", JO: "ar-JO", KZ: "kk-KZ", KE: "sw-KE",
  KR: "ko-KR", KW: "ar-KW", LV: "lv-LV", LB: "ar-LB", LT: "lt-LT",
  MK: "mk-MK", MY: "ms-MY", MX: "es-MX", MA: "ar-MA", NL: "nl-NL",
  NZ: "en-NZ", NG: "en-NG", NO: "no-NO", OM: "ar-OM", PK: "ur-PK",
  PH: "fil-PH", PL: "pl-PL", PT: "pt-PT", QA: "ar-QA", RO: "ro-RO",
  RU: "ru-RU", SA: "ar-SA", RS: "sr-RS", SG: "en-SG", SK: "sk-SK",
  SI: "sl-SI", ZA: "en-ZA", ES: "es-ES", SE: "sv-SE", CH: "de-CH",
  TW: "zh-TW", TH: "th-TH", TN: "ar-TN", TR: "tr-TR", UA: "uk-UA",
  AE: "ar-AE", GB: "en-GB", US: "en-US", UZ: "uz-UZ", VN: "vi-VN",
};

/** EU member-state country codes. */
const EU_COUNTRIES = new Set([
  "AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI",
  "FR","GR","HR","HU","IE","IT","LT","LU","LV","MT",
  "NL","PL","PT","RO","SE","SI","SK",
]);

export function lookupLocale(countryCode: string): string {
  return LOCALE_MAP[countryCode] ?? `en-${countryCode}`;
}

export function isEuCountry(countryCode: string): boolean {
  return EU_COUNTRIES.has(countryCode);
}

// ── MmdbReader interface ──────────────────────────────────────────────────────

export interface MmdbReader {
  get(ip: string): RawMmdbRecord | null;
}

// ── MockMmdbReader ────────────────────────────────────────────────────────────

export class MockMmdbReader implements MmdbReader {
  private entries = new Map<string, RawMmdbRecord>();
  private defaultRecord: RawMmdbRecord | null;

  constructor(defaults: Record<string, RawMmdbRecord> = {}, defaultRecord: RawMmdbRecord | null = null) {
    for (const [ip, rec] of Object.entries(defaults)) {
      this.entries.set(ip, rec);
    }
    this.defaultRecord = defaultRecord;
  }

  set(ip: string, record: RawMmdbRecord): void {
    this.entries.set(ip, record);
  }

  get(ip: string): RawMmdbRecord | null {
    return this.entries.get(ip) ?? this.defaultRecord;
  }

  delete(ip: string): void { this.entries.delete(ip); }
  clear(): void { this.entries.clear(); }
}

// ── GeoIpCache ────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class GeoIpCache {
  private cache = new Map<string, { record: GeoIpRecord; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  set(ip: string, record: GeoIpRecord): void {
    this.cache.set(ip, { record, expiresAt: Date.now() + this.ttlMs });
  }

  get(ip: string): GeoIpRecord | null {
    const entry = this.cache.get(ip);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(ip);
      return null;
    }
    return entry.record;
  }

  invalidate(ip: string): void { this.cache.delete(ip); }
  clear(): void { this.cache.clear(); }
  size(): number { return this.cache.size; }

  /** Remove all expired entries. */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [ip, entry] of this.cache) {
      if (now > entry.expiresAt) { this.cache.delete(ip); pruned++; }
    }
    return pruned;
  }
}

// ── IP validation / classification ───────────────────────────────────────────

export function isPrivateIp(ip: string): boolean {
  // IPv4 private ranges
  const ipv4Private = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^0\.0\.0\.0$/,
  ];
  if (ipv4Private.some((r) => r.test(ip))) return true;
  // IPv6 loopback / link-local
  if (ip === "::1" || ip.toLowerCase().startsWith("fe80:")) return true;
  return false;
}

export function normalizeIp(ip: string): string {
  return ip.trim().replace(/^::ffff:/, ""); // strip IPv4-mapped IPv6 prefix
}

// ── GeoIpResolver ─────────────────────────────────────────────────────────────

export interface GeoIpResolverOptions {
  reader: MmdbReader;
  cache?: GeoIpCache;
  /** Fallback record for private / unresolvable IPs */
  privateIpFallback?: Partial<GeoIpRecord>;
}

const PRIVATE_FALLBACK: GeoIpRecord = {
  ip: "",
  country: "Unknown",
  countryCode: "XX",
  continent: "Unknown",
  lat: 0,
  lng: 0,
  timezone: "UTC",
  locale: "en",
  isEu: false,
};

export class GeoIpResolver {
  private reader: MmdbReader;
  private cache: GeoIpCache;
  private privateIpFallback: GeoIpRecord;

  constructor(opts: GeoIpResolverOptions) {
    this.reader = opts.reader;
    this.cache = opts.cache ?? new GeoIpCache();
    this.privateIpFallback = { ...PRIVATE_FALLBACK, ...opts.privateIpFallback };
  }

  /** Resolve an IP to a GeoIpRecord. Uses cache; falls back for private IPs. */
  resolve(rawIp: string): GeoIpRecord {
    const ip = normalizeIp(rawIp);

    if (isPrivateIp(ip)) {
      return { ...this.privateIpFallback, ip };
    }

    const cached = this.cache.get(ip);
    if (cached) return cached;

    const raw = this.reader.get(ip);
    if (!raw) {
      const fallback = { ...PRIVATE_FALLBACK, ip };
      this.cache.set(ip, fallback);
      return fallback;
    }

    const countryCode = raw.country?.iso_code ?? "XX";
    const record: GeoIpRecord = {
      ip,
      country: raw.country?.names?.en ?? "Unknown",
      countryCode,
      continent: raw.continent?.names?.en ?? "Unknown",
      city: raw.city?.names?.en,
      lat: raw.location?.latitude ?? 0,
      lng: raw.location?.longitude ?? 0,
      timezone: raw.location?.time_zone ?? "UTC",
      locale: lookupLocale(countryCode),
      isEu: isEuCountry(countryCode),
      postalCode: raw.postal?.code,
    };

    this.cache.set(ip, record);
    return record;
  }

  /** Resolve multiple IPs in bulk. */
  resolveAll(ips: string[]): GeoIpRecord[] {
    return ips.map((ip) => this.resolve(ip));
  }

  /** Invalidate cached record for an IP. */
  invalidate(ip: string): void { this.cache.invalidate(normalizeIp(ip)); }

  getCache(): GeoIpCache { return this.cache; }
}

// ── Background refresh stub ───────────────────────────────────────────────────

export interface RefreshScheduler {
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
}

export class PeriodicCacheRefresher implements RefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cache: GeoIpCache;
  private intervalMs: number;

  constructor(cache: GeoIpCache, intervalMs = DEFAULT_TTL_MS) {
    this.cache = cache;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.cache.prune(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  get isRunning(): boolean { return this.timer !== null; }
}
