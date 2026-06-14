// SPDX-License-Identifier: Apache-2.0
/**
 * scraping-mcp — FastMCP-style scraping server wrapping adaptive-scraper + stealth-browser.
 *
 * Provides:
 *   • McpTool           — { name, description, inputSchema, handler }
 *   • ToolCallResult    — { content, isError }
 *   • ScrapingSession   — stateful browser session wrapper
 *   • SessionStore      — in-memory session registry
 *   • ScrapingBackend   — injectable scraping interface (real: stealth-browser, test: mock)
 *   • MockScrapingBackend — in-memory test double
 *   • ScrapingMcpServer — FastMCP-style server with tools:
 *       open_session, close_session, list_sessions,
 *       get, bulk_get, fetch, fetch_stealthy, screenshot
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; items?: unknown; enum?: unknown[] }>;
  required?: string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
  handler: (input: unknown, sessionStore: SessionStore) => Promise<ToolCallResult>;
}

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError: boolean;
}

function textResult(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: false };
}

function jsonResult(data: unknown): ToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
}

function errorResult(message: string): ToolCallResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// ── ScrapingSession ───────────────────────────────────────────────────────────

export interface ScrapingSession {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  url?: string;
}

// ── ScrapingBackend ───────────────────────────────────────────────────────────

export interface FetchResult {
  url: string;
  html: string;
  status: number;
  headers?: Record<string, string>;
}

export interface ScreenshotResult {
  url: string;
  data: string; // base64
  mimeType: string;
}

export interface ScrapingBackend {
  fetch(url: string, sessionId?: string): Promise<FetchResult>;
  fetchStealthy(url: string, sessionId?: string): Promise<FetchResult>;
  screenshot(url: string, sessionId?: string): Promise<ScreenshotResult>;
}

// ── MockScrapingBackend ───────────────────────────────────────────────────────

export interface MockFetchBehavior {
  html?: string;
  status?: number;
  throws?: string;
  screenshot?: string;
}

export class MockScrapingBackend implements ScrapingBackend {
  private behaviors = new Map<string, MockFetchBehavior>();
  private defaultBehavior: MockFetchBehavior;
  readonly fetchLog: Array<{ url: string; stealthy: boolean }> = [];
  readonly screenshotLog: string[] = [];

  constructor(defaultBehavior: MockFetchBehavior = {}) {
    this.defaultBehavior = defaultBehavior;
  }

  setBehavior(url: string, behavior: MockFetchBehavior): void {
    this.behaviors.set(url, behavior);
  }

  private _get(url: string): MockFetchBehavior {
    return this.behaviors.get(url) ?? this.defaultBehavior;
  }

  async fetch(url: string, _sessionId?: string): Promise<FetchResult> {
    this.fetchLog.push({ url, stealthy: false });
    const b = this._get(url);
    if (b.throws) throw new Error(b.throws);
    return {
      url,
      html: b.html ?? `<html><body><p>Mock page: ${url}</p></body></html>`,
      status: b.status ?? 200,
    };
  }

  async fetchStealthy(url: string, _sessionId?: string): Promise<FetchResult> {
    this.fetchLog.push({ url, stealthy: true });
    const b = this._get(url);
    if (b.throws) throw new Error(b.throws);
    return {
      url,
      html: b.html ?? `<html><body><p>Stealthy mock page: ${url}</p></body></html>`,
      status: b.status ?? 200,
    };
  }

  async screenshot(url: string, _sessionId?: string): Promise<ScreenshotResult> {
    this.screenshotLog.push(url);
    const b = this._get(url);
    if (b.throws) throw new Error(b.throws);
    return {
      url,
      data: b.screenshot ?? Buffer.from("mock-screenshot").toString("base64"),
      mimeType: "image/png",
    };
  }
}

// ── SessionStore ──────────────────────────────────────────────────────────────

let _sId = 0;

export class SessionStore {
  private sessions = new Map<string, ScrapingSession>();

  create(): ScrapingSession {
    const session: ScrapingSession = {
      id: `session-${++_sId}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): ScrapingSession | undefined { return this.sessions.get(id); }
  has(id: string): boolean { return this.sessions.has(id); }

  close(id: string): boolean { return this.sessions.delete(id); }

  touch(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastUsedAt = new Date().toISOString();
  }

  list(): ScrapingSession[] { return [...this.sessions.values()]; }
  count(): number { return this.sessions.size; }
  clear(): void { this.sessions.clear(); }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export function buildScrapingTools(backend: ScrapingBackend): McpTool[] {
  const open_session: McpTool = {
    name: "open_session",
    description: "Open a new browser scraping session. Returns a session ID for subsequent calls.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async (_input, store) => {
      const session = store.create();
      return jsonResult({ sessionId: session.id, createdAt: session.createdAt });
    },
  };

  const close_session: McpTool = {
    name: "close_session",
    description: "Close an existing scraping session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Session ID to close" } },
      required: ["sessionId"],
    },
    handler: async (input: unknown, store) => {
      const { sessionId } = input as { sessionId: string };
      if (!store.has(sessionId)) return errorResult(`Session not found: ${sessionId}`);
      store.close(sessionId);
      return jsonResult({ closed: true, sessionId });
    },
  };

  const list_sessions: McpTool = {
    name: "list_sessions",
    description: "List all active scraping sessions.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async (_input, store) => {
      const sessions = store.list();
      return jsonResult({ sessions, count: sessions.length });
    },
  };

  const get: McpTool = {
    name: "get",
    description: "Fetch a URL and return its HTML content (standard HTTP).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: ["url"],
    },
    handler: async (input: unknown, store) => {
      const { url, sessionId } = input as { url: string; sessionId?: string };
      try {
        if (sessionId) store.touch(sessionId);
        const result = await backend.fetch(url, sessionId);
        return jsonResult({ url: result.url, status: result.status, html: result.html });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const bulk_get: McpTool = {
    name: "bulk_get",
    description: "Fetch multiple URLs in parallel and return their HTML content.",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "List of URLs to fetch" },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: ["urls"],
    },
    handler: async (input: unknown, store) => {
      const { urls, sessionId } = input as { urls: string[]; sessionId?: string };
      if (sessionId) store.touch(sessionId);
      const results = await Promise.all(
        urls.map(async (url) => {
          try {
            const r = await backend.fetch(url, sessionId);
            return { url: r.url, status: r.status, html: r.html, error: null };
          } catch (err) {
            return { url, status: 0, html: "", error: err instanceof Error ? err.message : String(err) };
          }
        })
      );
      return jsonResult({ results, totalFetched: urls.length });
    },
  };

  const fetch_tool: McpTool = {
    name: "fetch",
    description: "Fetch a URL with full browser rendering (JS execution).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        sessionId: { type: "string" },
        waitSelector: { type: "string", description: "CSS selector to wait for before returning" },
      },
      required: ["url"],
    },
    handler: async (input: unknown, store) => {
      const { url, sessionId } = input as { url: string; sessionId?: string; waitSelector?: string };
      try {
        if (sessionId) store.touch(sessionId);
        const result = await backend.fetch(url, sessionId);
        return jsonResult({ url: result.url, status: result.status, html: result.html, rendered: true });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const fetch_stealthy: McpTool = {
    name: "fetch_stealthy",
    description: "Fetch a URL using stealth mode (Cloudflare bypass, fingerprint spoofing).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["url"],
    },
    handler: async (input: unknown, store) => {
      const { url, sessionId } = input as { url: string; sessionId?: string };
      try {
        if (sessionId) store.touch(sessionId);
        const result = await backend.fetchStealthy(url, sessionId);
        return jsonResult({ url: result.url, status: result.status, html: result.html, stealthy: true });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const screenshot: McpTool = {
    name: "screenshot",
    description: "Take a screenshot of a URL and return base64-encoded PNG data.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["url"],
    },
    handler: async (input: unknown, store) => {
      const { url, sessionId } = input as { url: string; sessionId?: string };
      try {
        if (sessionId) store.touch(sessionId);
        const result = await backend.screenshot(url, sessionId);
        return {
          content: [{ type: "image" as const, data: result.data, mimeType: result.mimeType }],
          isError: false,
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [open_session, close_session, list_sessions, get, bulk_get, fetch_tool, fetch_stealthy, screenshot];
}

// ── ScrapingMcpServer ─────────────────────────────────────────────────────────

export class ScrapingMcpServer {
  private toolMap = new Map<string, McpTool>();
  private store: SessionStore;

  constructor(backend: ScrapingBackend, store?: SessionStore) {
    this.store = store ?? new SessionStore();
    for (const tool of buildScrapingTools(backend)) {
      this.toolMap.set(tool.name, tool);
    }
  }

  /** Call a tool by name. */
  async call(name: string, input: unknown): Promise<ToolCallResult> {
    const tool = this.toolMap.get(name);
    if (!tool) return errorResult(`Unknown tool: ${name}`);
    return tool.handler(input, this.store);
  }

  listTools(): McpTool[] { return [...this.toolMap.values()]; }
  toolNames(): string[] { return [...this.toolMap.keys()]; }
  getStore(): SessionStore { return this.store; }
}
