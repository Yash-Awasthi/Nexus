// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  MockForecastHandler,
  ForecastCache,
  RpcGateway,
  ForecastService,
  createDefaultGateway,
  type ForecastRequest,
  type ForecastDomain,
  type ForecastHorizon,
  type ForecastChunk,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(
  domain: ForecastDomain = "risk",
  horizon: ForecastHorizon = "7d",
): ForecastRequest {
  return { domain, horizon };
}

async function collectChunks(iter: AsyncIterable<ForecastChunk>): Promise<ForecastChunk[]> {
  const chunks: ForecastChunk[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  return chunks;
}

// ── MockForecastHandler ───────────────────────────────────────────────────────

describe("MockForecastHandler", () => {
  it("generate returns a ForecastResult with 3 scenarios by default", async () => {
    const handler = new MockForecastHandler("risk");
    const result = await handler.generate(makeReq("risk", "7d"));
    expect(result.domain).toBe("risk");
    expect(result.horizon).toBe("7d");
    expect(result.scenarios).toHaveLength(3);
    expect(result.confidence).toBe(0.75);
    expect(typeof result.summary).toBe("string");
  });

  it("generate records calls", async () => {
    const handler = new MockForecastHandler("market");
    await handler.generate(makeReq("market"));
    await handler.generate(makeReq("market", "30d"));
    expect(handler.calls).toHaveLength(2);
  });

  it("generate throws when throws is configured", async () => {
    const handler = new MockForecastHandler("geo", { throws: "model unavailable" });
    await expect(handler.generate(makeReq("geo"))).rejects.toThrow("model unavailable");
  });

  it("generate merges custom result fields", async () => {
    const handler = new MockForecastHandler("risk", {
      result: { confidence: 0.5, summary: "Custom summary" },
    });
    const result = await handler.generate(makeReq("risk"));
    expect(result.confidence).toBe(0.5);
    expect(result.summary).toBe("Custom summary");
  });

  it("stream yields scenario, indicator, summary, complete chunks", async () => {
    const handler = new MockForecastHandler("military");
    const chunks = await collectChunks(handler.stream!(makeReq("military")));
    const types = chunks.map((c) => c.type);
    expect(types).toContain("scenario");
    expect(types).toContain("indicator");
    expect(types).toContain("summary");
    expect(types[types.length - 1]).toBe("complete");
  });

  it("stream scenario chunks have correct shape", async () => {
    const handler = new MockForecastHandler("risk");
    const chunks = await collectChunks(handler.stream!(makeReq("risk")));
    const scenarios = chunks.filter((c) => c.type === "scenario").map((c) => c.data) as any[];
    expect(scenarios.length).toBeGreaterThan(0);
    scenarios.forEach((s) => {
      expect(s.probability).toBeGreaterThanOrEqual(0);
      expect(s.probability).toBeLessThanOrEqual(1);
      expect(s.drivers).toBeDefined();
    });
  });

  it("stream sequences are monotonically increasing", async () => {
    const handler = new MockForecastHandler("market");
    const chunks = await collectChunks(handler.stream!(makeReq("market")));
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.sequence).toBe(i);
    }
  });
});

// ── ForecastCache ─────────────────────────────────────────────────────────────

