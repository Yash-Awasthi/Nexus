// SPDX-License-Identifier: Apache-2.0
/**
 * Local PTY routes — Nexus's agent-CLI terminal plane, LOCALHOST
 * ONLY. These spawn real processes on the machine the API runs on (agent
 * CLIs like `claude`, `codex`, `grok`, …) and stream their output over SSE.
 *
 * Security model:
 *   - Every route 403s unless the request comes from a loopback address
 *     (127.0.0.0/8, ::1, or ::ffff:127.x) OR NEXUS_LOCAL_PTY_FORCE=1 is set
 *     (deliberate, for tests / remote debugging — never in production).
 *   - Command names are validated by @nexus/pty (isSafeCommandName) before
 *     PATH resolution; metacharacters never reach a shell.
 *   - Sessions are per-process (in-memory) and die with the API — there is
 *     no persistence surface and no cross-user access.
 *
 * Routes:
 *   GET    /local/pty           — list sessions
 *   POST   /local/pty           — spawn { command, args?, cwd?, cols?, rows? }
 *   GET    /local/pty/:id/stream — SSE: data events + exit event
 *   POST   /local/pty/:id/write  — { data }
 *   POST   /local/pty/:id/resize — { cols, rows }
 *   DELETE /local/pty/:id        — kill
 */
import { randomUUID } from "node:crypto";

import { PtyManager } from "@nexus/pty";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// ── Singleton ────────────────────────────────────────────────────────────────

const ptyManager = new PtyManager();

// ── Localhost gate ───────────────────────────────────────────────────────────

const FORCE_LOCAL = process.env.NEXUS_LOCAL_PTY_FORCE === "1";

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const v = ip.replace(/^::ffff:/, ""); // IPv4-mapped IPv6
  if (v === "::1" || v === "127.0.0.1") return true;
  if (v.startsWith("127.")) return true;
  return false;
}

async function gateLocal(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (FORCE_LOCAL || isLoopback(request.ip)) return;
  await reply.code(403).send({
    error: "local_only",
    message: "PTY routes are localhost-only (they spawn processes on this machine)",
  });
}

// Auth is provided by the /api scope hook (requireAuthWithTier) in server.ts;
// this gate adds the localhost-only restriction on top of it.
const requireLocal = {
  preHandler: [gateLocal],
};

// ── Route group ──────────────────────────────────────────────────────────────

/** Probe whether a local service (e.g. Ollama) answers on its configured URL. */
async function probeLocalService(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, method: "GET" });
      return res.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

