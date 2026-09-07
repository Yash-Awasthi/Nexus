// SPDX-License-Identifier: Apache-2.0
// Traffic logging with sensitive-data masking (LLI parity) — focused tests.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  maskSensitiveHeaders,
  maskSensitiveBody,
  sessionIdFor,
  TrafficLogger,
  LLMGateway,
  type TrafficRecord,
  type GatewayConfig,
} from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("maskSensitiveHeaders", () => {
  it("masks authorization and api-key headers, leaving others intact", () => {
    const { headers, masked } = maskSensitiveHeaders({
      Authorization: "Bearer sk-secret123",
      "X-API-Key": "k-123",
      "Content-Type": "application/json",
      "x-lli-session": "s1",
    });
    expect(headers).toEqual({
      Authorization: "***",
      "X-API-Key": "***",
      "Content-Type": "application/json",
      "x-lli-session": "s1",
    });
    expect(masked.sort()).toEqual(["Authorization", "X-API-Key"]);
  });
});

describe("maskSensitiveBody", () => {
  it("masks sensitive keys recursively and bearer/sk-* values", () => {
    const { body, masked } = maskSensitiveBody({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi sk-proj-abc123DEF456" }],
      api_key: "sk-live-99",
      nested: { password: "hunter2", token: "t-1", keep: "visible" },
    });
    expect(body).toEqual({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi ***" }],
      api_key: "***",
      nested: { password: "***", token: "***", keep: "visible" },
    });
    expect(masked).toContain("api_key");
    expect(masked).toContain("password");
    expect(masked).toContain("token");
  });

  it("leaves plain bodies untouched", () => {
    const { body, masked } = maskSensitiveBody({ model: "claude", messages: [] });
    expect(body).toEqual({ model: "claude", messages: [] });
    expect(masked).toEqual([]);
  });
});

describe("sessionIdFor", () => {
  it("prefers the LLI session header and falls back to default", () => {
    expect(sessionIdFor({ "x-lli-session": "abc" })).toBe("abc");
    expect(sessionIdFor({ "x-session-id": "s2" })).toBe("s2");
    expect(sessionIdFor({})).toBe("default");
  });
});

describe("TrafficLogger", () => {
  it("emits masked records and never leaks secrets", () => {
    const seen: TrafficRecord[] = [];
    const logger = new TrafficLogger((r) => seen.push(r));
    logger.record({
      request: {
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: "Bearer sk-TOP-SECRET", "x-lli-session": "s9" },
        body: { model: "gpt-4o", api_key: "sk-body-secret" },
      },
      response: { status: 200, headers: {}, body: { choices: [{ text: "ok" }] } },
      upstream: "openai",
      cached: false,
      latencyMs: 12,
    });
    expect(seen).toHaveLength(1);
    const record = seen[0];
    expect(record.sessionId).toBe("s9");
    expect(record.upstream).toBe("openai");
    expect(record.status).toBe(200);
    expect(JSON.stringify(record)).not.toMatch(/sk-/);
    expect(record.request.headers.Authorization).toBe("***");
    expect((record.request.body as Record<string, unknown>).api_key).toBe("***");
    expect(record.maskedKeys).toContain("Authorization");
    expect(record.maskedKeys).toContain("api_key");
  });

  it("swallows sink failures so observation never breaks the caller", () => {
    const logger = new TrafficLogger(() => {
      throw new Error("sink down");
    });
    expect(() =>
      logger.record({
        request: { method: "GET", path: "/models", headers: {} },
        response: { status: 200, headers: {}, body: {} },
        upstream: "u",
        cached: false,
        latencyMs: 1,
      }),
    ).not.toThrow();
  });
});

describe("LLMGateway.onTraffic", () => {
  it("emits a record for every forwarded call, masked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ choices: [{ message: { content: "hi" } }] }),
      })),
    );
    const seen: TrafficRecord[] = [];
    const config: GatewayConfig = {
      upstreams: [{ name: "u1", baseUrl: "https://api.test" }],
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      onTraffic: (r) => seen.push(r),
    };
    const gateway = new LLMGateway(config);
    const res = await gateway.forward({
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer sk-abc" },
      body: { model: "gpt-4o", messages: [] },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].upstream).toBe("u1");
    expect(seen[0].status).toBe(200);
    expect(seen[0].cached).toBe(false);
    expect(seen[0].request.headers.Authorization).toBe("***");
    expect(JSON.stringify(seen[0])).not.toMatch(/sk-abc/);
  });

  it("still emits a record when the upstream fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("upstream down");
      }),
    );
    const seen: TrafficRecord[] = [];
    const gateway = new LLMGateway({
      upstreams: [{ name: "u1", baseUrl: "https://api.test" }],
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      onTraffic: (r) => seen.push(r),
    });
    const res = await gateway.forward({ method: "POST", path: "/v1/chat", headers: {} });
    expect(res.status).toBe(502);
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe(502);
  });
});