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
  isDocumentConnector,
  BaseDocumentConnector,
  DocumentConnectorRegistry,
  GitHubDocumentConnector,
  SlackDocumentConnector,
  WebDocumentConnector,
  FileSystemDocumentConnector,
  LinearDocumentConnector,
  TavilyDocumentConnector,
  NeonDocumentConnector,
  RssDocumentConnector,
  NotionDocumentConnector,
  ConfluenceDocumentConnector,
  JiraDocumentConnector,
  GitLabDocumentConnector,
  HackerNewsDocumentConnector,
  type Connector,
  type FetchFn,
  type DocumentConnector,
  type SyncedDocument,
  type ReadFileFn,
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

const okFetch = (body: unknown = { ok: true }) => makeFetch([{ ok: true, body }]);

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
    c["_doConnect"] = async () => {
      throw new Error("crash");
    };
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
    c["_doHealthCheck"] = async () => {
      throw new Error("timeout");
    };
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
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
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
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer xoxb-test");
  });

  it("connect() returns team and user metadata", async () => {
    const c = new SlackConnector({
      token: "t",
      fetch: okFetch({ ok: true, team: "Nexus", user: "bot" }),
    });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.team).toBe("Nexus");
  });

  it("connect() ok:false when Slack ok:false", async () => {
    const c = new SlackConnector({
      token: "t",
      fetch: okFetch({ ok: false, error: "invalid_auth" }),
    });
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
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer gsk_test");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("/models");
  });

  it("connect() returns modelCount in metadata", async () => {
    const c = new GroqConnector({
      apiKey: "k",
      fetch: okFetch({ data: [{ id: "m1" }, { id: "m2" }] }),
    });
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
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.api_key).toBe("tvly-test");
  });

  it("connect() returns resultCount in metadata", async () => {
    const c = new TavilyConnector({ apiKey: "k", fetch: okFetch({ results: [{}] }) });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.resultCount).toBe(1);
  });

  it("connect() ok:false on 401", async () => {
    const c = new TavilyConnector({
      apiKey: "bad",
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    const result = await c.connect();
    expect(result.ok).toBe(false);
  });

  it("connect() ok:false on 403", async () => {
    const c = new TavilyConnector({
      apiKey: "bad",
      fetch: makeFetch([{ ok: false, status: 403 }]),
    });
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
  const cfg = {
    endpoint: "https://ep-test.neon.tech",
    database: "neondb",
    user: "user",
    password: "pw",
  };

  it("has id 'neon'", () => {
    expect(new NeonConnector({ ...cfg, fetch: okFetch() }).id).toBe("neon");
  });

  it("connect() POSTs SELECT 1 to /sql endpoint", async () => {
    const fetchFn = okFetch({ rows: [{ ping: 1 }] });
    const c = new NeonConnector({ ...cfg, fetch: fetchFn });
    await c.connect();
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("/sql");
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.query).toContain("SELECT 1");
  });

  it("connect() sends Basic auth header", async () => {
    const fetchFn = okFetch({ rows: [{ ping: 1 }] });
    const c = new NeonConnector({ ...cfg, fetch: fetchFn });
    await c.connect();
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
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
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
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
    const c = new LinearConnector({
      apiKey: "bad",
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
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
    try {
      registry.register(new NullConnector("gh"));
    } catch (e) {
      caught = e as ConnectorError;
    }
    expect(caught?.code).toBe("ALREADY_REGISTERED");
  });

  it("unregister() removes a connector", () => {
    registry.register(new NullConnector("gh"));
    registry.unregister("gh");
    expect(registry.get("gh")).toBeUndefined();
  });

  it("unregister() throws NOT_FOUND for unknown id", () => {
    let caught: ConnectorError | undefined;
    try {
      registry.unregister("nope");
    } catch (e) {
      caught = e as ConnectorError;
    }
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
    c["_doHealthCheck"] = async () => {
      throw new Error("timeout");
    };
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

// ─────────────────────────────────────────────────────────────────────────────
// Document sync layer helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch returning text() instead of json() — for WebDocumentConnector */
function makeTextFetch(
  responses: Array<{ ok: boolean; status?: number; textBody?: string }>,
): FetchFn {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx++] ?? { ok: true, textBody: "" };
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => ({}),
      text: async () => r.textBody ?? "",
    } as Response;
  });
}

/** Minimal concrete document connector for testing BaseDocumentConnector */
class NullDocumentConnector extends BaseDocumentConnector {
  readonly id: string;
  readonly name: string;
  private readonly _docs: SyncedDocument[];

  constructor(id: string, docs: SyncedDocument[] = []) {
    super();
    this.id = id;
    this.name = `Null (${id})`;
    this._docs = docs;
    this._status = "connected";
  }

  protected async _doConnect() {
    return { ok: true };
  }
  protected async _doHealthCheck() {
    return { ok: true };
  }
  protected async *_doSync(): AsyncIterable<SyncedDocument> {
    for (const doc of this._docs) yield doc;
  }
}

function makeDoc(overrides: Partial<SyncedDocument> = {}): SyncedDocument {
  return {
    id: "test::https://example.com",
    title: "Test Doc",
    content: "Hello world",
    sourceUrl: "https://example.com",
    connectorId: "test",
    syncedAt: Date.now(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// isDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("isDocumentConnector", () => {
  it("returns true for a DocumentConnector", () => {
    const c = new NullDocumentConnector("x");
    expect(isDocumentConnector(c)).toBe(true);
  });

  it("returns false for a plain Connector", () => {
    const c = new NullConnector("plain");
    expect(isDocumentConnector(c)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BaseDocumentConnector (via NullDocumentConnector)
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseDocumentConnector", () => {
  it("sync() is an async iterable", () => {
    const c = new NullDocumentConnector("x");
    const iter = c.sync();
    expect(typeof iter[Symbol.asyncIterator]).toBe("function");
  });

  it("sync() yields all documents from _doSync", async () => {
    const doc = makeDoc();
    const c = new NullDocumentConnector("x", [doc]);
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(doc.id);
  });

  it("sync() yields nothing when _doSync is empty", async () => {
    const c = new NullDocumentConnector("empty");
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GitHubDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHubDocumentConnector", () => {
  const cfg = { token: "ghp_test", owner: "octocat", repo: "hello" };

  it("has id containing owner/repo", () => {
    const c = new GitHubDocumentConnector({ ...cfg, fetch: okFetch() });
    expect(c.id).toContain("octocat/hello");
  });

  it("connect() sends Bearer to /user and returns ok:true", async () => {
    const fetchFn = okFetch({ login: "octocat", id: 1 });
    const c = new GitHubDocumentConnector({ ...cfg, fetch: fetchFn });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.login).toBe("octocat");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("/user");
  });

  it("connect() ok:false on 401", async () => {
    const c = new GitHubDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid or expired");
  });

  it("connect() ok:false on 5xx", async () => {
    const c = new GitHubDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 503 }]),
    });
    const result = await c.connect();
    expect(result.ok).toBe(false);
  });

  it("healthCheck() hits /rate_limit", async () => {
    const fetchFn = okFetch({ rate: { remaining: 4999, limit: 5000 } });
    const c = new GitHubDocumentConnector({ ...cfg, fetch: fetchFn });
    const hc = await c.healthCheck();
    expect(hc.ok).toBe(true);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("rate_limit");
  });

  it("sync() yields one doc per issue", async () => {
    const issues = [
      {
        number: 1,
        title: "Bug A",
        body: "Details",
        html_url: "https://github.com/o/r/issues/1",
        updated_at: "2024-01-01T00:00:00Z",
        state: "open",
      },
      {
        number: 2,
        title: "PR B",
        body: "PR body",
        html_url: "https://github.com/o/r/pull/2",
        updated_at: "2024-01-02T00:00:00Z",
        state: "open",
        pull_request: {},
      },
    ];
    const c = new GitHubDocumentConnector({ ...cfg, fetch: okFetch(issues) });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.title).toContain("Issue #1");
    expect(docs[1]!.title).toContain("PR #2");
    expect(docs[0]!.metadata?.type).toBe("Issue");
    expect(docs[1]!.metadata?.type).toBe("PR");
  });

  it("sync() filters by since timestamp", async () => {
    const issues = [
      {
        number: 1,
        title: "Old",
        body: "",
        html_url: "https://github.com/o/r/issues/1",
        updated_at: "2020-01-01T00:00:00Z",
        state: "open",
      },
      {
        number: 2,
        title: "New",
        body: "",
        html_url: "https://github.com/o/r/issues/2",
        updated_at: "2024-06-01T00:00:00Z",
        state: "open",
      },
    ];
    const c = new GitHubDocumentConnector({ ...cfg, fetch: okFetch(issues) });
    const since = new Date("2023-01-01").getTime();
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync({ since })) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toContain("New");
  });

  it("sync() filters by query text", async () => {
    const issues = [
      {
        number: 1,
        title: "crash bug",
        body: "",
        html_url: "https://github.com/o/r/issues/1",
        updated_at: "2024-01-01T00:00:00Z",
        state: "open",
      },
      {
        number: 2,
        title: "feature request",
        body: "",
        html_url: "https://github.com/o/r/issues/2",
        updated_at: "2024-01-02T00:00:00Z",
        state: "open",
      },
    ];
    const c = new GitHubDocumentConnector({ ...cfg, fetch: okFetch(issues) });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync({ query: "crash" })) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toContain("crash");
  });

  it("sync() returns nothing when HTTP response is not ok", async () => {
    const c = new GitHubDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 403 }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SlackDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("SlackDocumentConnector", () => {
  const cfg = { token: "xoxb-test", channelId: "C0TEST123" };

  it("has id containing channelId", () => {
    const c = new SlackDocumentConnector({ ...cfg, fetch: okFetch() });
    expect(c.id).toContain("C0TEST123");
  });

  it("connect() uses auth.test and returns team metadata", async () => {
    const fetchFn = okFetch({ ok: true, team: "Nexus", user: "bot" });
    const c = new SlackDocumentConnector({ ...cfg, fetch: fetchFn });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.team).toBe("Nexus");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("auth.test");
  });

  it("connect() ok:false when Slack returns ok:false", async () => {
    const c = new SlackDocumentConnector({
      ...cfg,
      fetch: okFetch({ ok: false, error: "invalid_auth" }),
    });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_auth");
  });

  it("sync() yields one doc per message", async () => {
    const body = {
      ok: true,
      messages: [
        { ts: "1700000000.000001", text: "Hello there", user: "U1" },
        { ts: "1700000001.000002", text: "World", user: "U2" },
      ],
    };
    const c = new SlackDocumentConnector({ ...cfg, fetch: okFetch(body) });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.content).toBe("Hello there");
    expect(docs[0]!.metadata?.user).toBe("U1");
  });

  it("sync() sends oldest param when since is provided", async () => {
    const fetchFn = okFetch({ ok: true, messages: [] });
    const c = new SlackDocumentConnector({ ...cfg, fetch: fetchFn });
    const since = 1700000000000; // ms
    for await (const _ of c.sync({ since })) {
      /* drain */
    }
    const calledUrl = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(calledUrl).toContain("oldest=1700000000");
  });

  it("sync() yields nothing when Slack ok:false in history response", async () => {
    const c = new SlackDocumentConnector({ ...cfg, fetch: okFetch({ ok: false, messages: [] }) });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });

  it("sync() yields nothing on non-ok HTTP response", async () => {
    const c = new SlackDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 429 }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WebDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("WebDocumentConnector", () => {
  it("has id 'web-doc'", () => {
    const c = new WebDocumentConnector({ urls: [], fetch: makeTextFetch([]) });
    expect(c.id).toBe("web-doc");
  });

  it("connect() ok:true with zero urls (no fetch call)", async () => {
    const fetchFn = makeTextFetch([]);
    const c = new WebDocumentConnector({ urls: [], fetch: fetchFn });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.urlCount).toBe(0);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("connect() ok:true when first URL returns 200", async () => {
    const c = new WebDocumentConnector({
      urls: ["https://example.com"],
      fetch: makeTextFetch([{ ok: true, textBody: "<h1>Hello</h1>" }]),
    });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.urlCount).toBe(1);
  });

  it("connect() ok:false when fetchFn throws", async () => {
    const throwFetch: FetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const c = new WebDocumentConnector({ urls: ["https://unreachable.test"], fetch: throwFetch });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("sync() yields one doc per URL", async () => {
    const fetchFn = makeTextFetch([
      { ok: true, textBody: "Page one content" },
      { ok: true, textBody: "Page two content" },
    ]);
    const c = new WebDocumentConnector({
      urls: ["https://a.com", "https://b.com"],
      fetch: fetchFn,
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.content).toBe("Page one content");
    expect(docs[0]!.sourceUrl).toBe("https://a.com");
    expect(docs[1]!.sourceUrl).toBe("https://b.com");
  });

  it("sync() respects limit option", async () => {
    const fetchFn = makeTextFetch([
      { ok: true, textBody: "A" },
      { ok: true, textBody: "B" },
    ]);
    const c = new WebDocumentConnector({
      urls: ["https://a.com", "https://b.com", "https://c.com"],
      fetch: fetchFn,
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync({ limit: 1 })) docs.push(d);
    expect(docs).toHaveLength(1);
  });

  it("sync() filters by query", async () => {
    const fetchFn = makeTextFetch([
      { ok: true, textBody: "nexus platform rocks" },
      { ok: true, textBody: "irrelevant content here" },
    ]);
    const c = new WebDocumentConnector({
      urls: ["https://a.com", "https://b.com"],
      fetch: fetchFn,
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync({ query: "nexus" })) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.sourceUrl).toBe("https://a.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FileSystemDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("FileSystemDocumentConnector", () => {
  it("has id 'fs-doc'", () => {
    const c = new FileSystemDocumentConnector({ paths: [] });
    expect(c.id).toBe("fs-doc");
  });

  it("connect() always returns ok:true with pathCount", async () => {
    const c = new FileSystemDocumentConnector({ paths: ["/a.md", "/b.md"] });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.pathCount).toBe(2);
  });

  it("sync() yields one doc per path using injectable readFile", async () => {
    const readFile: ReadFileFn = vi.fn(async (p: string) => `Content of ${p}`);
    const c = new FileSystemDocumentConnector({
      paths: ["/docs/readme.md", "/docs/guide.txt"],
      readFile,
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.content).toBe("Content of /docs/readme.md");
    expect(docs[0]!.title).toBe("readme.md");
    expect(docs[1]!.title).toBe("guide.txt");
  });

  it("sync() skips files that throw on read", async () => {
    const readFile: ReadFileFn = vi.fn(async (p: string) => {
      if (p.includes("missing")) throw new Error("ENOENT");
      return `Content of ${p}`;
    });
    const c = new FileSystemDocumentConnector({
      paths: ["/docs/exists.md", "/docs/missing.md"],
      readFile,
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.sourceUrl).toBe("/docs/exists.md");
  });

  it("sync() filters by query", async () => {
    const readFile: ReadFileFn = vi.fn(async (p: string) =>
      p.includes("match") ? "this contains nexus keyword" : "unrelated text",
    );
    const c = new FileSystemDocumentConnector({
      paths: ["/match.md", "/other.md"],
      readFile,
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync({ query: "nexus" })) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.sourceUrl).toBe("/match.md");
  });

  it("sync() respects limit", async () => {
    const readFile: ReadFileFn = vi.fn(async (p: string) => `Content of ${p}`);
    const c = new FileSystemDocumentConnector({
      paths: ["/a.md", "/b.md", "/c.md"],
      readFile,
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync({ limit: 2 })) docs.push(d);
    expect(docs).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LinearDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("LinearDocumentConnector", () => {
  it("has id 'linear-doc'", () => {
    expect(new LinearDocumentConnector({ apiKey: "k", fetch: okFetch() }).id).toBe("linear-doc");
  });

  it("connect() sends viewer GraphQL query", async () => {
    const fetchFn = okFetch({ data: { viewer: { id: "u1", name: "Yash" } } });
    const c = new LinearDocumentConnector({ apiKey: "lin_k", fetch: fetchFn });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.viewer).toBe("Yash");
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.query).toContain("viewer");
  });

  it("connect() ok:false on 401", async () => {
    const c = new LinearDocumentConnector({
      apiKey: "bad",
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid");
  });

  it("sync() yields one doc per issue", async () => {
    const body = {
      data: {
        issues: {
          nodes: [
            {
              id: "i1",
              title: "Fix crash",
              description: "Crash on load",
              url: "https://linear.app/t/i1",
              updatedAt: "2024-01-01T00:00:00Z",
              state: { name: "In Progress" },
            },
            {
              id: "i2",
              title: "Add feature",
              description: "",
              url: "https://linear.app/t/i2",
              updatedAt: "2024-01-02T00:00:00Z",
              state: { name: "Todo" },
            },
          ],
        },
      },
    };
    const c = new LinearDocumentConnector({ apiKey: "k", fetch: okFetch(body) });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.title).toBe("Fix crash");
    expect(docs[0]!.content).toBe("Crash on load");
    expect(docs[0]!.metadata?.state).toBe("In Progress");
  });

  it("sync() includes teamId in GraphQL filter when set", async () => {
    const fetchFn = okFetch({ data: { issues: { nodes: [] } } });
    const c = new LinearDocumentConnector({ apiKey: "k", teamId: "TEAM123", fetch: fetchFn });
    for await (const _ of c.sync()) {
      /* drain */
    }
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.query).toContain("TEAM123");
  });

  it("sync() filters by since timestamp", async () => {
    const body = {
      data: {
        issues: {
          nodes: [
            {
              id: "old",
              title: "Old issue",
              description: "",
              url: "https://linear.app/t/old",
              updatedAt: "2020-01-01T00:00:00Z",
              state: { name: "Done" },
            },
            {
              id: "new",
              title: "New issue",
              description: "",
              url: "https://linear.app/t/new",
              updatedAt: "2024-06-01T00:00:00Z",
              state: { name: "Open" },
            },
          ],
        },
      },
    };
    const c = new LinearDocumentConnector({ apiKey: "k", fetch: okFetch(body) });
    const since = new Date("2023-01-01").getTime();
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync({ since })) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("New issue");
  });

  it("sync() returns nothing on non-ok HTTP response", async () => {
    const c = new LinearDocumentConnector({
      apiKey: "k",
      fetch: makeFetch([{ ok: false, status: 500 }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TavilyDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("TavilyDocumentConnector", () => {
  it("has id 'tavily-doc'", () => {
    expect(new TavilyDocumentConnector({ apiKey: "k", queries: [], fetch: okFetch() }).id).toBe(
      "tavily-doc",
    );
  });

  it("connect() ok:false on 401", async () => {
    const c = new TavilyDocumentConnector({
      apiKey: "bad",
      queries: ["test"],
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    const result = await c.connect();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid");
  });

  it("connect() ok:false on 403", async () => {
    const c = new TavilyDocumentConnector({
      apiKey: "bad",
      queries: ["test"],
      fetch: makeFetch([{ ok: false, status: 403 }]),
    });
    const result = await c.connect();
    expect(result.ok).toBe(false);
  });

  it("connect() ok:true with queryCount in metadata", async () => {
    const c = new TavilyDocumentConnector({
      apiKey: "tvly-k",
      queries: ["nexus", "agents"],
      fetch: okFetch({ results: [] }),
    });
    const result = await c.connect();
    expect(result.ok).toBe(true);
    expect(result.metadata?.queryCount).toBe(2);
  });

  it("sync() yields results from each query", async () => {
    const fetchFn = makeFetch([
      {
        ok: true,
        body: {
          results: [
            { title: "R1", url: "https://r1.com", content: "About nexus" },
            { title: "R2", url: "https://r2.com", content: "More nexus" },
          ],
        },
      },
      {
        ok: true,
        body: { results: [{ title: "R3", url: "https://r3.com", content: "About agents" }] },
      },
    ]);
    const c = new TavilyDocumentConnector({
      apiKey: "k",
      queries: ["nexus", "agents"],
      fetch: fetchFn,
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(3);
    expect(docs[0]!.metadata?.query).toBe("nexus");
    expect(docs[2]!.metadata?.query).toBe("agents");
  });

  it("sync() respects hard limit across queries", async () => {
    const fetchFn = makeFetch([
      {
        ok: true,
        body: {
          results: [
            { title: "A", url: "https://a.com", content: "a" },
            { title: "B", url: "https://b.com", content: "b" },
          ],
        },
      },
      { ok: true, body: { results: [{ title: "C", url: "https://c.com", content: "c" }] } },
    ]);
    const c = new TavilyDocumentConnector({ apiKey: "k", queries: ["q1", "q2"], fetch: fetchFn });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync({ limit: 2 })) docs.push(d);
    expect(docs).toHaveLength(2);
  });

  it("sync() continues to next query when one fails", async () => {
    const fetchFn = makeFetch([
      { ok: false, status: 500 },
      { ok: true, body: { results: [{ title: "R1", url: "https://r1.com", content: "content" }] } },
    ]);
    const c = new TavilyDocumentConnector({
      apiKey: "k",
      queries: ["bad", "good"],
      fetch: fetchFn,
    });
    const docs: SyncedDocument[] = [];
    for await (const d of c.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.metadata?.query).toBe("good");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DocumentConnectorRegistry
// ─────────────────────────────────────────────────────────────────────────────

describe("DocumentConnectorRegistry", () => {
  it("getDocumentConnectors() returns only document connectors", () => {
    const reg = new DocumentConnectorRegistry();
    reg.register(new NullConnector("plain"));
    reg.register(new NullDocumentConnector("doc-a"));
    reg.register(new NullDocumentConnector("doc-b"));
    const docConnectors = reg.getDocumentConnectors();
    expect(docConnectors).toHaveLength(2);
    expect(docConnectors.every((c) => isDocumentConnector(c))).toBe(true);
  });

  it("getDocumentConnectors() returns empty array when none registered", () => {
    const reg = new DocumentConnectorRegistry();
    reg.register(new NullConnector("plain"));
    expect(reg.getDocumentConnectors()).toHaveLength(0);
  });

  it("syncAll() collects docs from all document connectors", async () => {
    const reg = new DocumentConnectorRegistry();
    reg.register(
      new NullDocumentConnector("a", [
        makeDoc({ id: "a::1", title: "A1" }),
        makeDoc({ id: "a::2", title: "A2" }),
      ]),
    );
    reg.register(new NullDocumentConnector("b", [makeDoc({ id: "b::1", title: "B1" })]));
    const docs = await reg.syncAll();
    expect(docs).toHaveLength(3);
  });

  it("syncAll() skips plain connectors", async () => {
    const reg = new DocumentConnectorRegistry();
    reg.register(new NullConnector("plain"));
    reg.register(new NullDocumentConnector("doc", [makeDoc({ id: "d::1" })]));
    const docs = await reg.syncAll();
    expect(docs).toHaveLength(1);
  });

  it("syncAll() returns empty array when registry is empty", async () => {
    const reg = new DocumentConnectorRegistry();
    const docs = await reg.syncAll();
    expect(docs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NeonDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

function makeNeonFetch(rows: Record<string, unknown>[], ok = true): FetchFn {
  return makeFetch([{ ok: true }, { ok, body: { rows } }, { ok, body: { rows } }]);
}

describe("NeonDocumentConnector — connect", () => {
  const cfg = {
    endpointUrl: "https://neon.example.com/sql",
    user: "u",
    password: "p",
    query: "SELECT * FROM docs",
  };

  it("returns ok:true on 200", async () => {
    const conn = new NeonDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: true, body: { rows: [] } }]),
    });
    const r = await conn.connect();
    expect(r.ok).toBe(true);
  });

  it("returns ok:false on 401", async () => {
    const conn = new NeonDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    const r = await conn.connect();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/auth/i);
  });

  it("returns ok:false on 500", async () => {
    const conn = new NeonDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 500 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });
});

describe("NeonDocumentConnector — sync", () => {
  const cfg = {
    endpointUrl: "https://neon.example.com/sql",
    user: "u",
    password: "p",
    query: "SELECT * FROM docs",
  };

  it("yields one SyncedDocument per row", async () => {
    const rows = [
      { id: "1", title: "Doc 1", content: "Hello", url: "https://ex.com/1" },
      { id: "2", title: "Doc 2", content: "World", url: "https://ex.com/2" },
    ];
    const conn = new NeonDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: true, body: { rows } }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.title).toBe("Doc 1");
    expect(docs[1]?.content).toBe("World");
  });

  it("uses row id as title when title column is absent", async () => {
    const rows = [{ id: "row-1", url: "https://ex.com/r" }];
    const conn = new NeonDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: true, body: { rows } }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs[0]?.title).toBe("row-1");
  });

  it("respects limit option", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, url: `u${i}` }));
    const conn = new NeonDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: true, body: { rows } }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 3 })) docs.push(d);
    expect(docs).toHaveLength(3);
  });

  it("yields nothing on failed API call", async () => {
    const conn = new NeonDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 500 }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });

  it("connector id is 'neon-doc'", () => {
    expect(new NeonDocumentConnector(cfg).id).toBe("neon-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new NeonDocumentConnector(cfg))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RssDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <item>
    <title>Article One</title>
    <link>https://example.com/1</link>
    <description>First article content</description>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Article Two</title>
    <link>https://example.com/2</link>
    <description>Second article</description>
  </item>
</channel></rss>`;

function makeRssFetch(xml: string, ok = true): FetchFn {
  const r = {
    ok,
    status: ok ? 200 : 404,
    json: async () => ({}),
    text: async () => xml,
  } as unknown as Response;
  return vi.fn().mockResolvedValue(r);
}

describe("RssDocumentConnector — connect", () => {
  it("returns ok:true for valid RSS feed", async () => {
    const conn = new RssDocumentConnector({
      feedUrl: "https://feed.example.com/rss",
      fetch: makeRssFetch(SAMPLE_RSS),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("returns ok:false when response is not ok", async () => {
    const conn = new RssDocumentConnector({
      feedUrl: "https://feed.example.com/rss",
      fetch: makeRssFetch("", false),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("returns ok:false when content is not XML feed", async () => {
    const conn = new RssDocumentConnector({
      feedUrl: "https://x.com/",
      fetch: makeRssFetch("<html><body>not a feed</body></html>"),
    });
    const r = await conn.connect();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/feed/i);
  });
});

describe("RssDocumentConnector — sync", () => {
  it("yields one document per RSS item", async () => {
    const conn = new RssDocumentConnector({
      feedUrl: "https://feed.example.com/rss",
      fetch: makeRssFetch(SAMPLE_RSS),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.title).toBe("Article One");
    expect(docs[0]?.content).toBe("First article content");
    expect(docs[0]?.sourceUrl).toBe("https://example.com/1");
  });

  it("respects limit", async () => {
    const conn = new RssDocumentConnector({
      feedUrl: "https://feed.example.com/rss",
      fetch: makeRssFetch(SAMPLE_RSS),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 1 })) docs.push(d);
    expect(docs).toHaveLength(1);
  });

  it("yields nothing on failed fetch", async () => {
    const conn = new RssDocumentConnector({
      feedUrl: "https://feed.example.com/rss",
      fetch: makeRssFetch("", false),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });

  it("skips items without a link", async () => {
    const xml = `<rss><channel><item><title>No Link</title><description>x</description></item></channel></rss>`;
    const conn = new RssDocumentConnector({
      feedUrl: "https://feed.example.com/rss",
      fetch: makeRssFetch(xml),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });

  it("id includes connector id and article url", () => {
    const conn = new RssDocumentConnector({ feedUrl: "https://feed.example.com/rss" });
    expect(conn.id).toContain("rss-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new RssDocumentConnector({ feedUrl: "https://x.com/rss" }))).toBe(
      true,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NotionDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

function makeNotionPage(id: string, title: string) {
  return {
    id,
    url: `https://notion.so/${id}`,
    last_edited_time: "2024-01-01",
    properties: { Name: { type: "title", title: [{ plain_text: title }] } },
  };
}

describe("NotionDocumentConnector — connect", () => {
  const cfg = { token: "secret_abc", databaseId: "db-123" };

  it("returns ok:true on success", async () => {
    const conn = new NotionDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: true, body: { type: "bot" } }]),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("returns ok:false on 401", async () => {
    const conn = new NotionDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    const r = await conn.connect();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/token/i);
  });
});

describe("NotionDocumentConnector — sync", () => {
  const cfg = { token: "secret_abc", databaseId: "db-123" };

  it("yields one document per page", async () => {
    const body = {
      results: [makeNotionPage("p1", "Page One"), makeNotionPage("p2", "Page Two")],
      has_more: false,
    };
    const conn = new NotionDocumentConnector({ ...cfg, fetch: makeFetch([{ ok: true, body }]) });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.title).toBe("Page One");
    expect(docs[1]?.title).toBe("Page Two");
  });

  it("respects limit", async () => {
    const body = {
      results: [makeNotionPage("p1", "A"), makeNotionPage("p2", "B"), makeNotionPage("p3", "C")],
      has_more: false,
    };
    const conn = new NotionDocumentConnector({ ...cfg, fetch: makeFetch([{ ok: true, body }]) });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 2 })) docs.push(d);
    expect(docs).toHaveLength(2);
  });

  it("yields nothing on failed API call", async () => {
    const conn = new NotionDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 500 }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });

  it("connectorId on docs is the connector id", async () => {
    const body = { results: [makeNotionPage("p1", "P")], has_more: false };
    const conn = new NotionDocumentConnector({ ...cfg, fetch: makeFetch([{ ok: true, body }]) });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs[0]?.connectorId).toContain("notion-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new NotionDocumentConnector(cfg))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConfluenceDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("ConfluenceDocumentConnector — connect", () => {
  const cfg = {
    baseUrl: "https://team.atlassian.net",
    email: "a@b.com",
    apiToken: "tok",
    spaceKey: "ENG",
  };

  it("returns ok:true on success", async () => {
    const conn = new ConfluenceDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: true, body: { displayName: "Alice" } }]),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("returns ok:false on 401", async () => {
    const conn = new ConfluenceDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    const r = await conn.connect();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/credential/i);
  });
});

describe("ConfluenceDocumentConnector — sync", () => {
  const cfg = {
    baseUrl: "https://team.atlassian.net",
    email: "a@b.com",
    apiToken: "tok",
    spaceKey: "ENG",
  };

  it("yields one document per page", async () => {
    const body = {
      results: [
        {
          id: "111",
          title: "Setup Guide",
          body: { storage: { value: "<p>Hello</p>" } },
          _links: { webui: "/pages/111" },
        },
        {
          id: "222",
          title: "API Docs",
          body: { storage: { value: "<p>World</p>" } },
          _links: { webui: "/pages/222" },
        },
      ],
    };
    const conn = new ConfluenceDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: true, body }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.title).toBe("Setup Guide");
    expect(docs[0]?.content).toBe("<p>Hello</p>");
  });

  it("respects limit", async () => {
    const body = {
      results: Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        title: `Page ${i}`,
        body: { storage: { value: "" } },
      })),
    };
    const conn = new ConfluenceDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: true, body }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 2 })) docs.push(d);
    expect(docs).toHaveLength(2);
  });

  it("yields nothing on failed fetch", async () => {
    const conn = new ConfluenceDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 500 }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new ConfluenceDocumentConnector(cfg))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JiraDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("JiraDocumentConnector — connect", () => {
  const cfg = { baseUrl: "https://team.atlassian.net", email: "a@b.com", apiToken: "tok" };

  it("returns ok:true on success", async () => {
    const conn = new JiraDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: true, body: { displayName: "Alice" } }]),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("returns ok:false on 401", async () => {
    const conn = new JiraDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    const r = await conn.connect();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/credential/i);
  });
});

describe("JiraDocumentConnector — sync", () => {
  const cfg = { baseUrl: "https://team.atlassian.net", email: "a@b.com", apiToken: "tok" };

  it("yields one document per issue", async () => {
    const body = {
      issues: [
        {
          key: "ENG-1",
          fields: { summary: "Fix bug", description: null, status: { name: "Open" } },
        },
        {
          key: "ENG-2",
          fields: { summary: "Add feature", description: null, status: { name: "In Progress" } },
        },
      ],
      total: 2,
    };
    const conn = new JiraDocumentConnector({ ...cfg, fetch: makeFetch([{ ok: true, body }]) });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.title).toContain("ENG-1");
    expect(docs[0]?.title).toContain("Fix bug");
  });

  it("respects limit", async () => {
    const body = {
      issues: Array.from({ length: 10 }, (_, i) => ({
        key: `ENG-${i}`,
        fields: { summary: `Issue ${i}`, status: { name: "Open" } },
      })),
      total: 10,
    };
    const conn = new JiraDocumentConnector({ ...cfg, fetch: makeFetch([{ ok: true, body }]) });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 3 })) docs.push(d);
    expect(docs).toHaveLength(3);
  });

  it("yields nothing on failed fetch", async () => {
    const conn = new JiraDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 403 }]),
    });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });

  it("sourceUrl points to browse URL", async () => {
    const body = { issues: [{ key: "ENG-42", fields: { summary: "Test" } }], total: 1 };
    const conn = new JiraDocumentConnector({ ...cfg, fetch: makeFetch([{ ok: true, body }]) });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs[0]?.sourceUrl).toContain("/browse/ENG-42");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new JiraDocumentConnector(cfg))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GitLabDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("GitLabDocumentConnector — connect", () => {
  const cfg = { token: "glpat-abc", projectId: "123" };

  it("returns ok:true on success", async () => {
    const conn = new GitLabDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: true, body: { username: "yash" } }]),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("returns ok:false on 401", async () => {
    const conn = new GitLabDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    const r = await conn.connect();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/token/i);
  });
});

