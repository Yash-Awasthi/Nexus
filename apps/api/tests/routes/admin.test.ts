// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeEach(async () => {
  delete process.env.NEXUS_API_KEY; // dev bypass
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// ── GET /admin/routes ─────────────────────────────────────────────────────────

describe("GET /api/v1/admin/routes", () => {
  it("returns 200 with routes array", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/routes" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ routes: unknown[]; total: number }>();
    expect(Array.isArray(body.routes)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.total).toBeGreaterThan(0); // bootstrapped from DRIVER_ALIASES
  });

  it("each route has alias, model, provider fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/routes" });
    const body = res.json<{ routes: { alias: string; model: string; provider: string }[] }>();
    const first = body.routes[0]!;
    expect(first).toHaveProperty("alias");
    expect(first).toHaveProperty("model");
    expect(first).toHaveProperty("provider");
  });
});

// ── POST /admin/routes ────────────────────────────────────────────────────────

describe("POST /api/v1/admin/routes", () => {
  it("adds a new route and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/routes",
      payload: { alias: "test/mymodel", model: "my-model-id", provider: "groq" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ alias: string; model: string; provider: string }>();
    expect(body.alias).toBe("test/mymodel");
    expect(body.model).toBe("my-model-id");
    expect(body.provider).toBe("groq");
  });

  it("validates schema — rejects missing alias", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/routes",
      payload: { model: "x", provider: "groq" }, // no alias
    });
    expect(res.statusCode).toBe(400);
  });

  it("validates schema — rejects missing model", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/routes",
      payload: { alias: "a/b", provider: "groq" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("validates schema — rejects missing provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/routes",
      payload: { alias: "a/b", model: "m" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── POST /admin/routes/:alias/override ────────────────────────────────────────

describe("POST /api/v1/admin/routes/:alias/override", () => {
  it("sets override for existing alias and returns 200", async () => {
    const alias = encodeURIComponent("nexus/fast");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/routes/${alias}/override`,
      payload: { model: "llama-3.1-8b-instant" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ alias: string; overrideModel: string }>();
    expect(body.alias).toBe("nexus/fast");
    expect(body.overrideModel).toBe("llama-3.1-8b-instant");
  });

  it("validates schema — rejects missing model", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/routes/nexus%2Ffast/override",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── GET /admin/settings ───────────────────────────────────────────────────────

describe("GET /api/v1/admin/settings", () => {
  it("returns current settings object", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      settings: {
        tracing: boolean;
        logLevel: string;
        rateLimitRpm: number;
        maxTokens: number;
        defaultModel: string;
        corsOrigins: string[];
      };
    }>();
    expect(typeof body.settings.tracing).toBe("boolean");
    expect(typeof body.settings.logLevel).toBe("string");
    expect(typeof body.settings.rateLimitRpm).toBe("number");
    expect(Array.isArray(body.settings.corsOrigins)).toBe(true);
  });
});

// ── POST /admin/settings ──────────────────────────────────────────────────────

describe("POST /api/v1/admin/settings", () => {
  it("updates logLevel and returns updated settings", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/settings",
      payload: { logLevel: "debug" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ settings: { logLevel: string } }>();
    expect(body.settings.logLevel).toBe("debug");
  });

  it("rejects invalid logLevel via schema", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/settings",
      payload: { logLevel: "verbose" }, // not in enum
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts valid payload with no extra fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/settings",
      payload: { logLevel: "warn" },
    });
    // Valid update should succeed
    expect(res.statusCode).toBe(200);
    const body = res.json<{ settings: { logLevel: string } }>();
    expect(body.settings.logLevel).toBe("warn");
  });
});

// ── GET /admin/stats ──────────────────────────────────────────────────────────

describe("GET /api/v1/admin/stats", () => {
  it("returns usage stats object", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/stats" });
    expect(res.statusCode).toBe(200);
  });
});

// ── GET /admin/traces ─────────────────────────────────────────────────────────

describe("GET /api/v1/admin/traces", () => {
  it("returns traces list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/traces" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: unknown[]; total: number }>();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(typeof body.total).toBe("number");
  });
});
