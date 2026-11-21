// SPDX-License-Identifier: Apache-2.0
/**
 * Code-agent surface OWNER — extracted from api-bridge.ts.
 *
 * One-shot execution, persistent kernel sessions and the LLM-writes-code path.
 * Kernels live with this module so a session list can never leak another
 * account's kernel; the bridge hands in Docker readiness and its LLM wiring
 * rather than this module importing the bridge back.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import { DockerReplExecutor, KernelManager, type ReplLanguage } from "@nexus/code-repl";
import type { LlmRole, LlmUsage } from "@nexus/llm/drivers";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { guardExec } from "../lib/exec-guard.ts";
import { ownerIdFor } from "../lib/owner.ts";
import { runUntrustedJs } from "../lib/untrusted-js.ts";

import { runViaPiston, runViaPyodide } from "./sandbox.ts";

/** Bridge-owned state and LLM wiring the code-agent routes need. */
interface CodeAgentRoutesDeps {
  /** Docker presence, probed once at registration (a promise while the probe runs). */
  dockerReady: boolean | Promise<boolean>;
  getDriver: () => CodeAgentDriver | undefined;
  defaultModel: () => string;
  trackServed: (
    res: { model?: string; usage?: LlmUsage; provider?: string },
    requested: string,
  ) => void;
}

