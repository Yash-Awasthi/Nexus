// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime task routes
 *   GET    /api/v1/runtime/tasks
 *   POST   /api/v1/runtime/tasks
 *   GET    /api/v1/runtime/tasks/:taskId
 *   PATCH  /api/v1/runtime/tasks/:taskId   (cancel)
 *   POST   /api/v1/agent/run
 *   POST   /api/v1/apps/generate
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { db } from "@nexus/db";
import { ingestedEvents, runtimeTasks, signals } from "@nexus/db/schema";
import type { ExecAction } from "@nexus/exec-policy";
import type { SQL } from "drizzle-orm";
import { eq, desc, and } from "drizzle-orm";
import { userDrivePath } from "@nexus/sandbox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  enqueueJob,
  launchAgentRun,
  parseCompressHeader,
  runAgentInProcess,
  type LaunchAgentInput,
} from "../lib/agent-queue.js";
import {
  appFolderName,
  codegenInstruction,
  DESIGN_FILE,
  parseDesign,
  pickDesign,
  scaffoldApp,
} from "../lib/app-scaffold.js";
import { guardExec } from "../lib/exec-guard.js";
import { ownerScope } from "../lib/owner.js";
import { getUserDrivers } from "../lib/user-context.js";
import { requireAuth, requireAuthWithTier } from "../middleware/auth.js";

/** Agent-run options that widen what a run can reach (files, processes, tools). */
const RUN_SCOPE = [
  "workspaceDir",
  "worktree",
  "mcpServers",
  "permissionPolicy",
  "allowedTools",
  "ptcSandbox",
];

/** Worker jobs a bare API call may start; agent and browser runs have their own gated routes. */
const SUBMITTABLE = ["council.deliberate", "ingest:event"];

export async function runtimeRoutes(app: FastifyInstance): Promise<void> {
  // GET /runtime/tasks?status=&priority=&limit=&offset=
  app.get<{
    Querystring: {
      status?: string;
      priority?: string;
      limit?: string;
      offset?: string;
    };
  }>("/runtime/tasks", { preHandler: requireAuth }, async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? "50"), 200);
    const offset = parseInt(request.query.offset ?? "0");

    const conditions: SQL[] = [ownerScope(runtimeTasks.ownerId, request)];
    if (request.query.status) {
      conditions.push(eq(runtimeTasks.status, request.query.status as never));
    }
    if (request.query.priority) {
      conditions.push(eq(runtimeTasks.priority, request.query.priority as never));
    }

    const rows = await db
      .select()
      .from(runtimeTasks)
      .where(and(...conditions))
      .orderBy(desc(runtimeTasks.createdAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ tasks: rows, limit, offset });
  });

  // POST /runtime/tasks
  app.post<{
    Body: {
      type: string;
      payload: Record<string, unknown>;
      priority?: "low" | "medium" | "high";
      verdict_id?: string;
      idempotency_key?: string;
    };
  }>("/runtime/tasks", { preHandler: requireAuth }, async (request, reply) => {
    const { type, payload, priority, verdict_id, idempotency_key } = request.body;
    if (!type || !payload) return reply.code(400).send({ error: "type and payload are required" });
    if (!SUBMITTABLE.includes(type))
      return reply.code(400).send({ error: `type must be one of: ${SUBMITTABLE.join(", ")}` });
    // A job may only name the caller's own signal or event.
    for (const [field, table] of [
      ["signalId", signals],
      ["eventId", ingestedEvents],
    ] as const) {
      const id = payload[field];
      if (id === undefined) continue;
      const [own] =
        typeof id === "string"
          ? await db
              .select({ id: table.id })
              .from(table)
              .where(and(eq(table.id, id), ownerScope(table.ownerId, request)))
              .catch(() => [])
          : [];
      if (!own) return reply.code(404).send({ error: `${field} not found` });
    }

    const [row] = await db
      .insert(runtimeTasks)
      .values({
        type,
        payload,
        priority: priority ?? "medium",
        verdictId: verdict_id ?? null,
        idempotencyKey: idempotency_key ? `${request.nexusUserId ?? ""}:${idempotency_key}` : null,
        ownerId: request.nexusUserId ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      return reply.code(409).send({ error: "Task already exists (idempotency conflict)" });
    }
    const job = { ...payload, taskId: row.id, userId: request.nexusUserId };
    if (await enqueueJob(type, job, row.priority).catch(() => false))
      return reply.code(201).send(row);
    const [failed] = await db
      .update(runtimeTasks)
      .set({
        status: "failed",
        completedAt: new Date(),
        error: "No worker queue is configured (set REDIS_URL and run the worker).",
      })
      .where(eq(runtimeTasks.id, row.id))
      .returning();
    return reply.code(201).send(failed ?? row);
  });

  // POST /agent/run — launch a coding-agent run; stream it on /sse/agent/:sessionId
  app.post<{ Body: LaunchAgentInput & { approvalId?: string; disableGovernance?: unknown } }>(
    "/agent/run",
    { preHandler: requireAuthWithTier },
    async (request, reply) => launchAgent(request, reply, request.body),
  );

  // POST /apps/generate — scaffold a themed starter in the drive, then have an agent build on it
  app.post<{
    Body: {
      prompt?: string;
      design?: unknown;
      provider?: string;
      model?: string;
      sessionId?: string;
      approvalId?: string;
    };
  }>("/apps/generate", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = request.nexusUserId;
    if (!userId) return reply.code(401).send({ error: "auth_required" });
    const prompt = (request.body?.prompt ?? "").trim();
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });
    const { provider, model, sessionId, approvalId } = request.body;

    const name = appFolderName(userId, prompt);
    const dir = path.join(userDrivePath(userId), "apps", name);
    // Kept from the first call, so a replay after approval builds on the same starter.
    let design = await fs
      .readFile(path.join(dir, DESIGN_FILE), "utf8")
      .then((t) => parseDesign(JSON.parse(t)))
      .catch(() => null);
    if (!design) {
      const own = getUserDrivers().find((d) => !provider || d.id === provider)?.driver;
      design =
        parseDesign(request.body.design) ??
        (await pickDesign(
          prompt,
          own &&
            (async (q) =>
              (
                await own.complete({
                  model: model ?? own.model,
                  messages: [{ role: "user", content: q }],
                  maxTokens: 200,
                })
              ).content),
        ));
      await scaffoldApp(dir, name, design);
    }
    return launchAgent(request, reply, {
      instruction: codegenInstruction(prompt, design),
      workspaceDir: dir,
      maxSteps: 60,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(approvalId ? { approvalId } : {}),
    });
  });

  // GET /runtime/tasks/:taskId
  app.get<{ Params: { taskId: string } }>(
    "/runtime/tasks/:taskId",
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
      const [row] = await db
        .select()
        .from(runtimeTasks)
        .where(
          and(
            eq(runtimeTasks.id, request.params.taskId),
            ownerScope(runtimeTasks.ownerId, request),
          ),
        );

      if (!row) return reply.code(404).send({ error: "Task not found" });
      return reply.send(row);
    },
  );

  // PATCH /runtime/tasks/:taskId (cancel)
  app.patch<{
    Params: { taskId: string };
    Body: { action: "cancel" };
  }>("/runtime/tasks/:taskId", { preHandler: requireAuth }, async (request, reply) => {
    const { action } = request.body;
    if (action !== "cancel") {
      return reply.code(400).send({ error: "Only 'cancel' action is supported" });
    }

    const [updated] = await db
      .update(runtimeTasks)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(
        and(
          eq(runtimeTasks.id, request.params.taskId),
          eq(runtimeTasks.status, "queued"),
          ownerScope(runtimeTasks.ownerId, request),
        ),
      )
      .returning();

    if (!updated) {
      return reply.code(409).send({ error: "Task cannot be cancelled (not in queued state)" });
    }
    return reply.send(updated);
  });
}

