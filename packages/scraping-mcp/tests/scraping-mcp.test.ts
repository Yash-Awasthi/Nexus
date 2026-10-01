// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  MockScrapingBackend,
  SessionStore,
  buildScrapingTools,
  ScrapingMcpServer,
} from "../src/index.js";

// ── MockScrapingBackend ───────────────────────────────────────────────────────

describe("MockScrapingBackend", () => {
  it("fetch returns default mock HTML", async () => {
    const backend = new MockScrapingBackend({ html: "<p>hello</p>" });
    const result = await backend.fetch("https://example.com");
    expect(result.html).toBe("<p>hello</p>");
    expect(result.status).toBe(200);
    expect(result.url).toBe("https://example.com");
  });

  it("fetchStealthy marks as stealthy in fetchLog", async () => {
    const backend = new MockScrapingBackend();
    await backend.fetchStealthy("https://example.com");
    expect(backend.fetchLog[0]!.stealthy).toBe(true);
  });

  it("fetch marks as non-stealthy in fetchLog", async () => {
    const backend = new MockScrapingBackend();
    await backend.fetch("https://example.com");
    expect(backend.fetchLog[0]!.stealthy).toBe(false);
  });

  it("setBehavior overrides per-URL behavior", async () => {
    const backend = new MockScrapingBackend({ html: "default" });
    backend.setBehavior("https://special.com", { html: "special" });
    expect((await backend.fetch("https://special.com")).html).toBe("special");
    expect((await backend.fetch("https://other.com")).html).toBe("default");
  });

  it("fetch throws when throws is configured", async () => {
    const backend = new MockScrapingBackend({ throws: "network error" });
    await expect(backend.fetch("https://x.com")).rejects.toThrow("network error");
  });

  it("screenshot returns base64 data and png mimeType", async () => {
    const backend = new MockScrapingBackend();
    const result = await backend.screenshot("https://example.com");
    expect(result.mimeType).toBe("image/png");
    expect(result.data.length).toBeGreaterThan(0);
    expect(backend.screenshotLog).toContain("https://example.com");
  });
});

// ── SessionStore ──────────────────────────────────────────────────────────────

describe("SessionStore", () => {
  it("create returns a new session with id", () => {
    const store = new SessionStore();
    const session = store.create();
    expect(session.id).toBeDefined();
    expect(typeof session.createdAt).toBe("string");
  });

  it("get returns the created session", () => {
    const store = new SessionStore();
    const s = store.create();
    expect(store.get(s.id)).toBe(s);
  });

  it("has returns correct boolean", () => {
    const store = new SessionStore();
    const s = store.create();
    expect(store.has(s.id)).toBe(true);
    expect(store.has("nonexistent")).toBe(false);
  });

  it("close removes session", () => {
    const store = new SessionStore();
    const s = store.create();
    store.close(s.id);
    expect(store.has(s.id)).toBe(false);
  });

  it("close returns false for unknown id", () => {
    const store = new SessionStore();
    expect(store.close("ghost")).toBe(false);
  });

  it("list returns all sessions", () => {
    const store = new SessionStore();
    store.create();
    store.create();
    expect(store.list()).toHaveLength(2);
  });

  it("count tracks session count", () => {
    const store = new SessionStore();
    store.create();
    store.create();
    expect(store.count()).toBe(2);
    store.create();
    expect(store.count()).toBe(3);
  });

  it("clear removes all sessions", () => {
    const store = new SessionStore();
    store.create();
    store.create();
    store.clear();
    expect(store.count()).toBe(0);
  });

  it("touch updates lastUsedAt", async () => {
    const store = new SessionStore();
    const s = store.create();
    const before = s.lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    store.touch(s.id);
    expect(store.get(s.id)!.lastUsedAt).not.toBe(before);
  });
});

// ── ScrapingMcpServer – tool list ─────────────────────────────────────────────

describe("ScrapingMcpServer – tool list", () => {
  it("registers all 8 tools", () => {
    const backend = new MockScrapingBackend();
    const server = new ScrapingMcpServer(backend);
    const names = server.toolNames();
    expect(names).toContain("open_session");
    expect(names).toContain("close_session");
    expect(names).toContain("list_sessions");
    expect(names).toContain("get");
    expect(names).toContain("bulk_get");
    expect(names).toContain("fetch");
    expect(names).toContain("fetch_stealthy");
    expect(names).toContain("screenshot");
    expect(names).toHaveLength(8);
  });

  it("returns error for unknown tool", async () => {
    const backend = new MockScrapingBackend();
    const server = new ScrapingMcpServer(backend);
    const result = await server.call("does_not_exist", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown tool");
  });
});

// ── open_session ──────────────────────────────────────────────────────────────

describe("open_session tool", () => {
  it("creates a session and returns sessionId", async () => {
    const server = new ScrapingMcpServer(new MockScrapingBackend());
    const result = await server.call("open_session", {});
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0]!.text);
    expect(data.sessionId).toBeDefined();
    expect(server.getStore().count()).toBe(1);
  });
});