describe("GitLabDocumentConnector — sync", () => {
  const cfg = { token: "glpat-abc", projectId: "123" };

  it("yields issues by default (syncType=both syncs issues + MRs)", async () => {
    const issueBody = [
      {
        iid: 1,
        title: "Bug fix",
        description: "desc",
        web_url: "https://gitlab.com/p/issues/1",
        state: "opened",
      },
    ];
    const mrBody = [
      {
        iid: 1,
        title: "MR: add feature",
        description: "",
        web_url: "https://gitlab.com/p/mr/1",
        state: "opened",
      },
    ];
    // 2 endpoint calls: issues (returns 1 item + no next-page), merge_requests (returns 1 item + no next-page)
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => issueBody,
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mrBody,
        headers: { get: () => null },
      } as unknown as Response);
    const conn = new GitLabDocumentConnector({ ...cfg, fetch: fetchFn });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.title).toContain("Issue");
    expect(docs[1]?.title).toContain("MR");
  });

  it("respects syncType=issues", async () => {
    const issueBody = [
      {
        iid: 1,
        title: "Bug",
        description: "",
        web_url: "https://gitlab.com/p/issues/1",
        state: "opened",
      },
    ];
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => issueBody,
      headers: { get: () => null },
    } as unknown as Response);
    const conn = new GitLabDocumentConnector({ ...cfg, syncType: "issues", fetch: fetchFn });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(docs).toHaveLength(1);
  });

  it("respects limit across endpoints", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      iid: i,
      title: `Item ${i}`,
      description: "",
      web_url: `https://gl.com/${i}`,
      state: "opened",
    }));
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => items,
      headers: { get: () => null },
    } as unknown as Response);
    const conn = new GitLabDocumentConnector({ ...cfg, fetch: fetchFn });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 3 })) docs.push(d);
    expect(docs.length).toBeLessThanOrEqual(3);
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new GitLabDocumentConnector(cfg))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HackerNewsDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("HackerNewsDocumentConnector — connect", () => {
  it("returns ok:true when list endpoint responds", async () => {
    const fetch = makeFetch([{ ok: true, body: [1, 2, 3] }]);
    const conn = new HackerNewsDocumentConnector({ fetch });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("returns ok:false when list endpoint fails", async () => {
    const fetch = makeFetch([{ ok: false, status: 503 }]);
    const conn = new HackerNewsDocumentConnector({ fetch });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("metadata includes storyType", async () => {
    const fetch = makeFetch([{ ok: true, body: [] }]);
    const conn = new HackerNewsDocumentConnector({ storyType: "beststories", fetch });
    const r = await conn.connect();
    expect(r.metadata?.storyType).toBe("beststories");
  });
});

describe("HackerNewsDocumentConnector — sync", () => {
  function makeHnFetch(ids: number[], items: Record<string, unknown>[]): FetchFn {
    let call = 0;
    return vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (
        urlStr.includes("topstories") ||
        urlStr.includes("beststories") ||
        urlStr.includes("newstories")
      ) {
        return { ok: true, status: 200, json: async () => ids } as unknown as Response;
      }
      const item = items[call++] ?? { id: 999, title: "Item" };
      return { ok: true, status: 200, json: async () => item } as unknown as Response;
    });
  }

  it("yields one document per story id (up to default limit)", async () => {
    const ids = [1, 2, 3];
    const items = ids.map((id) => ({
      id,
      title: `Story ${id}`,
      url: `https://ex.com/${id}`,
      by: "user",
      score: 100,
    }));
    const conn = new HackerNewsDocumentConnector({ fetch: makeHnFetch(ids, items) });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 3 })) docs.push(d);
    expect(docs).toHaveLength(3);
    expect(docs[0]?.title).toBe("Story 1");
  });

  it("respects limit", async () => {
    const ids = [1, 2, 3, 4, 5];
    const items = ids.map((id) => ({ id, title: `S${id}`, url: `https://ex.com/${id}` }));
    const conn = new HackerNewsDocumentConnector({ fetch: makeHnFetch(ids, items) });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 2 })) docs.push(d);
    expect(docs).toHaveLength(2);
  });

  it("skips items without a title", async () => {
    const ids = [1, 2];
    const items = [
      { id: 1, title: null },
      { id: 2, title: "Valid story", url: "https://ex.com/2" },
    ];
    const conn = new HackerNewsDocumentConnector({ fetch: makeHnFetch(ids, items) });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 2 })) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Valid story");
  });

  it("yields nothing when list endpoint fails", async () => {
    const fetch = makeFetch([{ ok: false, status: 503 }]);
    const conn = new HackerNewsDocumentConnector({ fetch });
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(0);
  });

  it("connector id is 'hackernews-doc'", () => {
    expect(new HackerNewsDocumentConnector().id).toBe("hackernews-doc");
  });

  it("defaults to topstories when no config given", () => {
    const conn = new HackerNewsDocumentConnector();
    expect(conn.id).toBe("hackernews-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new HackerNewsDocumentConnector())).toBe(true);
  });
});