export async function localPtyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /local/status — deployment-model surface (localhost only, like every
   * other /local route). Answers the questions an operator or the UI asks:
   * is this request loopback, is the PTY plane reachable, which agent CLIs
   * are installed, and is a local Ollama answering? On the hosted site this
   * route is 403 (the loopback gate) — which IS the answer to "is this the
   * local dev box or the deployed server".
   */
  app.get("/local/status", requireLocal, async (request, reply) => {
    const ollamaUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
    const [ollamaUp, codexPath, claudePath, codePath] = await Promise.all([
      probeLocalService(ollamaUrl),
      Promise.resolve(ptyManager.commandPath("codex")),
      Promise.resolve(ptyManager.commandPath("claude")),
      Promise.resolve(ptyManager.commandPath("code")),
    ]);
    return reply.send({
      local: {
        loopback: isLoopback(request.ip),
        forceEnabled: FORCE_LOCAL,
        ptyReachable: FORCE_LOCAL || isLoopback(request.ip),
      },
      pty: {
        sessions: ptyManager.list().length,
        live: ptyManager.liveCount,
      },
      agentClis: {
        codex: codexPath !== null,
        claude: claudePath !== null,
        vscode: codePath !== null,
      },
      ollama: {
        url: ollamaUrl,
        reachable: ollamaUp,
      },
      deployment: isLoopback(request.ip) ? "local" : FORCE_LOCAL ? "local_forced" : "hosted",
    });
  });

  /** GET /local/pty — list live sessions (tail included for context). */
  app.get("/local/pty", requireLocal, async (_req, reply) => {
    return reply.send({ sessions: ptyManager.list() });
  });

  /** POST /local/pty — spawn a PTY session. */
  app.post<{
    Body: {
      command?: string;
      args?: string[];
      cwd?: string;
      cols?: number;
      rows?: number;
    };
  }>("/local/pty", requireLocal, async (request, reply) => {
    const command = (request.body.command ?? "").trim();
    if (!command) {
      return reply.code(400).send({ error: "command_required", message: "command is required" });
    }
    if (command.length > 500) {
      return reply.code(400).send({ error: "command_too_long" });
    }
    const args = Array.isArray(request.body.args)
      ? request.body.args.map((a) => a.slice(0, 1000)).slice(0, 100)
      : [];
    try {
      const session = ptyManager.spawn({
        id: `pty-${randomUUID().slice(0, 12)}`,
        command,
        args,
        cwd: request.body.cwd,
        cols: Math.min(500, Math.max(10, Math.round(request.body.cols ?? 80))),
        rows: Math.min(200, Math.max(5, Math.round(request.body.rows ?? 24))),
      });
      return reply.code(201).send({ session });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: "spawn_failed", message: msg });
    }
  });

  /** GET /local/pty/:id/stream — SSE stream of output + exit. */
  app.get<{ Params: { id: string } }>(
    "/local/pty/:id/stream",
    requireLocal,
    async (request, reply) => {
      const id = request.params.id;
      let session;
      try {
        session = ptyManager.list().find((s) => s.id === id);
        if (!session)
          return reply.code(404).send({ error: "not_found", message: `no pty session ${id}` });
      } catch {
        return reply.code(404).send({ error: "not_found" });
      }
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sse = (ev: unknown) => {
        if (!raw.destroyed) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      };

      const offData = ptyManager.onData(id, (data) => sse({ type: "data", data }));
      const offExit = ptyManager.onExit(id, (info) => {
        sse({ type: "exit", ...info });
        offData();
        offExit();
        if (!raw.destroyed) raw.end();
      });
      raw.on("close", () => {
        offData();
        offExit();
      });
      // Initial state so the client knows what it attached to.
      sse({ type: "attached", id });
      if (session.exited) sse({ type: "exit", exitCode: session.exitCode, signal: session.signal });
    },
  );

  /** POST /local/pty/:id/write — send input to a session. */
  app.post<{ Params: { id: string }; Body: { data?: string } }>(
    "/local/pty/:id/write",
    requireLocal,
    async (request, reply) => {
      const data = request.body.data ?? "";
      if (typeof data !== "string" || data.length > 64_000) {
        return reply
          .code(400)
          .send({ error: "data_invalid", message: "body.data must be a string ≤ 64k" });
      }
      try {
        ptyManager.write(request.params.id, data);
        return reply.send({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: "write_failed", message: msg });
      }
    },
  );

  /** POST /local/pty/:id/resize — resize a session. */
  app.post<{ Params: { id: string }; Body: { cols?: number; rows?: number } }>(
    "/local/pty/:id/resize",
    requireLocal,
    async (request, reply) => {
      const cols = Math.min(500, Math.max(10, Math.round(request.body.cols ?? 80)));
      const rows = Math.min(200, Math.max(5, Math.round(request.body.rows ?? 24)));
      try {
        ptyManager.resize(request.params.id, cols, rows);
        return reply.send({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: "resize_failed", message: msg });
      }
    },
  );

  /** DELETE /local/pty/:id — kill AND remove a session (gone from the list). */
  app.delete<{ Params: { id: string } }>("/local/pty/:id", requireLocal, async (request, reply) => {
    ptyManager.remove(request.params.id);
    return reply.send({ ok: true });
  });
}
