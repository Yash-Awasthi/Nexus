// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  GatewayAdminService,
  AdminRouter,
  AdminGatewayError,
  type RouteEntry,
  type AliasStats,
} from "../src/index.js";

// ── GatewayAdminService — routes ──────────────────────────────────────────────

describe("GatewayAdminService — routes", () => {
  let svc: GatewayAdminService;

  beforeEach(() => {
    svc = new GatewayAdminService();
  });

  it("addRoute + resolveAlias round-trips", () => {
    svc.addRoute("fast", "gpt-4o-mini", "openai");
    const r = svc.resolveAlias("fast")!;
    expect(r.model).toBe("gpt-4o-mini");
    expect(r.provider).toBe("openai");
    expect(r.overridden).toBe(false);
  });

  it("resolveAlias returns undefined for unknown alias", () => {
    expect(svc.resolveAlias("ghost")).toBeUndefined();
  });

  it("listRoutes returns all static routes sorted by alias", () => {
    svc.addRoute("z-model", "m1", "p1");
    svc.addRoute("a-model", "m2", "p2");
    const routes = svc.listRoutes();
    expect(routes[0]!.alias).toBe("a-model");
    expect(routes[1]!.alias).toBe("z-model");
  });

  it("overrideAlias takes precedence over static route", () => {
    svc.addRoute("smart", "gpt-4o", "openai");
    svc.overrideAlias("smart", "claude-3-5-sonnet-20241022");
    const r = svc.resolveAlias("smart")!;
    expect(r.model).toBe("claude-3-5-sonnet-20241022");
    expect(r.overridden).toBe(true);
  });

  it("overrideAlias works without a static entry", () => {
    svc.overrideAlias("temp", "gemini-pro");
    const r = svc.resolveAlias("temp")!;
    expect(r.model).toBe("gemini-pro");
    expect(r.overridden).toBe(true);
  });

  it("removeOverride reverts to static route", () => {
    svc.addRoute("smart", "gpt-4o", "openai");
    svc.overrideAlias("smart", "override-model");
    svc.removeOverride("smart");
    const r = svc.resolveAlias("smart")!;
    expect(r.model).toBe("gpt-4o");
    expect(r.overridden).toBe(false);
  });

  it("removeOverride returns false when no override exists", () => {
    expect(svc.removeOverride("missing")).toBe(false);
  });

  it("removeRoute removes static entry and override", () => {
    svc.addRoute("x", "m", "p");
    svc.overrideAlias("x", "m2");
    svc.removeRoute("x");
    expect(svc.resolveAlias("x")).toBeUndefined();
  });

  it("removeRoute returns false for unknown alias", () => {
    expect(svc.removeRoute("ghost")).toBe(false);
  });

  it("hasAlias returns true for static and override", () => {
    svc.addRoute("a", "m", "p");
    svc.overrideAlias("b", "m");
    expect(svc.hasAlias("a")).toBe(true);
    expect(svc.hasAlias("b")).toBe(true);
    expect(svc.hasAlias("c")).toBe(false);
  });

  it("listRoutes shows overridden flag correctly", () => {
    svc.addRoute("a", "m1", "p1");
    svc.addRoute("b", "m2", "p2");
    svc.overrideAlias("a", "m1-override");
    const routes = svc.listRoutes();
    const a = routes.find((r) => r.alias === "a")!;
    const b = routes.find((r) => r.alias === "b")!;
    expect(a.overridden).toBe(true);
    expect(b.overridden).toBe(false);
  });

  it("addRoute throws INVALID_ALIAS for empty alias", () => {
    expect(() => svc.addRoute("  ", "m", "p")).toThrow(AdminGatewayError);
  });

  it("addRoute throws INVALID_MODEL for empty model", () => {
    expect(() => svc.addRoute("a", "", "p")).toThrow(AdminGatewayError);
  });

  it("override-only routes appear in listRoutes", () => {
    svc.overrideAlias("runtime-only", "llama3");
    const routes = svc.listRoutes();
    expect(routes.some((r) => r.alias === "runtime-only")).toBe(true);
  });
});

// ── GatewayAdminService — stats ───────────────────────────────────────────────

describe("GatewayAdminService — stats", () => {
  let svc: GatewayAdminService;

  beforeEach(() => {
    svc = new GatewayAdminService();
  });

  it("recordRequest increments request count", () => {
    svc.recordRequest("fast");
    svc.recordRequest("fast");
    const [s] = svc.getStats("fast");
    expect(s!.requests).toBe(2);
  });

  it("recordRequest tracks total tokens", () => {
    svc.recordRequest("fast", { tokens: 100 });
    svc.recordRequest("fast", { tokens: 200 });
    const [s] = svc.getStats("fast");
    expect(s!.totalTokens).toBe(300);
  });

  it("recordRequest tracks errors", () => {
    svc.recordRequest("fast", { error: true });
    svc.recordRequest("fast");
    const [s] = svc.getStats("fast");
    expect(s!.errors).toBe(1);
  });

  it("recordRequest computes avgLatencyMs", () => {
    svc.recordRequest("fast", { latencyMs: 100 });
    svc.recordRequest("fast", { latencyMs: 200 });
    const [s] = svc.getStats("fast");
    expect(s!.avgLatencyMs).toBeCloseTo(150, 0);
  });

  it("getStats with no alias returns all entries sorted", () => {
    svc.recordRequest("z");
    svc.recordRequest("a");
    const stats = svc.getStats();
    expect(stats[0]!.alias).toBe("a");
    expect(stats[1]!.alias).toBe("z");
  });

  it("getStats for unknown alias returns zero-stats entry", () => {
    const [s] = svc.getStats("never-seen");
    expect(s!.requests).toBe(0);
    expect(s!.alias).toBe("never-seen");
  });

  it("resetStats clears all entries", () => {
    svc.recordRequest("fast");
    svc.resetStats();
    expect(svc.getStats()).toHaveLength(0);
  });

  it("resetStats with alias clears only that alias", () => {
    svc.recordRequest("fast");
    svc.recordRequest("smart");
    svc.resetStats("fast");
    expect(svc.getStats("fast")[0]!.requests).toBe(0);
    expect(svc.getStats("smart")[0]!.requests).toBe(1);
  });

  it("setLastUsedAt is populated after recordRequest", () => {
    svc.recordRequest("fast");
    const [s] = svc.getStats("fast");
    expect(s!.lastUsedAt).toBeDefined();
  });
});

