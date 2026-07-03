// SPDX-License-Identifier: Apache-2.0
/**
 * Code-REPL routes — sandboxed kernel execution via @nexus/code-repl.
 *
 * POST   /api/v1/code-repl/sessions             — create kernel session
 * GET    /api/v1/code-repl/sessions             — list sessions
 * GET    /api/v1/code-repl/sessions/:id         — get session info
 * DELETE /api/v1/code-repl/sessions/:id         — destroy session
 * POST   /api/v1/code-repl/sessions/:id/execute — execute code in session
 * POST   /api/v1/code-repl/sessions/reap        — remove idle sessions
 * GET    /api/v1/code-repl/executor             — current executor type
 *
 * Executor selection (at server startup):
 *   Docker available → DockerReplExecutor (real sandboxed containers)
 *   otherwise        → MockReplExecutor  (no-op, returns descriptive message)
 */

import {
  KernelManager,
  MockReplExecutor,
  DockerReplExecutor,
  isDockerAvailable,
  type ReplLanguage,
} from "@nexus/code-repl";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Executor setup (probe Docker once at module load) ─────────────────────────

let _manager: KernelManager | null = null;
let _executorType: "docker" | "mock" = "mock";

async function getManager(): Promise<KernelManager> {
  if (_manager) return _manager;

  const dockerOk = await isDockerAvailable();
  _executorType = dockerOk ? "docker" : "mock";

  const executor = dockerOk
    ? new DockerReplExecutor({
        memoryLimit: process.env.REPL_MEMORY_LIMIT ?? "512m",
        cpuLimit: process.env.REPL_CPU_LIMIT ?? "0.5",
        defaultTimeoutMs: parseInt(process.env.REPL_TIMEOUT_MS ?? "10000", 10),
      })
    : new MockReplExecutor({
        stdout: [
          "⚠  Docker not available — code execution is disabled.",
          "   Install Docker Desktop or Docker Engine and restart the API server.",
          "   Set REPL_MEMORY_LIMIT, REPL_CPU_LIMIT, REPL_TIMEOUT_MS to customize.",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      });

  _manager = new KernelManager({
    executor,
    jupyterMode: true,
    maxSessions: parseInt(process.env.REPL_MAX_SESSIONS ?? "20", 10),
  });

  return _manager;
}

const SUPPORTED_LANGS: ReplLanguage[] = ["python", "r", "julia", "shell"];

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function codeReplRoutes(app: FastifyInstance): Promise<void> {
  /** GET /code-repl/executor — which executor is active */
  app.get(
    "/code-repl/executor",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      const mgr = await getManager();
      return reply.send({
        executor: _executorType,
        docker: _executorType === "docker",
        sessions: mgr.count(),
        languages: SUPPORTED_LANGS,
      });
    },
  );

  /** POST /code-repl/sessions — create a new kernel session */
  app.post<{
    Body: { language?: ReplLanguage };
  }>("/code-repl/sessions", { preHandler: requireAuth }, async (request, reply) => {
    const lang = request.body.language ?? "python";
    if (!SUPPORTED_LANGS.includes(lang)) {
      return reply.code(400).send({
        error: `Unsupported language "${lang}". Supported: ${SUPPORTED_LANGS.join(", ")}`,
      });
    }

    const mgr = await getManager();
    let session;
    try {
      session = mgr.create(lang);
    } catch (err) {
      return reply.code(503).send({
        error: err instanceof Error ? err.message : "Failed to create session",
      });
    }

    return reply.code(201).send({
      id: session.id,
      language: session.language,
      executionCount: session.executionCount,
      executor: _executorType,
      createdAt: session.state_.createdAt,
    });
  });

  /** GET /code-repl/sessions — list all active sessions */
  app.get(
    "/code-repl/sessions",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      const mgr = await getManager();
      const sessions = mgr.list().map((s) => ({
        id: s.id,
        language: s.language,
        executionCount: s.executionCount,
        idleTimeMs: s.idleTimeMs(),
        createdAt: s.state_.createdAt,
        lastUsedAt: s.state_.lastUsedAt,
      }));
      return reply.send({ sessions, total: sessions.length, executor: _executorType });
    },
  );

  /** GET /code-repl/sessions/:id — session details */
  app.get<{ Params: { id: string } }>(
    "/code-repl/sessions/:id",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const mgr = await getManager();
      const session = mgr.get(request.params.id);
      if (!session) return reply.code(404).send({ error: "Session not found" });

      return reply.send({
        id: session.id,
        language: session.language,
        executionCount: session.executionCount,
        history: session.getHistory(),
        idleTimeMs: session.idleTimeMs(),
        createdAt: session.state_.createdAt,
        lastUsedAt: session.state_.lastUsedAt,
      });
    },
  );

  /** DELETE /code-repl/sessions/:id — destroy session */
  app.delete<{ Params: { id: string } }>(
    "/code-repl/sessions/:id",
    {
      schema: {
        response: { 200: { type: "object", additionalProperties: true }, 204: { type: "null" } },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const mgr = await getManager();
      const destroyed = mgr.destroy(request.params.id);
      if (!destroyed) return reply.code(404).send({ error: "Session not found" });
      return reply.code(204).send();
    },
  );

  /** POST /code-repl/sessions/:id/execute — run code in session */
  app.post<{
    Params: { id: string };
    Body: { code: string; timeoutMs?: number; jupyterMode?: boolean };
  }>("/code-repl/sessions/:id/execute", { preHandler: requireAuth }, async (request, reply) => {
    const mgr = await getManager();
    const session = mgr.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });

    if (!request.body.code?.trim()) {
      return reply.code(400).send({ error: "code is required" });
    }

    try {
      const result = await session.execute({
        code: request.body.code,
        timeoutMs: request.body.timeoutMs,
      });
      return reply.send({
        ...result,
        sessionId: session.id,
        executionCount: session.executionCount,
        executor: _executorType,
      });
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : "Execution failed",
      });
    }
  });

  /** POST /code-repl/sessions/reap — manually trigger idle session cleanup */
  app.post(
    "/code-repl/sessions/reap",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      const mgr = await getManager();
      const reaped = mgr.reapIdle();
      return reply.send({ reaped, remaining: mgr.count() });
    },
  );
}
