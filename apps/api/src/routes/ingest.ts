// SPDX-License-Identifier: Apache-2.0
/**
 * Ingest routes — POST /api/v1/ingest/events, GET /api/v1/ingest/events/:id,
 *                 POST /api/v1/ingest/signals, GET /api/v1/ingest/signals,
 *                 GET /api/v1/ingest/signals/:id
 */

import { randomUUID } from "crypto";

import { db } from "@nexus/db";
import { ingestedEvents, signals } from "@nexus/db/schema";
import type { SQL } from "drizzle-orm";
import { eq, desc, and } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

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
  }>(
    "/ingest/events",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { source, event_type, payload, metadata, idempotency_key } = request.body;

      try {
        const [row] = await db
          .insert(ingestedEvents)
          .values({
            source,
            eventType: event_type,
            payload,
            metadata: metadata ?? null,
            idempotencyKey: idempotency_key ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: ingestedEvents.id });

        const eventId = row?.id ?? randomUUID();
        return reply.code(202).send({ event_id: eventId, status: "accepted" });
      } catch (err) {
        request.log.error(err, "ingest/events insert failed");
        return reply.code(500).send({ error: "Internal error" });
      }
    },
  );

  // GET /ingest/events/:eventId
  app.get<{ Params: { eventId: string } }>(
    "/ingest/events/:eventId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const [row] = await db
        .select()
        .from(ingestedEvents)
        .where(eq(ingestedEvents.id, request.params.eventId));

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
  }>(
    "/ingest/signals",
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? "50"), 200);
      const offset = parseInt(request.query.offset ?? "0");

      const conditions: SQL[] = [];
      if (request.query.signal_type) {
        conditions.push(eq(signals.signalType, request.query.signal_type));
      }
      if (request.query.priority) {
        conditions.push(eq(signals.priority, request.query.priority as never));
      }

      const rows = await db
        .select()
        .from(signals)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(signals.createdAt))
        .limit(limit)
        .offset(offset);

      return reply.send({ signals: rows, limit, offset });
    },
  );

  // POST /ingest/signals
  app.post<{
    Body: {
      signal_type: string;
      source_event_ids?: string[];
      summary: string;
      priority?: "low" | "medium" | "high" | "critical";
      metadata?: Record<string, unknown>;
    };
  }>(
    "/ingest/signals",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { signal_type, source_event_ids, summary, priority, metadata } = request.body;

      const [row] = await db
        .insert(signals)
        .values({
          signalType: signal_type,
          sourceEventIds: source_event_ids ?? [],
          summary,
          priority: priority ?? "medium",
          metadata: metadata ?? null,
        })
        .returning();

      return reply.code(201).send(row);
    },
  );

  // GET /ingest/signals/:signalId
  app.get<{ Params: { signalId: string } }>(
    "/ingest/signals/:signalId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const [row] = await db
        .select()
        .from(signals)
        .where(eq(signals.id, request.params.signalId));

      if (!row) return reply.code(404).send({ error: "Signal not found" });
      return reply.send(row);
    },
  );
}
