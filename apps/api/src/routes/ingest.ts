// SPDX-License-Identifier: Apache-2.0
/**
 * Ingest routes — POST /api/v1/ingest/events, GET /api/v1/ingest/events/:id,
 *                 POST /api/v1/ingest/signals, GET /api/v1/ingest/signals,
 *                 GET /api/v1/ingest/signals/:id
 */

import { db } from "@nexus/db";
import { ingestedEvents, signals } from "@nexus/db/schema";
import type { SQL } from "drizzle-orm";
import { eq, desc, and } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { enqueueJob } from "../lib/agent-queue.js";
import { ownerScope } from "../lib/owner.js";
import { requireAuth } from "../middleware/auth.js";

// ── /ingest/events ────────────────────────────────────────────────────────────

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  // POST /ingest/events
  app.post<{
    Body: {
      source: string;
      event_type: string;
      payload: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      idempotency_key?: string;
      priority?: string;
    };
  }>("/ingest/events", { preHandler: requireAuth }, async (request, reply) => {
    const { source, event_type, payload, metadata, idempotency_key } = request.body;
    const priority = request.body.priority ?? "medium";
    if (!source || !event_type || !payload)
      return reply.code(400).send({ error: "source, event_type and payload are required" });
    if (priority !== "high" && priority !== "medium" && priority !== "low")
      return reply.code(400).send({ error: "priority must be high, medium or low" });

    // Keys are per account, so one account's key never collides with another's.
    const key = idempotency_key ? `${request.nexusUserId ?? ""}:${idempotency_key}` : null;
    try {
      const [row] = await db
        .insert(ingestedEvents)
        .values({
          source,
          eventType: event_type,
          payload,
          metadata: metadata ?? null,
          idempotencyKey: key,
          ownerId: request.nexusUserId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: ingestedEvents.id });

      if (!row) {
        const [prior] = key
          ? await db
              .select({ id: ingestedEvents.id })
              .from(ingestedEvents)
              .where(eq(ingestedEvents.idempotencyKey, key))
          : [];
        return reply.code(202).send({ event_id: prior?.id ?? null, status: "duplicate" });
      }
      const job = {
        eventId: row.id,
        source,
        eventType: event_type,
        payload,
        ownerId: request.nexusUserId ?? null,
      };
      if (!(await enqueueJob("ingest:event", job, priority).catch(() => false))) {
        // No queue (the desktop app): turn it into a signal here.
        const { handleIngestJob } = await import("@nexus/worker/ingest-handler");
        await handleIngestJob(job);
      }
      return reply.code(202).send({ event_id: row.id, status: "accepted" });
    } catch (err) {
      request.log.error(err, "ingest/events insert failed");
      return reply.code(500).send({ error: "Internal error" });
    }
  });

  // GET /ingest/events/:eventId
  app.get<{ Params: { eventId: string } }>(
    "/ingest/events/:eventId",
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
        .from(ingestedEvents)
        .where(
          and(
            eq(ingestedEvents.id, request.params.eventId),
            ownerScope(ingestedEvents.ownerId, request),
          ),
        );

      if (!row) return reply.code(404).send({ error: "Event not found" });
      return reply.send(row);
    },
  );

  // ── /ingest/signals ─────────────────────────────────────────────────────────

  // GET /ingest/signals?signal_type=&priority=&limit=&offset=
  app.get<{
    Querystring: {
      signal_type?: string;
      priority?: string;
      limit?: string;
      offset?: string;
    };
  }>("/ingest/signals", { preHandler: requireAuth }, async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? "50"), 200);
    const offset = parseInt(request.query.offset ?? "0");

    const conditions: SQL[] = [ownerScope(signals.ownerId, request)];
    if (request.query.signal_type) {
      conditions.push(eq(signals.signalType, request.query.signal_type));
    }
    if (request.query.priority) {
      conditions.push(eq(signals.priority, request.query.priority as never));
    }

    const rows = await db
      .select()
      .from(signals)
      .where(and(...conditions))
      .orderBy(desc(signals.createdAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ signals: rows, limit, offset });
  });

  // POST /ingest/signals
  app.post<{
    Body: {
      signal_type: string;
      source_event_ids?: string[];
      summary: string;
      priority?: "low" | "medium" | "high" | "critical";
      metadata?: Record<string, unknown>;
    };
  }>("/ingest/signals", { preHandler: requireAuth }, async (request, reply) => {
    const { signal_type, source_event_ids, summary, priority, metadata } = request.body;
    if (!signal_type || !summary)
      return reply.code(400).send({ error: "signal_type and summary are required" });

    const [row] = await db
      .insert(signals)
      .values({
        signalType: signal_type,
        sourceEventIds: source_event_ids ?? [],
        summary,
        priority: priority ?? "medium",
        metadata: metadata ?? null,
        ownerId: request.nexusUserId ?? null,
      })
      .returning();

    return reply.code(201).send(row);
  });

  // GET /ingest/signals/:signalId
  app.get<{ Params: { signalId: string } }>(
    "/ingest/signals/:signalId",
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
        .from(signals)
        .where(and(eq(signals.id, request.params.signalId), ownerScope(signals.ownerId, request)));

      if (!row) return reply.code(404).send({ error: "Signal not found" });
      return reply.send(row);
    },
  );
}
