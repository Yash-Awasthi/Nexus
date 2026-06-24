// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime task routes
 *   GET    /api/v1/runtime/tasks
 *   POST   /api/v1/runtime/tasks
 *   GET    /api/v1/runtime/tasks/:taskId
 *   PATCH  /api/v1/runtime/tasks/:taskId   (cancel)
 */

import { db } from "@nexus/db";
import { runtimeTasks } from "@nexus/db/schema";
import type { SQL } from "drizzle-orm";
import { eq, desc, and } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { launchAgentRun, type LaunchAgentInput } from "../lib/agent-queue.js";
import { requireAuth } from "../middleware/auth.js";

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

    const conditions: SQL[] = [];
    if (request.query.status) {
      conditions.push(eq(runtimeTasks.status, request.query.status as never));
    }
    if (request.query.priority) {
      conditions.push(eq(runtimeTasks.priority, request.query.priority as never));
    }

    const rows = await db
      .select()
      .from(runtimeTasks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
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

    const [row] = await db
      .insert(runtimeTasks)
      .values({
        type,
        payload,
        priority: priority ?? "medium",
        verdictId: verdict_id ?? null,
        idempotencyKey: idempotency_key ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      return reply.code(409).send({ error: "Task already exists (idempotency conflict)" });
    }
    return reply.code(201).send(row);
  });

  // POST /agent/run — launch a coding-agent run; stream it on /sse/agent/:sessionId
  app.post<{ Body: LaunchAgentInput }>(
    "/agent/run",
    { preHandler: requireAuth },
    async (request, reply) => {
      const instruction = (request.body?.instruction ?? "").trim();
      if (!instruction) return reply.code(400).send({ error: "instruction is required" });

      const launched = await launchAgentRun({ ...request.body, instruction });
      if (!launched) {
        return reply.code(503).send({ error: "agent queue unavailable (REDIS_URL not configured)" });
      }
      return reply.code(202).send({
        ...launched,
        stream: `/api/v1/sse/agent/${launched.sessionId}`,
      });
    },
  );

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
        .where(eq(runtimeTasks.id, request.params.taskId));

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
      .where(and(eq(runtimeTasks.id, request.params.taskId), eq(runtimeTasks.status, "queued")))
      .returning();

    if (!updated) {
      return reply.code(409).send({ error: "Task cannot be cancelled (not in queued state)" });
    }
    return reply.send(updated);
  });
}
