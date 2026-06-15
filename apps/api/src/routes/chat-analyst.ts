// SPDX-License-Identifier: Apache-2.0
/**
 * Chat-Analyst routes — streaming SSE intelligence analyst.
 *
 * POST /analyst/query   — start a new analyst session and stream AnalystEvents
 *                         as text/event-stream (SSE).  Each event is a JSON line:
 *                         data: <AnalystEvent JSON>\n\n
 * POST /analyst/session — create a named session (stateful multi-turn)
 * POST /analyst/session/:sessionId/message — send follow-up in a session
 * GET  /analyst/session/:sessionId — inspect session metadata
 * DELETE /analyst/session/:sessionId — destroy session
 *
 * LLM backend:
 *   Uses GroqDriver (when GROQ_API_KEY set) for low-latency streaming,
 *   falls back to OpenRouterDriver (OPENROUTER_API_KEY), and ultimately
 *   uses a stub (no API key in env) that returns a single-chunk response.
 *
 * SSE format:
 *   Each SSE event:  data: <JSON>\n\n
 *   Heartbeat every 15 s (": heartbeat\n\n") to keep proxy connections alive.
 *   Stream is terminated by stream_end or error event, then connection closes.
 */

import {
  StreamingAnalyst,
  AnalystSessionManager,
  RateLimiter,
  type AnalystDomain,
  type AnalystEvent,
  type ContextMessage,
  type GeoContext,
  type StreamingLlmFn,
} from "@nexus/chat-analyst";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";
import { getSharedKV } from "../lib/shared-kv.js";

// ── KV-backed session persistence (cross-pod safe) ───────────────────────────
// AnalystSessionManager is in-process. To survive pod restarts and make sessions
// accessible on any pod, we persist session history to the shared KVStore.
// TTL: ANALYST_SESSION_TTL_MS (default 4 hours).

const SESSION_TTL = parseInt(process.env.ANALYST_SESSION_TTL_MS ?? String(4 * 60 * 60_000), 10);
const SESSION_KEY = (id: string): string => `analyst:session:${id}`;

interface PersistedSession {
  id:        string;
  domain:    AnalystDomain;
  history:   ContextMessage[];
  createdAt: string;
}

async function persistSession(session: { id: string; domain: AnalystDomain; createdAt: string; getHistory(): ContextMessage[] }): Promise<void> {
  try {
    await getSharedKV().set<PersistedSession>(SESSION_KEY(session.id), {
      id:        session.id,
      domain:    session.domain,
      history:   session.getHistory(),
      createdAt: session.createdAt,
    }, SESSION_TTL);
  } catch { /* non-fatal — in-process state is authoritative */ }
}

async function loadSession(sessionId: string, manager: AnalystSessionManager): Promise<ReturnType<AnalystSessionManager["get"]> | undefined> {
  // Return in-process session if already warm
  const warm = manager.get(sessionId);
  if (warm) return warm;
  // Try to restore from KV (cross-pod scenario)
  try {
    const persisted = await getSharedKV().get<PersistedSession>(SESSION_KEY(sessionId));
    if (!persisted) return undefined;
    const session = manager.create(persisted.domain);
    // Re-hydrate history by adding messages back
    for (const msg of persisted.history) session.addMessage(msg.role, msg.content);
    return session;
  } catch { return undefined; }
}

// ── StreamingLlmFn implementation ─────────────────────────────────────────────
// Priority: GroqDriver > OpenRouterDriver > stub echo.
// The function bridges the @nexus/llm-drivers streaming API to AsyncIterable<string>.

function buildLlmFn(): StreamingLlmFn {
  const groqKey      = process.env.GROQ_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (groqKey) {
    // Lazy import — avoids requiring @nexus/llm-drivers when Groq not configured
    return async function* (systemPrompt: string, messages: ContextMessage[]): AsyncIterable<string> {
      const { GroqDriver } = await import("@nexus/llm-drivers");
      const driver = new GroqDriver({ apiKey: groqKey });
      const allMessages = [
        { role: "system" as const, content: systemPrompt },
        ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      ];
      const chunks: string[] = [];
      await driver.stream(
        { model: process.env.ANALYST_MODEL ?? "llama-3.3-70b-versatile", messages: allMessages, maxTokens: 2048, temperature: 0.3 },
        ({ delta }: { delta: string }) => { if (delta) chunks.push(delta); },
      );
      for (const chunk of chunks) yield chunk;
    };
  }

  if (openrouterKey) {
    return async function* (systemPrompt: string, messages: ContextMessage[]): AsyncIterable<string> {
      const { OpenRouterDriver } = await import("@nexus/llm-drivers");
      const driver = new OpenRouterDriver({ apiKey: openrouterKey });
      const allMessages = [
        { role: "system" as const, content: systemPrompt },
        ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      ];
      const chunks: string[] = [];
      await driver.stream(
        { model: process.env.ANALYST_MODEL ?? "anthropic/claude-3-5-haiku", messages: allMessages, maxTokens: 2048, temperature: 0.3 },
        ({ delta }: { delta: string }) => { if (delta) chunks.push(delta); },
      );
      for (const chunk of chunks) yield chunk;
    };
  }

  // Stub: returns a single-chunk response when no LLM key is configured.
  // Useful for integration testing without API credentials.
  return async function* (systemPrompt: string, messages: ContextMessage[]): AsyncIterable<string> {
    const last = messages.at(-1)?.content ?? "(no message)";
    yield `[Analyst stub — no LLM key configured] Query received: "${last.slice(0, 100)}"`;
  };
}

