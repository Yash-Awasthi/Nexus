// SPDX-License-Identifier: Apache-2.0
/**
 * Scraping-MCP routes — expose ScrapingMcpServer tools over REST.
 *
 * GET    /scraping/tools            — list available scraping tools + schemas
 * GET    /scraping/sessions         — list active browser sessions
 * POST   /scraping/sessions         — open a new scraping session
 * DELETE /scraping/sessions/:id     — close a session
 * POST   /scraping/call             — generic tool call { tool, input }
 * POST   /scraping/fetch            — convenience: "get" tool
 * POST   /scraping/fetch-stealthy   — convenience: "fetch_stealthy" tool
 * POST   /scraping/screenshot       — convenience: "screenshot" tool
 * POST   /scraping/bulk             — convenience: "bulk_get" tool
 *
 * Backend: MockScrapingBackend until a real stealth-browser adapter is
 * configured via environment. Replace `backend` with a real ScrapingBackend
 * implementation when STEALTH_BROWSER_URL is set.
 */

import {
  MockScrapingBackend,
  ScrapingMcpServer,
  SessionStore,
  type ScrapingBackend,
} from "@nexus/scraping-mcp";
import {
  createStealthBackend,
  isPatchrightAvailable,
} from "@nexus/stealth-browser";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Backend factory ───────────────────────────────────────────────────────────
// Auto-wire StealthBrowserScrapingBackend when patchright is installed or
// STEALTH_BROWSER_URL env var is set.  Falls back to MockScrapingBackend for
// development / CI.  Called once per process at plugin registration time.

async function buildBackend(): Promise<ScrapingBackend> {
  if (process.env.STEALTH_BROWSER_URL || await isPatchrightAvailable()) {
    return createStealthBackend({ poolSize: 3 });
  }
  return new MockScrapingBackend({
    html:   "<html><body><p>Nexus scraping stub — install patchright or set STEALTH_BROWSER_URL for real scraping</p></body></html>",
    status: 200,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTextContent(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

// ── Route plugin ──────────────────────────────────────────────────────────────
// NOTE: SessionStore and ScrapingMcpServer are instantiated inside the plugin
// (async) so buildBackend() can resolve before they're constructed.

export async function scrapingMcpRoutes(app: FastifyInstance): Promise<void> {
  // Resolve backend once at plugin registration; auto-wire stealth when available
  const backend   = await buildBackend();
  const sessionStore = new SessionStore();
  const server    = new ScrapingMcpServer(backend, sessionStore);

  /**
   * GET /scraping/tools
   * List all available MCP scraping tools with their input schemas.
   */
  app.get("/scraping/tools", { preHandler: requireAuth }, async (_request, reply) => {
    return reply.send({
      tools: server.listTools().map((t) => ({
        name:        t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  });

  /**
   * GET /scraping/sessions
   * List active browser sessions.
   */
  app.get("/scraping/sessions", { preHandler: requireAuth }, async (_request, reply) => {
    const result = await server.call("list_sessions", {});
    const first = result.content[0];
    const data = first?.type === "text" ? parseTextContent(first.text) : {};
    return reply.send(data);
  });

  /**
   * POST /scraping/sessions
   * Open a new browser scraping session.
   */
  app.post("/scraping/sessions", { preHandler: requireAuth }, async (_request, reply) => {
    const result = await server.call("open_session", {});
    if (result.isError) {
      const msg = result.content[0]?.type === "text" ? result.content[0].text : "Unknown error";
      return reply.code(500).send({ error: msg });
    }
    const first = result.content[0];
    const data = first?.type === "text" ? parseTextContent(first.text) : {};
    return reply.code(201).send(data);
  });

  /**
   * DELETE /scraping/sessions/:id
   * Close a scraping session.
   */
  app.delete<{ Params: { id: string } }>(
    "/scraping/sessions/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await server.call("close_session", { sessionId: request.params.id });
      if (result.isError) {
        const msg = result.content[0]?.type === "text" ? result.content[0].text : "Not found";
        return reply.code(404).send({ error: msg });
      }
      const first = result.content[0];
      const data = first?.type === "text" ? parseTextContent(first.text) : {};
      return reply.send(data);
    },
  );

  /**
   * POST /scraping/call
   * Generic tool call.
   * Body: { tool: string, input?: Record<string, unknown> }
   */
  app.post<{ Body: { tool: string; input?: Record<string, unknown> } }>(
    "/scraping/call",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { tool, input = {} } = request.body;
      if (!tool) return reply.code(400).send({ error: "tool is required" });

      const result = await server.call(tool, input);
      return reply.code(result.isError ? 422 : 200).send({
        isError:  result.isError,
        content:  result.content,
      });
    },
  );

  /**
   * POST /scraping/fetch
   * Fetch a URL (standard HTTP).
   * Body: { url: string, sessionId?: string }
   */
  app.post<{ Body: { url: string; sessionId?: string } }>(
    "/scraping/fetch",
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await server.call("get", request.body);
      if (result.isError) {
        const msg = result.content[0]?.type === "text" ? result.content[0].text : "Fetch failed";
        return reply.code(422).send({ error: msg });
      }
      const first = result.content[0];
      const data = first?.type === "text" ? parseTextContent(first.text) : {};
      return reply.send(data);
    },
  );

  /**
   * POST /scraping/fetch-stealthy
   * Fetch a URL using stealth mode (Cloudflare bypass, fingerprint spoofing).
   * Body: { url: string, sessionId?: string }
   */
  app.post<{ Body: { url: string; sessionId?: string } }>(
    "/scraping/fetch-stealthy",
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await server.call("fetch_stealthy", request.body);
      if (result.isError) {
        const msg = result.content[0]?.type === "text" ? result.content[0].text : "Stealth fetch failed";
        return reply.code(422).send({ error: msg });
      }
      const first = result.content[0];
      const data = first?.type === "text" ? parseTextContent(first.text) : {};
      return reply.send(data);
    },
  );

  /**
   * POST /scraping/screenshot
   * Take a screenshot of a URL.
   * Body: { url: string, sessionId?: string }
   */
  app.post<{ Body: { url: string; sessionId?: string } }>(
    "/scraping/screenshot",
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await server.call("screenshot", request.body);
      if (result.isError) {
        const msg = result.content[0]?.type === "text" ? result.content[0].text : "Screenshot failed";
        return reply.code(422).send({ error: msg });
      }
      const img = result.content.find((c) => c.type === "image");
      return reply.send({
        url:      request.body.url,
        data:     img?.type === "image" ? img.data : undefined,
        mimeType: img?.type === "image" ? img.mimeType : undefined,
      });
    },
  );

  /**
   * POST /scraping/bulk
   * Fetch multiple URLs in parallel.
   * Body: { urls: string[], sessionId?: string }
   */
  app.post<{ Body: { urls: string[]; sessionId?: string } }>(
    "/scraping/bulk",
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await server.call("bulk_get", request.body);
      if (result.isError) {
        const msg = result.content[0]?.type === "text" ? result.content[0].text : "Bulk fetch failed";
        return reply.code(422).send({ error: msg });
      }
      const first = result.content[0];
      const data = first?.type === "text" ? parseTextContent(first.text) : {};
      return reply.send(data);
    },
  );
}
