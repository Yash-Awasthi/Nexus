// SPDX-License-Identifier: Apache-2.0
/**
 * Admin traces — the model calls made while serving each request.
 *
 * GET  /api/v1/traces       — list traces (?page, ?limit, ?type)
 * GET  /api/v1/traces/:id   — one trace with its steps
 *
 * Same store as the /api/traces surface the admin page reads (lib/request-traces).
 */

import type { FastifyInstance } from "fastify";

import { getTrace, listTraces } from "../lib/request-traces.js";

import { requireAdminRole } from "./admin-users.js";

export async function adminTracesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { page?: string; limit?: string; type?: string } }>(
    "/",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(request.query.limit ?? "50", 10) || 50));
      return reply.send(await listTraces({ type: request.query.type, page, limit }));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: requireAdminRole },
    async (request, reply) => {
      const trace = await getTrace(request.params.id);
      if (!trace) return reply.code(404).send({ error: "trace_not_found" });
      return reply.send(trace);
    },
  );
}
