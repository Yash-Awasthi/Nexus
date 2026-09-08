// SPDX-License-Identifier: Apache-2.0
/**
 * §16.1 — GET /api/v1/domain-feeds/intel/port-congestion route contract.
 *
 * The route runs the PortCongestionFeed directly (independent of the sweep
 * cache); the feed's network layer is mocked at the adapter level via the
 * domain-feeds package's own suite — here we assert the route contract with a
 * stubbed adapter fetch path (no live ArcGIS call).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

vi.mock("@nexus/db", () => ({ db: { execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]) } }));
vi.mock("pg", () => {
  class FakePool {
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    on = vi.fn().mockReturnThis();
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: FakePool };
});

// Stub the adapter's fetch so the route test stays hermetic (no live ArcGIS).
const fetchMock = vi.fn();
vi.mock("@nexus/domain-feeds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nexus/domain-feeds")>();
  // Replace only PortCongestionFeed's fetch; keep everything else real.
  class StubFeed extends actual.PortCongestionFeed {
    override fetch(opts?: { where?: string }): Promise<actual.PortCongestionEvent[]> {
      return fetchMock(opts) as Promise<actual.PortCongestionEvent[]>;
    }
  }
  return { ...actual, PortCongestionFeed: StubFeed };
});

const AUTH_HEADERS = { authorization: "Bearer test" };

const EVENT = {
  id: "portcongestion-SUEZ-1767261600000",
  timestamp: "2026-01-01T10:00:00.000Z",
  severity: "high" as const,
  source: "imf-portwatch",
  summary: "Suez Canal: 85 transits vs capacity 70 (1.21×)",
  chokepoint: "Suez Canal",
  portId: "SUEZ",
  transitCount: 85,
  capacity: 70,
  congestionRatio: 1.21,
  eventType: "congestion" as const,
};

describe("GET /domain-feeds/intel/port-congestion", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    fetchMock.mockReset();
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns events from the feed with domain metadata", async () => {
    fetchMock.mockResolvedValue([EVENT]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/domain-feeds/intel/port-congestion",
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ domain: string; events: unknown[]; total: number }>();
    expect(body.domain).toBe("port-congestion");
    expect(body.total).toBe(1);
    expect(body.events[0]).toMatchObject({ chokepoint: "Suez Canal", eventType: "congestion" });
  });

  it("caps the result at the requested limit", async () => {
    fetchMock.mockResolvedValue(Array.from({ length: 120 }, (_, i) => ({ ...EVENT, id: `e${i}` })));
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/domain-feeds/intel/port-congestion?limit=10",
      headers: AUTH_HEADERS,
    });
    const body = res.json<{ events: unknown[]; total: number }>();
    expect(body.total).toBe(120);
    expect(body.events).toHaveLength(10);
  });

  it("propagates the where clause to the feed", async () => {
    fetchMock.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/domain-feeds/intel/port-congestion?where=portid%3D%27SUEZ%27",
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith({ where: "portid='SUEZ'" });
  });

  it("returns an empty list (not an error) when the feed has no anomalies", async () => {
    fetchMock.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/domain-feeds/intel/port-congestion",
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ events: unknown[]; total: number }>()).toEqual({
      domain: "port-congestion",
      events: [],
      total: 0,
      fetchedAt: expect.any(String),
    });
  });
});