describe("ForecastCache", () => {
  it("set and get returns result", async () => {
    const cache = new ForecastCache();
    const handler = new MockForecastHandler("risk");
    const req = makeReq("risk", "7d");
    const result = await handler.generate(req);
    cache.set(req, result);
    expect(cache.get(req)).not.toBeNull();
  });

  it("returns null for missing entry", () => {
    const cache = new ForecastCache();
    expect(cache.get(makeReq("market"))).toBeNull();
  });

  it("expires after TTL", async () => {
    const cache = new ForecastCache(10);
    const handler = new MockForecastHandler("risk");
    const req = makeReq("risk");
    cache.set(req, await handler.generate(req));
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get(req)).toBeNull();
  });

  it("invalidate removes entries for a domain", async () => {
    const cache = new ForecastCache();
    const handler = new MockForecastHandler("risk");
    const req1 = makeReq("risk", "7d");
    const req2 = makeReq("risk", "30d");
    cache.set(req1, await handler.generate(req1));
    cache.set(req2, await handler.generate(req2));
    cache.invalidate("risk");
    expect(cache.get(req1)).toBeNull();
    expect(cache.get(req2)).toBeNull();
  });

  it("invalidate does not remove other domains", async () => {
    const cache = new ForecastCache();
    const r1 = makeReq("risk");
    const r2 = makeReq("market");
    const h1 = new MockForecastHandler("risk");
    const h2 = new MockForecastHandler("market");
    cache.set(r1, await h1.generate(r1));
    cache.set(r2, await h2.generate(r2));
    cache.invalidate("risk");
    expect(cache.get(r2)).not.toBeNull();
  });

  it("keys differentiate by context", async () => {
    const cache = new ForecastCache();
    const h = new MockForecastHandler("geo");
    const req1 = { domain: "geo" as const, horizon: "7d" as const, context: { region: "EU" } };
    const req2 = { domain: "geo" as const, horizon: "7d" as const, context: { region: "APAC" } };
    cache.set(req1, await h.generate(req1));
    cache.set(req2, await h.generate(req2));
    expect(cache.size()).toBe(2);
  });

  it("clear removes all entries", async () => {
    const cache = new ForecastCache();
    const h = new MockForecastHandler("risk");
    const req = makeReq("risk");
    cache.set(req, await h.generate(req));
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

// ── RpcGateway ────────────────────────────────────────────────────────────────

describe("RpcGateway", () => {
  it("register and call succeeds for known domain", async () => {
    const gateway = new RpcGateway();
    gateway.register(new MockForecastHandler("risk"));
    const response = await gateway.call(makeReq("risk"));
    expect(response.status).toBe("ok");
    expect(response.result?.domain).toBe("risk");
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("call returns error for unregistered domain", async () => {
    const gateway = new RpcGateway();
    const response = await gateway.call(makeReq("market"));
    expect(response.status).toBe("error");
    expect(response.error).toContain("No handler");
  });

  it("call captures handler errors", async () => {
    const gateway = new RpcGateway();
    gateway.register(new MockForecastHandler("risk", { throws: "data unavailable" }));
    const response = await gateway.call(makeReq("risk"));
    expect(response.status).toBe("error");
    expect(response.error).toContain("data unavailable");
  });

  it("register supports chaining", () => {
    const gateway = new RpcGateway()
      .register(new MockForecastHandler("risk"))
      .register(new MockForecastHandler("market"));
    expect(gateway.domains()).toHaveLength(2);
  });

  it("has returns true for registered domain", () => {
    const gateway = new RpcGateway();
    gateway.register(new MockForecastHandler("geo"));
    expect(gateway.has("geo")).toBe(true);
    expect(gateway.has("military")).toBe(false);
  });

  it("stream yields chunks ending in complete", async () => {
    const gateway = new RpcGateway();
    gateway.register(new MockForecastHandler("military"));
    const chunks = await collectChunks(gateway.stream(makeReq("military")));
    expect(chunks[chunks.length - 1]!.type).toBe("complete");
  });

  it("stream throws for unregistered domain", async () => {
    const gateway = new RpcGateway();
    await expect(collectChunks(gateway.stream(makeReq("risk")))).rejects.toThrow("No handler");
  });

  it("callAll returns responses for all registered domains", async () => {
    const gateway = createDefaultGateway();
    const responses = await gateway.callAll("7d");
    expect(responses).toHaveLength(4);
    const domains = responses.map((r) => r.domain);
    expect(domains).toContain("risk");
    expect(domains).toContain("market");
    expect(domains).toContain("geo");
    expect(domains).toContain("military");
  });

  it("callAll includes failed domains as error responses", async () => {
    const gateway = new RpcGateway();
    gateway.register(new MockForecastHandler("risk"));
    gateway.register(new MockForecastHandler("market", { throws: "timeout" }));
    const responses = await gateway.callAll("7d");
    const failed = responses.find((r) => r.status === "error");
    expect(failed).toBeDefined();
    expect(failed?.error).toContain("timeout");
  });
});

// ── ForecastService ───────────────────────────────────────────────────────────

describe("ForecastService", () => {
  it("forecast returns ok response", async () => {
    const gateway = createDefaultGateway();
    const service = new ForecastService({ gateway });
    const response = await service.forecast(makeReq("risk"));
    expect(response.status).toBe("ok");
    expect(response.result?.domain).toBe("risk");
  });

  it("second forecast uses cache", async () => {
    const handler = new MockForecastHandler("risk");
    const gateway = new RpcGateway().register(handler);
    const service = new ForecastService({ gateway });
    await service.forecast(makeReq("risk"));
    const cached = await service.forecast(makeReq("risk"));
    expect(cached.requestId).toBe("cached");
    expect(handler.calls).toHaveLength(1);
  });

  it("forceRefresh bypasses cache", async () => {
    const handler = new MockForecastHandler("market");
    const gateway = new RpcGateway().register(handler);
    const service = new ForecastService({ gateway });
    await service.forecast(makeReq("market"));
    await service.forecast({ ...makeReq("market"), forceRefresh: true });
    expect(handler.calls).toHaveLength(2);
  });

  it("stream yields chunks without caching", async () => {
    const gateway = createDefaultGateway();
    const service = new ForecastService({ gateway });
    const chunks = await collectChunks(service.stream(makeReq("geo")));
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("forecastAll returns one response per domain", async () => {
    const gateway = createDefaultGateway();
    const service = new ForecastService({ gateway });
    const responses = await service.forecastAll("30d");
    expect(responses).toHaveLength(4);
    responses.forEach((r) => expect(r.status).toBe("ok"));
  });

  it("getCache returns ForecastCache instance", () => {
    const gateway = createDefaultGateway();
    const service = new ForecastService({ gateway });
    expect(service.getCache()).toBeDefined();
  });

  it("getGateway returns the RpcGateway", () => {
    const gateway = createDefaultGateway();
    const service = new ForecastService({ gateway });
    expect(service.getGateway()).toBe(gateway);
  });
});

// ── createDefaultGateway ──────────────────────────────────────────────────────

describe("createDefaultGateway", () => {
  it("registers all 4 forecast domains", () => {
    const gateway = createDefaultGateway();
    expect(gateway.domains()).toHaveLength(4);
    expect(gateway.has("risk")).toBe(true);
    expect(gateway.has("market")).toBe(true);
    expect(gateway.has("geo")).toBe(true);
    expect(gateway.has("military")).toBe(true);
  });

  it("accepts per-domain behaviors", async () => {
    const gateway = createDefaultGateway({ risk: { result: { confidence: 0.9 } } });
    const response = await gateway.call(makeReq("risk"));
    expect(response.result?.confidence).toBe(0.9);
  });

  it("scenario probabilities sum to approximately 1", async () => {
    const gateway = createDefaultGateway();
    const response = await gateway.call(makeReq("risk"));
    const total = response.result!.scenarios.reduce((s, sc) => s + sc.probability, 0);
    expect(total).toBeCloseTo(1.0, 1);
  });
});
