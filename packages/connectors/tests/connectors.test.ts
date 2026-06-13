// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ConnectorError,
  ConnectorRegistry,
  NullConnector,
  GitHubConnector,
  SlackConnector,
  GroqConnector,
  TavilyConnector,
  NeonConnector,
  LinearConnector,
  type Connector,
  type FetchFn,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFetch(responses: Array<{ ok: boolean; status?: number; body?: unknown }>): FetchFn {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx++] ?? { ok: true, status: 200, body: {} };
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => r.body ?? {},
    } as Response;
  });
}

const okFetch = (body: unknown = { ok: true }) =>
  makeFetch([{ ok: true, body }]);

// ─────────────────────────────────────────────────────────────────────────────
// ConnectorError
// ─────────────────────────────────────────────────────────────────────────────

describe("ConnectorError", () => {
  it("is an Error with name ConnectorError", () => {
    const e = new ConnectorError("AUTH_FAILED", "bad key");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ConnectorError");
  });

  it("exposes code and message", () => {
    const e = new ConnectorError("NOT_FOUND", "missing");
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toBe("missing");
  });

  it("stores optional context", () => {
    const e = new ConnectorError("ALREADY_REGISTERED", "dup", { id: "gh" });
    expect(e.context).toEqual({ id: "gh" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NullConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("NullConnector", () => {
  it("starts in connected status", () => {
    expect(new NullConnector().status).toBe("connected");
  });

  it("defaults id to 'null'", () => {
    expect(new NullConnector().id).toBe("null");
  });

  it("accepts custom id and name", () => {
    const c = new NullConnector("db-stub", "DB Stub");
    expect(c.id).toBe("db-stub");
    expect(c.name).toBe("DB Stub");
  });

  it("connect() returns ok:true", async () => {
    const result = await new NullConnector().connect();
    expect(result.ok).toBe(true);
  });

  it("healthCheck() returns ok:true with latencyMs", async () => {
    const result = await new NullConnector().healthCheck();
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  it("disconnect() resets status to disconnected", async () => {
    const c = new NullConnector();
    await c.disconnect();
    expect(c.status).toBe("disconnected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BaseConnector lifecycle (via NullConnector)
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseConnector — lifecycle", () => {
  it("status moves disconnected → connecting → connected on successful connect", async () => {
    const c = new NullConnector("x");
    await c.disconnect(); // start from disconnected
    const statusDuring: string[] = [];
    const orig = c["_doConnect"].bind(c);
    c["_doConnect"] = async () => {
      statusDuring.push(c.status);
      return orig();
    };
    await c.connect();
    expect(statusDuring[0]).toBe("connecting");
    expect(c.status).toBe("connected");
  });

  it("status moves to error when _doConnect returns ok:false", async () => {
    const c = new NullConnector();
    c["_doConnect"] = async () => ({ ok: false, error: "bad" });
    await c.connect();
    expect(c.status).toBe("error");
  });

  it("status moves to error when _doConnect throws", async () => {
    const c = new NullConnector();
    c["_doConnect"] = async () => { throw new Error("crash"); };
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(c.status).toBe("error");
  });

  it("disable() sets status to disabled", () => {
    const c = new NullConnector();
    (c as any).disable();
    expect(c.status).toBe("disabled");
  });

  it("connect() returns ok:false immediately when disabled", async () => {
    const c = new NullConnector();
    (c as any).disable();
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disabled");
  });

  it("enable() restores disabled → disconnected", () => {
    const c = new NullConnector();
    (c as any).disable();
    (c as any).enable();
    expect(c.status).toBe("disconnected");
  });

  it("healthCheck() wraps exception in ok:false result", async () => {
    const c = new NullConnector();
    c["_doHealthCheck"] = async () => { throw new Error("timeout"); };
    const result = await c.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GitHubConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHubConnector", () => {
  it("has id 'github'", () => {
    expect(new GitHubConnector({ token: "t", fetch: okFetch() }).id).toBe("github");
  });

  it("connect() sends Bearer token to /user", async () => {
    const fetchFn = okFetch({ login: "yash", id: 1 });
    const c = new GitHubConnector({ token: "ghp_test", fetch: fetchFn });
    await c.connect();
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_test");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("/user");
  });

  it("connect() returns login and id in metadata", async () => {
    const c = new GitHubConnector({ token: "t", fetch: okFetch({ login: "yash", id: 42 }) });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.login).toBe("yash");
    expect(result.metadata?.id).toBe(42);
  });

  it("connect() returns ok:false on 401", async () => {
    const c = new GitHubConnector({ token: "bad", fetch: makeFetch([{ ok: false, status: 401 }]) });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid or expired");
  });

  it("connect() returns ok:false on 5xx", async () => {
    const c = new GitHubConnector({ token: "t", fetch: makeFetch([{ ok: false, status: 500 }]) });
    const result = await c.connect();
    expect(result.ok).toBe(false);
  });

  it("connect() sets status to connected on success", async () => {
    const c = new GitHubConnector({ token: "t", fetch: okFetch({ login: "u" }) });
    await c.connect();
    expect(c.status).toBe("connected");
  });

  it("healthCheck() hits /rate_limit and returns rateRemaining", async () => {
    const fetchFn = okFetch({ rate: { remaining: 4999, limit: 5000 } });
    const c = new GitHubConnector({ token: "t", fetch: fetchFn });
    const hc = await c.healthCheck();
    expect(hc.ok).toBe(true);
    expect(hc.details?.rateRemaining).toBe(4999);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("rate_limit");
  });

  it("healthCheck() ok:false on non-ok response", async () => {
    const c = new GitHubConnector({ token: "t", fetch: makeFetch([{ ok: false, status: 503 }]) });
    const hc = await c.healthCheck();
    expect(hc.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SlackConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("SlackConnector", () => {
  it("has id 'slack'", () => {
    expect(new SlackConnector({ token: "t", fetch: okFetch() }).id).toBe("slack");
  });

  it("connect() POSTs to auth.test with Bearer", async () => {
    const fetchFn = okFetch({ ok: true, team: "Nexus", user: "bot", bot_id: "B1" });
    const c = new SlackConnector({ token: "xoxb-test", fetch: fetchFn });
    await c.connect();
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("auth.test");
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer xoxb-test");
  });

  it("connect() returns team and user metadata", async () => {
    const c = new SlackConnector({ token: "t", fetch: okFetch({ ok: true, team: "Nexus", user: "bot" }) });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.team).toBe("Nexus");
  });

  it("connect() ok:false when Slack ok:false", async () => {
    const c = new SlackConnector({ token: "t", fetch: okFetch({ ok: false, error: "invalid_auth" }) });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_auth");
  });

  it("connect() ok:false on non-ok HTTP", async () => {
    const c = new SlackConnector({ token: "t", fetch: makeFetch([{ ok: false, status: 429 }]) });
    const result = await c.connect();
    expect(result.ok).toBe(false);
  });

  it("healthCheck() calls api.test", async () => {
    const fetchFn = okFetch({ ok: true });
    const c = new SlackConnector({ token: "t", fetch: fetchFn });
    const hc = await c.healthCheck();
    expect(hc.ok).toBe(true);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("api.test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GroqConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("GroqConnector", () => {
  it("has id 'groq'", () => {
    expect(new GroqConnector({ apiKey: "k", fetch: okFetch() }).id).toBe("groq");
  });

  it("connect() sends Bearer header to /models", async () => {
    const fetchFn = okFetch({ data: [{ id: "llama-3.1-8b-instant" }] });
    const c = new GroqConnector({ apiKey: "gsk_test", fetch: fetchFn });
    await c.connect();
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer gsk_test");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("/models");
  });

  it("connect() returns modelCount in metadata", async () => {
    const c = new GroqConnector({ apiKey: "k", fetch: okFetch({ data: [{ id: "m1" }, { id: "m2" }] }) });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.modelCount).toBe(2);
  });

  it("connect() ok:false on 401", async () => {
    const c = new GroqConnector({ apiKey: "bad", fetch: makeFetch([{ ok: false, status: 401 }]) });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid");
  });

  it("healthCheck() returns ok based on /models response", async () => {
    const c = new GroqConnector({ apiKey: "k", fetch: okFetch({ data: [] }) });
    const hc = await c.healthCheck();
    expect(hc.ok).toBe(true);
    expect(hc.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TavilyConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("TavilyConnector", () => {
  it("has id 'tavily'", () => {
    expect(new TavilyConnector({ apiKey: "k", fetch: okFetch() }).id).toBe("tavily");
  });

  it("connect() POSTs to /search with api_key in body", async () => {
    const fetchFn = okFetch({ results: [{ url: "https://example.com" }] });
    const c = new TavilyConnector({ apiKey: "tvly-test", fetch: fetchFn });
    await c.connect();
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("tavily.com/search");
    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string);
    expect(body.api_key).toBe("tvly-test");
  });

  it("connect() returns resultCount in metadata", async () => {
    const c = new TavilyConnector({ apiKey: "k", fetch: okFetch({ results: [{}] }) });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.resultCount).toBe(1);
  });

  it("connect() ok:false on 401", async () => {
    const c = new TavilyConnector({ apiKey: "bad", fetch: makeFetch([{ ok: false, status: 401 }]) });
    const result = await c.connect();
    expect(result.ok).toBe(false);
  });

  it("connect() ok:false on 403", async () => {
    const c = new TavilyConnector({ apiKey: "bad", fetch: makeFetch([{ ok: false, status: 403 }]) });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid");
  });

  it("healthCheck() returns ok:true on successful POST", async () => {
    const c = new TavilyConnector({ apiKey: "k", fetch: okFetch({ results: [] }) });
    const hc = await c.healthCheck();
    expect(hc.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NeonConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("NeonConnector", () => {
  const cfg = { endpoint: "https://ep-test.neon.tech", database: "neondb", user: "user", password: "pw" };

  it("has id 'neon'", () => {
    expect(new NeonConnector({ ...cfg, fetch: okFetch() }).id).toBe("neon");
  });

  it("connect() POSTs SELECT 1 to /sql endpoint", async () => {
    const fetchFn = okFetch({ rows: [{ ping: 1 }] });
    const c = new NeonConnector({ ...cfg, fetch: fetchFn });
    await c.connect();
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("/sql");
    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string);
    expect(body.query).toContain("SELECT 1");
  });

  it("connect() sends Basic auth header", async () => {
    const fetchFn = okFetch({ rows: [{ ping: 1 }] });
    const c = new NeonConnector({ ...cfg, fetch: fetchFn });
    await c.connect();
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^Basic /);
  });

  it("connect() ok:true when rows[0].ping === 1", async () => {
    const c = new NeonConnector({ ...cfg, fetch: okFetch({ rows: [{ ping: 1 }] }) });
    const result = await c.connect();
    expect(result.ok).toBe(true);
  });

  it("connect() ok:false on 401", async () => {
    const c = new NeonConnector({ ...cfg, fetch: makeFetch([{ ok: false, status: 401 }]) });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid");
  });

  it("connect() ok:false when ping response is unexpected", async () => {
    const c = new NeonConnector({ ...cfg, fetch: okFetch({ rows: [{ ping: 0 }] }) });
    const result = await c.connect();
    expect(result.ok).toBe(false);
  });

  it("healthCheck() runs the same ping and returns latencyMs", async () => {
    const c = new NeonConnector({ ...cfg, fetch: okFetch({ rows: [{ ping: 1 }] }) });
    const hc = await c.healthCheck();
    expect(hc.ok).toBe(true);
    expect(hc.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("trailing slash in endpoint is stripped", async () => {
    const fetchFn = okFetch({ rows: [{ ping: 1 }] });
    const c = new NeonConnector({ ...cfg, endpoint: "https://ep-test.neon.tech/", fetch: fetchFn });
    await c.connect();
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toContain("//sql");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LinearConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("LinearConnector", () => {
  it("has id 'linear'", () => {
    expect(new LinearConnector({ apiKey: "k", fetch: okFetch() }).id).toBe("linear");
  });

  it("connect() POSTs viewer GraphQL query", async () => {
    const fetchFn = okFetch({ data: { viewer: { id: "u1", name: "Yash", email: "y@n.com" } } });
    const c = new LinearConnector({ apiKey: "lin_key", fetch: fetchFn });
    await c.connect();
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("linear.app/graphql");
    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string);
    expect(body.query).toContain("viewer");
  });

  it("connect() returns viewer id, name, email in metadata", async () => {
    const c = new LinearConnector({
      apiKey: "k",
      fetch: okFetch({ data: { viewer: { id: "u1", name: "Yash", email: "y@n.com" } } }),
    });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.name).toBe("Yash");
  });

  it("connect() ok:false on 401", async () => {
    const c = new LinearConnector({ apiKey: "bad", fetch: makeFetch([{ ok: false, status: 401 }]) });
    const result = await c.connect();
    expect(result.ok).toBe(false);
  });

  it("connect() ok:false on GraphQL errors", async () => {
    const c = new LinearConnector({
      apiKey: "k",
      fetch: okFetch({ errors: [{ message: "Not authorized" }] }),
    });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Not authorized");
  });

  it("healthCheck() returns ok:true and latencyMs", async () => {
    const c = new LinearConnector({
      apiKey: "k",
      fetch: okFetch({ data: { viewer: { id: "u1" } } }),
    });
    const hc = await c.healthCheck();
    expect(hc.ok).toBe(true);
    expect(hc.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConnectorRegistry
// ─────────────────────────────────────────────────────────────────────────────

describe("ConnectorRegistry — registration", () => {
  let registry: ConnectorRegistry;

  beforeEach(() => {
    registry = new ConnectorRegistry();
  });

  it("register() adds a connector", () => {
    registry.register(new NullConnector("gh"));
    expect(registry.get("gh")).toBeDefined();
  });

  it("register() is chainable", () => {
    expect(registry.register(new NullConnector("a"))).toBe(registry);
  });

  it("register() throws ALREADY_REGISTERED on duplicate id", () => {
    registry.register(new NullConnector("gh"));
    let caught: ConnectorError | undefined;
    try { registry.register(new NullConnector("gh")); } catch (e) { caught = e as ConnectorError; }
    expect(caught?.code).toBe("ALREADY_REGISTERED");
  });

  it("unregister() removes a connector", () => {
    registry.register(new NullConnector("gh"));
    registry.unregister("gh");
    expect(registry.get("gh")).toBeUndefined();
  });

  it("unregister() throws NOT_FOUND for unknown id", () => {
    let caught: ConnectorError | undefined;
    try { registry.unregister("nope"); } catch (e) { caught = e as ConnectorError; }
    expect(caught?.code).toBe("NOT_FOUND");
  });

  it("list() returns all connectors", () => {
    registry.register(new NullConnector("a"));
    registry.register(new NullConnector("b"));
    expect(registry.list()).toHaveLength(2);
  });

  it("listByStatus() filters by status", () => {
    registry.register(new NullConnector("a")); // connected
    const b = new NullConnector("b");
    registry.register(b);
    (b as any).disable();
    expect(registry.listByStatus("connected")).toHaveLength(1);
    expect(registry.listByStatus("disabled")).toHaveLength(1);
  });

  it("clear() removes all connectors", () => {
    registry.register(new NullConnector("a"));
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });

  it("get() returns undefined for unknown id", () => {
    expect(registry.get("unknown")).toBeUndefined();
  });
});

describe("ConnectorRegistry — connectAll", () => {
  it("returns succeeded count for successful connectors", async () => {
    const registry = new ConnectorRegistry();
    registry.register(new NullConnector("a"));
    registry.register(new NullConnector("b"));
    const result = await registry.connectAll();
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("returns failed count when connector fails", async () => {
    const registry = new ConnectorRegistry();
    const bad = new NullConnector("bad");
    bad["_doConnect"] = async () => ({ ok: false, error: "auth" });
    registry.register(bad);
    const result = await registry.connectAll();
    expect(result.failed).toBe(1);
    expect(result.results["bad"]?.ok).toBe(false);
  });

  it("skips disabled connectors", async () => {
    const registry = new ConnectorRegistry();
    const c = new NullConnector("d");
    (c as any).disable();
    registry.register(c);
    const result = await registry.connectAll();
    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it("connectAll runs in parallel — all results present", async () => {
    const registry = new ConnectorRegistry();
    registry.register(new NullConnector("a"));
    registry.register(new NullConnector("b"));
    registry.register(new NullConnector("c"));
    const result = await registry.connectAll();
    expect(Object.keys(result.results)).toHaveLength(3);
  });
});

describe("ConnectorRegistry — healthCheckAll", () => {
  it("reports healthy count", async () => {
    const registry = new ConnectorRegistry();
    registry.register(new NullConnector("a"));
    registry.register(new NullConnector("b"));
    const result = await registry.healthCheckAll();
    expect(result.healthy).toBe(2);
    expect(result.unhealthy).toBe(0);
  });

  it("reports unhealthy when healthCheck fails", async () => {
    const registry = new ConnectorRegistry();
    const c = new NullConnector("bad");
    c["_doHealthCheck"] = async () => { throw new Error("timeout"); };
    registry.register(c);
    const result = await registry.healthCheckAll();
    expect(result.unhealthy).toBe(1);
    expect(result.results["bad"]?.ok).toBe(false);
  });

  it("returns latencyMs in each result", async () => {
    const registry = new ConnectorRegistry();
    registry.register(new NullConnector("a"));
    const result = await registry.healthCheckAll();
    expect(typeof result.results["a"]?.latencyMs).toBe("number");
  });
});

describe("ConnectorRegistry — disconnectAll", () => {
  it("disconnects all connectors", async () => {
    const registry = new ConnectorRegistry();
    const a = new NullConnector("a");
    const b = new NullConnector("b");
    registry.register(a);
    registry.register(b);
    await registry.disconnectAll();
    expect(a.status).toBe("disconnected");
    expect(b.status).toBe("disconnected");
  });
});
