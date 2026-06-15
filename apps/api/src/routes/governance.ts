// SPDX-License-Identifier: Apache-2.0
/**
 * Governance routes
 *   GET    /api/v1/governance/approvals
 *   POST   /api/v1/governance/approvals
 *   GET    /api/v1/governance/approvals/:approvalId
 *   POST   /api/v1/governance/approvals/:approvalId/approve
 *   POST   /api/v1/governance/approvals/:approvalId/reject
 */

import { db } from "@nexus/db";
import { approvalRequests, runtimeTasks } from "@nexus/db/schema";
import type { SQL } from "drizzle-orm";
import { eq, and, desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

export async function governanceRoutes(app: FastifyInstance): Promise<void> {
  // GET /governance/approvals?status=pending
  app.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/governance/approvals", { preHandler: requireAuth }, async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? "50"), 200);
    const offset = parseInt(request.query.offset ?? "0");

    const conditions: SQL[] = [];
    if (request.query.status) {
      conditions.push(eq(approvalRequests.status, request.query.status as never));
    }

    const rows = await db
      .select()
      .from(approvalRequests)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(approvalRequests.createdAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ approvals: rows, limit, offset });
  });

  // POST /governance/approvals
  app.post<{
    Body: {
      entity_type: string;
      entity_id: string;
      action: string;
      requestor: string;
      context?: Record<string, unknown>;
      expires_in_minutes?: number;
    };
  }>("/governance/approvals", { preHandler: requireAuth }, async (request, reply) => {
    const { entity_type, entity_id, action, requestor, context, expires_in_minutes } = request.body;

    const expiresAt = expires_in_minutes
      ? new Date(Date.now() + expires_in_minutes * 60_000)
      : null;

    const [row] = await db
      .insert(approvalRequests)
      .values({
        entityType: entity_type,
        entityId: entity_id,
        action,
        requestor,
        context: context ?? null,
        expiresAt,
      })
      .returning();

    return reply.code(201).send(row);
  });

  // GET /governance/approvals/:approvalId
  app.get<{ Params: { approvalId: string } }>(
    "/governance/approvals/:approvalId",
    { schema: { response: { 200: { type: "object", additionalProperties: true }, 201: { type: "object", additionalProperties: true } } }, preHandler: requireAuth },
    async (request, reply) => {
      const [row] = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, request.params.approvalId));

      if (!row) return reply.code(404).send({ error: "Approval not found" });
      return reply.send(row);
    },
  );

  // POST /governance/approvals/:approvalId/approve
  app.post<{
    Params: { approvalId: string };
    Body: { resolved_by: string; reason?: string };
  }>(
    "/governance/approvals/:approvalId/approve",
    { preHandler: requireAuth },
    async (request, reply) => {
      const [updated] = await db
        .update(approvalRequests)
        .set({
          status: "approved",
          resolution: "approved",
          resolvedBy: request.body.resolved_by,
          reason: request.body.reason ?? null,
          resolvedAt: new Date(),
        })
        .where(
          and(
            eq(approvalRequests.id, request.params.approvalId),
            eq(approvalRequests.status, "pending"),
          ),
        )
        .returning();

      if (!updated) {
        return reply.code(409).send({ error: "Approval is not in pending state" });
      }

      // If this approval unblocks a task, update its status to queued
      if (updated.entityType === "task") {
        await db
          .update(runtimeTasks)
          .set({ status: "queued" })
          .where(
            and(
              eq(runtimeTasks.id, updated.entityId),
              eq(runtimeTasks.status, "awaiting_approval"),
            ),
          );
      }

      return reply.send(updated);
    },
  );

  // POST /governance/approvals/:approvalId/reject
  app.post<{
    Params: { approvalId: string };
    Body: { resolved_by: string; reason?: string };
  }>(
    "/governance/approvals/:approvalId/reject",
    { preHandler: requireAuth },
    async (request, reply) => {
      const [updated] = await db
        .update(approvalRequests)
        .set({
          status: "rejected",
          resolution: "rejected",
          resolvedBy: request.body.resolved_by,
          reason: request.body.reason ?? null,
          resolvedAt: new Date(),
        })
        .where(
          and(
            eq(approvalRequests.id, request.params.approvalId),
            eq(approvalRequests.status, "pending"),
          ),
        )
        .returning();

      if (!updated) {
        return reply.code(409).send({ error: "Approval is not in pending state" });
      }

      // Cancel the associated task if it was awaiting approval
      if (updated.entityType === "task") {
        await db
          .update(runtimeTasks)
          .set({ status: "cancelled", completedAt: new Date() })
          .where(
            and(
              eq(runtimeTasks.id, updated.entityId),
              eq(runtimeTasks.status, "awaiting_approval"),
            ),
          );
      }

      return reply.send(updated);
    },
  );
}