/** Launch a coding-agent run behind the per-run exec approval; stream it on /sse/agent/:sessionId. */
async function launchAgent(
  request: FastifyRequest,
  reply: FastifyReply,
  body: (LaunchAgentInput & { approvalId?: string; disableGovernance?: unknown }) | undefined,
): Promise<FastifyReply | undefined> {
  const instruction = (body?.instruction ?? "").trim();
  if (!instruction) return reply.code(400).send({ error: "instruction is required" });

  // The agent's run_command is model-written shell on the worker host: one approval per run.
  const { approvalId, disableGovernance: _ignored, ...input } = body!;
  const clientId =
    typeof input.sessionId === "string" && /^[\w-]{8,64}$/.test(input.sessionId)
      ? input.sessionId
      : undefined;
  // Derived from the account, so a client-chosen id never lands on another account's run;
  // UUID-shaped because agent_sessions keys on it.
  const sessionId = clientId
    ? createHash("sha256")
        .update(`${request.nexusUserId ?? ""}:${clientId}`)
        .digest("hex")
        .slice(0, 32)
        .replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-")
    : randomUUID();
  // What the run may touch is part of what is approved: a replay that changes it asks again.
  const scope = Object.fromEntries(
    RUN_SCOPE.filter((k) => input[k as keyof typeof input] !== undefined).map((k) => [
      k,
      input[k as keyof typeof input],
    ]),
  );
  const shell: ExecAction = {
    surface: "pty",
    command: "bash",
    args: [
      "--agent",
      sessionId,
      ...(Object.keys(scope).length ? ["--scope", JSON.stringify(scope)] : []),
    ],
  };
  const bound = { field: "sessionId", named: !!clientId };
  if ((await guardExec(request, reply, shell, approvalId, bound)) === "handled") return;

  // x-nexus-compress header overrides any body value (explicit opt-in/out).
  const headerCompress = parseCompressHeader(request.headers["x-nexus-compress"]);
  const job = {
    ...input,
    sessionId,
    userId: request.nexusUserId,
    instruction,
    ...(headerCompress !== undefined ? { compressToolOutput: headerCompress } : {}),
  };
  let launched = await launchAgentRun(job);
  if (!launched) {
    // No queue: run here on the caller's own key for the named provider.
    const mine = getUserDrivers();
    const own = input.provider ? mine.find((d) => d.id === input.provider) : mine[0];
    if (!own)
      return reply.code(503).send({
        error: "no_provider_key",
        message: `Save a provider key${input.provider ? ` for ${input.provider}` : ""} first.`,
      });
    launched = await runAgentInProcess({ ...job, provider: own.id }, own.driver);
  }
  return reply.code(202).send({
    ...launched,
    stream: `/api/v1/sse/agent/${launched.sessionId}`,
  });
}
