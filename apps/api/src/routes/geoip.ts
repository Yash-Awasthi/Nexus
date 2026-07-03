// SPDX-License-Identifier: Apache-2.0
/**
 * GeoIP routes — powered by @nexus/geoip.
 *
 * Uses ip-api.com (free, no registration, no API key) as the MmdbReader backend.
 * Automatically falls back to a private-IP stub for loopback / RFC-1918 addresses.
 *
 * GET /geoip/resolve?ip=x.x.x.x  — resolve a specific IP
 * GET /geoip/me                    — resolve the calling request's IP
 * POST /geoip/batch                — resolve up to 50 IPs at once
 */

import {
  GeoIpResolver,
  GeoIpCache,
  isPrivateIp,
  normalizeIp,
  type MmdbReader,
  type RawMmdbRecord,
  type GeoIpRecord,
} from "@nexus/geoip";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── HttpGeoIpReader — wraps ip-api.com into MmdbReader interface ──────────────

interface IpApiResponse {
  status: "success" | "fail";
  country?: string;
  countryCode?: string;
  continent?: string;
  city?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  query?: string;
  message?: string;
}

const IP_API_FIELDS = "status,country,countryCode,continent,city,lat,lon,timezone,query,message";

// HttpGeoIpReader wraps ip-api.com into the MmdbReader sync interface.
// No persistent internal cache — the external GeoIpCache handles TTL-based
// eviction so unique IPs don't accumulate forever in memory.
class HttpGeoIpReader implements MmdbReader {
  // Single-use sync bridge: populated by fetch(), consumed by get(), then cleared.
  private _pending = new Map<string, RawMmdbRecord>();

  get(ip: string): RawMmdbRecord | null {
    const record = this._pending.get(ip) ?? null;
    this._pending.delete(ip); // consumed once — GeoIpCache owns long-term storage
    return record;
  }

  async fetch(ip: string): Promise<RawMmdbRecord | null> {
    if (isPrivateIp(ip)) return null;
    try {
      const res = await globalThis.fetch(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${IP_API_FIELDS}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as IpApiResponse;
      if (data.status !== "success") return null;
      const record: RawMmdbRecord = {
        country: { names: { en: data.country }, iso_code: data.countryCode },
        continent: { names: { en: data.continent } },
        city: { names: { en: data.city } },
        location: { latitude: data.lat, longitude: data.lon, time_zone: data.timezone },
      };
      this._pending.set(ip, record);
      return record;
    } catch {
      return null;
    }
  }
}

const _httpReader = new HttpGeoIpReader();
const _geoCache = new GeoIpCache();
const _resolver = new GeoIpResolver({ reader: _httpReader, cache: _geoCache });

/** Resolve an IP — fetches from ip-api.com, falls back to private-IP stub. */
async function resolveIp(rawIp: string): Promise<GeoIpRecord & { private: boolean }> {
  const ip = normalizeIp(rawIp);
  const priv = isPrivateIp(ip);

  if (priv) {
    return {
      ip,
      country: "Private Network",
      countryCode: "XX",
      continent: "Unknown",
      lat: 0,
      lng: 0,
      timezone: "UTC",
      locale: "en",
      isEu: false,
      private: true,
    };
  }

  // Prefetch into reader cache, then resolve (resolver reads sync from reader)
  await _httpReader.fetch(ip);
  const record = _resolver.resolve(ip);
  return { ...record, private: false };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function geoipRoutes(app: FastifyInstance): Promise<void> {
  /** GET /geoip/resolve?ip=1.2.3.4 */
  app.get<{ Querystring: { ip: string } }>(
    "/geoip/resolve",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { ip } = request.query;
      if (!ip) return reply.code(400).send({ error: "ip query param is required" });
      try {
        const record = await resolveIp(ip);
        return reply.send({ record });
      } catch (err) {
        return reply.code(502).send({ error: "resolution_failed", message: String(err) });
      }
    },
  );

  /** GET /geoip/me — resolve the calling client's IP */
  app.get("/geoip/me", { preHandler: requireAuth }, async (request, reply) => {
    const raw =
      (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
      (request.headers["x-real-ip"] as string | undefined) ??
      request.ip ??
      "127.0.0.1";
    try {
      const record = await resolveIp(raw);
      return reply.send({ record });
    } catch (err) {
      return reply.code(502).send({ error: "resolution_failed", message: String(err) });
    }
  });

  /** POST /geoip/batch — resolve up to 50 IPs */
  app.post<{ Body: { ips: string[] } }>(
    "/geoip/batch",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { ips } = request.body ?? {};
      if (!Array.isArray(ips) || ips.length === 0) {
        return reply.code(400).send({ error: "ips array is required" });
      }
      if (ips.length > 50) {
        return reply.code(400).send({ error: "max 50 IPs per batch" });
      }
      const records = await Promise.all(
        ips.map(async (ip) => {
          try {
            return await resolveIp(ip);
          } catch {
            return { ip, error: "resolution_failed" };
          }
        }),
      );
      return reply.send({ records, total: records.length });
    },
  );
}