/** The slice of the failover driver these routes use. */
interface CodeAgentDriver {
  complete(opts: {
    model: string;
    messages: { role: LlmRole; content: string }[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string; model?: string; usage?: LlmUsage; provider?: string }>;
}

const now = (): string => new Date().toISOString();
const systemMsg = (content: string) => ({ role: "system" as LlmRole, content });
const userMsg = (content: string) => ({ role: "user" as LlmRole, content });

/** Register /code-agent/* plus the build-runner alias. */
export async function codeAgentRoutes(
  app: FastifyInstance,
  deps: CodeAgentRoutesDeps,
): Promise<void> {
  // ══════════════════════════════════════════════════════════════════════════
  // C.3 — code-agent: sandboxed code execution via @nexus/code-repl
  //        Routes: POST /code-agent/execute (one-shot)
  //                POST /code-agent/sessions (create persistent kernel)
  //                GET  /code-agent/sessions (list sessions)
  //                POST /code-agent/sessions/:id/execute (stateful run)
  //                DELETE /code-agent/sessions/:id (destroy session)
  //        Also wires: POST /build/run (same executor, build-task flavour)
  // ══════════════════════════════════════════════════════════════════════════

  const _kernelManager = new KernelManager({
    executor: new DockerReplExecutor(),
    jupyterMode: true,
  });

  /** Kernels run code, so the exec policy decides first: readonly mode and deny rules apply. */
  const replRefused = async (request: FastifyRequest, reply: FastifyReply, language: string) =>
    (await guardExec(request, reply, { surface: "repl", command: language })) === "handled";

  // A kernel holds its caller's variables and files; ids are sequential, so ownership is the guard.
  const _kernelOwners = new Map<string, string>();
  const ownsKernel = (request: FastifyRequest, id: string) =>
    _kernelOwners.get(id) === ownerIdFor(request);

  /** The kernels, or null after a 503: without Docker nothing runs, and an empty success would lie. */
  async function _getKernelManager(reply: FastifyReply): Promise<KernelManager | null> {
    if (await deps.dockerReady) return _kernelManager;
    await reply
      .code(503)
      .send({ error: "docker_required", message: "Running code needs Docker on this machine." });
    return null;
  }

  /**
   * POST /code-agent/execute — one-shot stateless code execution.
   * Body: { code: string, language?: "python"|"r"|"julia", timeoutMs?: number }
   */
  app.post<{
    Body: { code: string; language?: ReplLanguage; timeoutMs?: number };
  }>(
    "/code-agent/execute",
    {
      schema: {
        body: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string", maxLength: 32_768 },
            language: { type: "string", enum: ["python", "r", "julia"] },
            timeoutMs: { type: "number", minimum: 100, maximum: 30_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { code, language = "python", timeoutMs = 10_000 } = request.body;
      if (await replRefused(request, reply, language)) return;
      const km = await _getKernelManager(reply);
      if (!km) return;
      const session = km.create(language);
      try {
        const result = await session.execute({ code, timeoutMs });
        return reply.send({
          language,
          stdout: result.stdout,
          stderr: result.stderr,
          displayData: result.displayData,
          lastExpression: result.lastExpression,
          executionCount: session.executionCount,
        });
      } finally {
        km.destroy(session.id);
      }
    },
  );

  /** POST /code-agent/sessions — create a persistent kernel session. */
  app.post<{ Body: { language?: ReplLanguage } }>(
    "/code-agent/sessions",
    {
      schema: {
        body: {
          type: "object",
          properties: { language: { type: "string", enum: ["python", "r", "julia"] } },
        },
      },
    },
    async (request, reply) => {
      const language = request.body?.language ?? "python";
      const km = await _getKernelManager(reply);
      if (!km) return;
      const session = km.create(language);
      _kernelOwners.set(session.id, ownerIdFor(request));
      return reply.code(201).send({
        sessionId: session.id,
        language,
        createdAt: now(),
      });
    },
  );

  /** GET /code-agent/sessions — list active kernel sessions. */
  app.get("/code-agent/sessions", async (request, reply) => {
    const km = _kernelManager;
    return reply.send({
      sessions: km
        .list()
        .filter((s) => ownsKernel(request, s.id))
        .map((s) => ({
          sessionId: s.id,
          language: s.language,
          executionCount: s.executionCount,
          lastUsedAt: s.state_.lastUsedAt ?? null,
        })),
    });
  });

  /**
   * POST /code-agent/sessions/:id/execute — run code in an existing session.
   * Body: { code: string, timeoutMs?: number }
   */
  app.post<{
    Params: { id: string };
    Body: { code: string; timeoutMs?: number };
  }>(
    "/code-agent/sessions/:id/execute",
    {
      schema: {
        body: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string", maxLength: 32_768 },
            timeoutMs: { type: "number", minimum: 100, maximum: 30_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const km = await _getKernelManager(reply);
      if (!km) return;
      const session = ownsKernel(request, request.params.id)
        ? km.get(request.params.id)
        : undefined;
      if (!session) {
        return reply.code(404).send({ error: "session_not_found", sessionId: request.params.id });
      }
      const { code, timeoutMs = 10_000 } = request.body;
      if (await replRefused(request, reply, session.language)) return;
      const result = await session.execute({ code, timeoutMs });
      return reply.send({
        sessionId: request.params.id,
        stdout: result.stdout,
        stderr: result.stderr,
        displayData: result.displayData,
        lastExpression: result.lastExpression,
        executionCount: session.executionCount,
      });
    },
  );

  /** DELETE /code-agent/sessions/:id — destroy a kernel session. */
  app.delete<{ Params: { id: string } }>("/code-agent/sessions/:id", async (request, reply) => {
    const km = _kernelManager;
    if (!ownsKernel(request, request.params.id) || !km.has(request.params.id)) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    km.destroy(request.params.id);
    _kernelOwners.delete(request.params.id);
    return reply.code(204).send();
  });

  /**
   * POST /code-agent/run — LLM writes code for a task, then executes it.
   * Body: { task: string, language?: string, apiKey?: string, model?: string, provider?: string }
   * Returns AgentSession shape.
   */
  app.post<{
    Body: {
      task: string;
      language?: string;
      apiKey?: string;
      model?: string;
      provider?: string;
    };
  }>("/code-agent/run", async (request, reply) => {
    const { task, language = "python" } = request.body ?? {};
    if (!task?.trim()) return reply.code(400).send({ error: "task is required" });
    const gate = { surface: "sandbox" as const, command: language.toLowerCase() };
    if ((await guardExec(request, reply, gate)) === "handled") return;
    const driver = deps.getDriver();
    if (!driver) {
      return reply.code(402).send({
        error: "no_api_key",
        message: "Add your API key in Language Models settings (BYOK) to use Code Agent.",
      });
    }

    const sessionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const systemPrompt = `You are a code generation assistant. Write clean, runnable ${language} code to complete the task.
Output ONLY the code — no markdown fences, no explanation, no comments unless required by the code.`;

    try {
      // Step 1: Generate code via the caller's model
      const res = await driver.complete({
        model: deps.defaultModel(),
        messages: [systemMsg(systemPrompt), userMsg(task)],
        temperature: 0.2,
        maxTokens: 2048,
      });
      deps.trackServed(res, deps.defaultModel());
      const generatedCode = res.content
        .trim()
        .replace(/^```[a-z]*\n?/, "")
        .replace(/\n?```$/, "");
      if (!generatedCode) {
        return reply.code(502).send({ error: "empty_code", message: "LLM returned no code" });
      }

      // Step 2: Execute the generated code
      const lang = language.toLowerCase();
      let finalOutput = "";
      let finalError: string | undefined;
      const iterations = 1;

      if (lang === "javascript" || lang === "js") {
        const r = await runUntrustedJs(generatedCode, 5_000);
        finalOutput = r.stdout;
        finalError = r.exitCode === 0 ? undefined : r.stderr;
      } else if (lang === "python" || lang === "py" || lang === "python3") {
        // Python runs locally via Pyodide (WASM) — no Piston needed.
        try {
          const pr = await runViaPyodide(generatedCode);
          finalOutput = pr.stdout;
          finalError = pr.exitCode !== 0 ? pr.stderr : undefined;
        } catch (e) {
          finalError = e instanceof Error ? e.message : String(e);
        }
      } else {
        // Other languages → Piston (guarded against the dead public endpoint).
        try {
          const pr = await runViaPiston(generatedCode, lang);
          finalOutput = pr.stdout;
          finalError = pr.exitCode !== 0 ? pr.stderr : undefined;
        } catch (e) {
          finalError = e instanceof Error ? e.message : String(e);
        }
      }

      return reply.send({
        sessionId,
        task,
        language,
        status: finalError ? "error" : "success",
        iterations,
        code: generatedCode,
        finalOutput: finalOutput || undefined,
        finalError,
        createdAt,
      });
    } catch (err) {
      return reply.code(500).send({
        error: "agent_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