// ── AdminRouter ───────────────────────────────────────────────────────────────

describe("AdminRouter", () => {
  let svc: GatewayAdminService;
  let router: AdminRouter;

  beforeEach(() => {
    svc = new GatewayAdminService();
    svc.addRoute("fast", "gpt-4o-mini", "openai");
    svc.addRoute("smart", "gpt-4o", "openai");
    router = new AdminRouter(svc);
  });

  it("GET /routes returns all routes", () => {
    const res = router.handle({ method: "GET", path: "/routes" });
    expect(res.status).toBe(200);
    expect((res.body as any).routes).toHaveLength(2);
  });

  it("GET /routes/:alias returns specific route", () => {
    const res = router.handle({ method: "GET", path: "/routes/fast" });
    expect(res.status).toBe(200);
    expect((res.body as any).route.model).toBe("gpt-4o-mini");
  });

  it("GET /routes/:alias returns 404 for unknown alias", () => {
    const res = router.handle({ method: "GET", path: "/routes/unknown" });
    expect(res.status).toBe(404);
  });

  it("PATCH /routes/:alias overrides model", () => {
    const res = router.handle({
      method: "PATCH",
      path: "/routes/fast",
      body: { model: "claude-haiku" },
    });
    expect(res.status).toBe(200);
    expect((res.body as any).route.model).toBe("claude-haiku");
    expect((res.body as any).route.overridden).toBe(true);
  });

  it("PATCH /routes/:alias requires model in body", () => {
    const res = router.handle({ method: "PATCH", path: "/routes/fast", body: {} });
    expect(res.status).toBe(400);
  });

  it("DELETE /routes/:alias removes override", () => {
    svc.overrideAlias("fast", "override");
    const res = router.handle({ method: "DELETE", path: "/routes/fast" });
    expect(res.status).toBe(200);
    expect(svc.resolveAlias("fast")!.model).toBe("gpt-4o-mini");
  });

  it("DELETE /routes/:alias returns 404 when no override", () => {
    const res = router.handle({ method: "DELETE", path: "/routes/fast" });
    expect(res.status).toBe(404);
  });

  it("GET /stats returns per-alias stats", () => {
    svc.recordRequest("fast", { tokens: 100 });
    const res = router.handle({ method: "GET", path: "/stats" });
    expect(res.status).toBe(200);
    const stats = (res.body as any).stats as AliasStats[];
    expect(stats.some((s) => s.alias === "fast")).toBe(true);
  });

  it("GET /stats/:alias returns stats for one alias", () => {
    svc.recordRequest("fast", { tokens: 150 });
    const res = router.handle({ method: "GET", path: "/stats/fast" });
    expect(res.status).toBe(200);
    expect((res.body as any).stats.totalTokens).toBe(150);
  });

  it("POST /stats/reset clears all stats", () => {
    svc.recordRequest("fast");
    const res = router.handle({ method: "POST", path: "/stats/reset", body: {} });
    expect(res.status).toBe(200);
    expect(svc.getStats()).toHaveLength(0);
  });

  it("POST /stats/reset with alias clears specific alias", () => {
    svc.recordRequest("fast");
    svc.recordRequest("smart");
    router.handle({ method: "POST", path: "/stats/reset", body: { alias: "fast" } });
    expect(svc.getStats("fast")[0]!.requests).toBe(0);
    expect(svc.getStats("smart")[0]!.requests).toBe(1);
  });

  it("unknown route returns 404", () => {
    const res = router.handle({ method: "GET", path: "/unknown" });
    expect(res.status).toBe(404);
  });
});

// ── AdminGatewayError ─────────────────────────────────────────────────────────

describe("AdminGatewayError", () => {
  it("has correct name, code, statusCode, and message", () => {
    const e = new AdminGatewayError("not found", "NOT_FOUND", 404);
    expect(e.name).toBe("AdminGatewayError");
    expect(e.code).toBe("NOT_FOUND");
    expect(e.statusCode).toBe(404);
    expect(e instanceof Error).toBe(true);
  });

  it("defaults statusCode to 400", () => {
    const e = new AdminGatewayError("bad", "BAD");
    expect(e.statusCode).toBe(400);
  });
});
