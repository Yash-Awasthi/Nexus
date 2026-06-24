// SPDX-License-Identifier: Apache-2.0
/**
 * Admin traces routes — in-memory request trace store.
 *
 * GET  /api/v1/admin-traces       — list traces (paginated)
 * GET  /api/v1/admin-traces/:id   — get a single trace by ID
 *
 * Uses requireAuthWithTier so only authenticated users with a verified
 * tier can access admin trace data.
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { requireAuthWithTier } from "../middleware/auth.js";

// ── Types ──────────────────────────────────────────────────────────────────────

interface AdminTrace {
  id: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  userId: string | null;
  ip: string;
  timestamp: string;
}

// ── In-memory store ────────────────────────────────────────────────────────────

const traces: AdminTrace[] = [];

// Seed a few sample traces for demo / development
traces.push(
  {
    id: randomUUID(),
    method: "GET",
    path: "/api/v1/admin/routes",
    statusCode: 200,
    durationMs: 12,
    userId: "seed-user-001",
    ip: "127.0.0.1",
    timestamp: new Date(Date.now() - 60_000).toISOString(),
  },
  {
    id: randomUUID(),
    method: "POST",
    path: "/api/v1/gauntlet/run",
    statusCode: 200,
    durationMs: 4_200,
    userId: "seed-user-001",
    ip: "127.0.0.1",
    timestamp: new Date(Date.now() - 30_000).toISOString(),
  },
  {
    id: randomUUID(),
    method: "GET",
    path: "/api/v1/admin/settings",
    statusCode: 200,
    durationMs: 8,
    userId: "seed-user-002",
    ip: "10.0.0.2",
    timestamp: new Date(Date.now() - 10_000).toISOString(),
  },
);

// ── Router ─────────────────────────────────────────────────────────────────────

export async function adminTracesRoutes(app: FastifyInstance): Promise<void> {
  /** GET / — list traces (supports ?limit and ?offset query params) */
  app.get<{
    Querystring: { limit?: string; offset?: string };
  }>(
    "/",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? "50", 10), 500);
      const offset = parseInt(request.query.offset ?? "0", 10);
      const page = traces.slice(offset, offset + limit);
      return reply.send({ traces: page, total: traces.length, limit, offset });
    },
  );

  /** GET /:id — get a single trace by ID */
  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const trace = traces.find((t) => t.id === request.params.id);
      if (!trace) return reply.code(404).send({ error: "trace_not_found" });
      return reply.send(trace);
    },
  );
}