// ── Singletons ────────────────────────────────────────────────────────────────

const _analyst = new StreamingAnalyst({
  llm:         buildLlmFn(),
  rateLimiter: new RateLimiter({ requestsPerMinute: 20 }),
});

const _sessions = new AnalystSessionManager(_analyst);

// ── SSE helper ────────────────────────────────────────────────────────────────

function sseWrite(raw: NodeJS.WritableStream, event: AnalystEvent): void {
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function chatAnalystRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /analyst/query
   *
   * One-shot streaming query — creates an ephemeral session, streams all
   * AnalystEvent types, and terminates when stream_end or error is emitted.
   *
   * Body: {
   *   query:      string           — user question
   *   domain?:    AnalystDomain    — intelligence domain (default: "general")
   *   sessionId?: string           — attach to existing named session (optional)
   *   domainData?: object          — extra structured data for context assembly
   *   geo?:       GeoContext       — caller geo hints (countryCode, timezone, …)
   * }
   *
   * Response: text/event-stream — AnalystEvent objects, one per SSE frame.
   */
  app.post<{
    Body: {
      query:       string;
      domain?:     AnalystDomain;
      sessionId?:  string;
      domainData?: Record<string, unknown>;
      geo?:        GeoContext;
    };
  }>("/analyst/query", { preHandler: requireAuth }, async (request, reply) => {
    const { query, domain = "general", sessionId, domainData, geo } = request.body;

    if (!query || query.trim() === "") {
      return reply.code(400).send({ error: "query is required" });
    }

    // Set up SSE headers immediately
    reply.raw.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      Connection:      "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering
    });

    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);

    try {
      // Use named session if provided (cross-pod KV restore), else create ephemeral
      const session = sessionId
        ? ((await loadSession(sessionId, _sessions)) ?? _sessions.create(domain))
        : _sessions.create(domain);

      for await (const event of session.ask(query.trim(), { domainData, geo })) {
        sseWrite(reply.raw, event as AnalystEvent);
        if (event.type === "stream_end" || event.type === "error") break;
      }
      // Persist updated session history to shared KV (cross-pod durability)
      await persistSession(session);
    } catch (err) {
      const errEvent: AnalystEvent = {
        type:      "error",
        sessionId: sessionId ?? "ephemeral",
        code:      "ANALYST_ERROR",
        message:   err instanceof Error ? err.message : "Unknown analyst error",
      };
      sseWrite(reply.raw, errEvent);
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }

    // Keep Fastify from auto-sending a reply (raw stream already closed)
    return reply;
  });

  /**
   * POST /analyst/session
   *
   * Create a named multi-turn session.
   * Body: { domain?: AnalystDomain }
   */
  app.post<{ Body: { domain?: AnalystDomain } }>(
    "/analyst/session",
    { preHandler: requireAuth },
    async (request, reply) => {
      const domain  = request.body.domain ?? "general";
      const session = _sessions.create(domain);
      return reply.code(201).send({
        sessionId:  session.id,
        domain:     session.domain,
        createdAt:  session.createdAt,
      });
    },
  );

  /**
   * POST /analyst/session/:sessionId/message
   *
   * Send a follow-up message in a named session (SSE stream).
   * Body: { query: string; domainData?: object; geo?: GeoContext }
   */
  app.post<{
    Params: { sessionId: string };
    Body: {
      query:       string;
      domainData?: Record<string, unknown>;
      geo?:        GeoContext;
    };
  }>(
    "/analyst/session/:sessionId/message",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sessionId } = request.params;
      const { query, domainData, geo } = request.body;

      if (!query || query.trim() === "") {
        return reply.code(400).send({ error: "query is required" });
      }

      // KV restore: handles cross-pod session lookup
      const session = await loadSession(sessionId, _sessions);
      if (!session) {
        return reply.code(404).send({ error: `Session "${sessionId}" not found` });
      }

      reply.raw.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        Connection:      "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
      }, 15_000);

      try {
        for await (const event of session.ask(query.trim(), { domainData, geo })) {
          sseWrite(reply.raw, event as AnalystEvent);
          if (event.type === "stream_end" || event.type === "error") break;
        }
        await persistSession(session);
      } catch (err) {
        sseWrite(reply.raw, {
          type:      "error",
          sessionId,
          code:      "ANALYST_ERROR",
          message:   err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        clearInterval(heartbeat);
        reply.raw.end();
      }

      return reply;
    },
  );

  /**
   * GET /analyst/session/:sessionId
   *
   * Inspect a session: id, domain, createdAt, history length.
   */
  app.get<{ Params: { sessionId: string } }>(
    "/analyst/session/:sessionId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const session = _sessions.get(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return reply.send({
        sessionId:     session.id,
        domain:        session.domain,
        createdAt:     session.createdAt,
        historyLength: session.getHistory().length,
      });
    },
  );

  /**
   * DELETE /analyst/session/:sessionId
   *
   * Destroy a named session, freeing its history from memory.
   */
  app.delete<{ Params: { sessionId: string } }>(
    "/analyst/session/:sessionId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sessionId } = request.params;
      if (!_sessions.has(sessionId)) {
        return reply.code(404).send({ error: "Session not found" });
      }
      _sessions.destroy(sessionId);
      return reply.code(204).send();
    },
  );
}