// ── close_session ─────────────────────────────────────────────────────────────

describe("close_session tool", () => {
  it("closes an existing session", async () => {
    const server = new ScrapingMcpServer(new MockScrapingBackend());
    const open = await server.call("open_session", {});
    const { sessionId } = JSON.parse(open.content[0]!.text);
    const close = await server.call("close_session", { sessionId });
    expect(close.isError).toBe(false);
    const data = JSON.parse(close.content[0]!.text);
    expect(data.closed).toBe(true);
    expect(server.getStore().count()).toBe(0);
  });

  it("returns error for nonexistent session", async () => {
    const server = new ScrapingMcpServer(new MockScrapingBackend());
    const result = await server.call("close_session", { sessionId: "ghost" });
    expect(result.isError).toBe(true);
  });
});

// ── list_sessions ─────────────────────────────────────────────────────────────

describe("list_sessions tool", () => {
  it("returns empty list initially", async () => {
    const server = new ScrapingMcpServer(new MockScrapingBackend());
    const result = await server.call("list_sessions", {});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.count).toBe(0);
  });

  it("lists all open sessions", async () => {
    const server = new ScrapingMcpServer(new MockScrapingBackend());
    await server.call("open_session", {});
    await server.call("open_session", {});
    const result = await server.call("list_sessions", {});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.count).toBe(2);
  });
});

// ── get tool ──────────────────────────────────────────────────────────────────

describe("get tool", () => {
  it("fetches URL and returns HTML", async () => {
    const backend = new MockScrapingBackend({ html: "<h1>Test</h1>" });
    const server = new ScrapingMcpServer(backend);
    const result = await server.call("get", { url: "https://test.com" });
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0]!.text);
    expect(data.html).toBe("<h1>Test</h1>");
    expect(data.status).toBe(200);
  });

  it("returns error when backend throws", async () => {
    const backend = new MockScrapingBackend({ throws: "timeout" });
    const server = new ScrapingMcpServer(backend);
    const result = await server.call("get", { url: "https://test.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("timeout");
  });
});

// ── bulk_get tool ─────────────────────────────────────────────────────────────

describe("bulk_get tool", () => {
  it("fetches multiple URLs", async () => {
    const backend = new MockScrapingBackend({ html: "<p>page</p>" });
    const server = new ScrapingMcpServer(backend);
    const result = await server.call("bulk_get", { urls: ["https://a.com", "https://b.com"] });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.totalFetched).toBe(2);
    expect(data.results).toHaveLength(2);
  });

  it("captures individual URL errors without failing all", async () => {
    const backend = new MockScrapingBackend();
    backend.setBehavior("https://bad.com", { throws: "gone" });
    const server = new ScrapingMcpServer(backend);
    const result = await server.call("bulk_get", {
      urls: ["https://good.com", "https://bad.com"],
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.results[0]!.error).toBeNull();
    expect(data.results[1]!.error).toContain("gone");
  });
});

// ── fetch_stealthy tool ───────────────────────────────────────────────────────

describe("fetch_stealthy tool", () => {
  it("calls fetchStealthy on backend", async () => {
    const backend = new MockScrapingBackend({ html: "<p>stealth</p>" });
    const server = new ScrapingMcpServer(backend);
    const result = await server.call("fetch_stealthy", { url: "https://cf.com" });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.stealthy).toBe(true);
    expect(backend.fetchLog[0]!.stealthy).toBe(true);
  });
});

// ── screenshot tool ───────────────────────────────────────────────────────────

describe("screenshot tool", () => {
  it("returns image content", async () => {
    const backend = new MockScrapingBackend();
    const server = new ScrapingMcpServer(backend);
    const result = await server.call("screenshot", { url: "https://example.com" });
    expect(result.isError).toBe(false);
    const imgContent = result.content.find((c) => c.type === "image");
    expect(imgContent).toBeDefined();
  });

  it("returns error when screenshot fails", async () => {
    const backend = new MockScrapingBackend();
    backend.setBehavior("https://fail.com", { throws: "headless error" });
    const server = new ScrapingMcpServer(backend);
    const result = await server.call("screenshot", { url: "https://fail.com" });
    expect(result.isError).toBe(true);
  });
});
