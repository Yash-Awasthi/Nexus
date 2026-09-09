// SPDX-License-Identifier: Apache-2.0
/**
 * Session spider-graph routes — read surface for the zero-write-cost memory
 * store (lib/session-graph.ts).
 *
 *   GET /api/session-graph            — recent graphs for the caller (summary)
 *   GET /api/session-graph/:id        — full graph (nodes + edges)
 *
 * Auth: registered under the /api scoped block in server.ts (requireAuth —
 * validates, but does NOT resolve the caller id). These routes therefore add
 * their own requireAuthWithTier preHandler, mirroring threads.ts, so
 * `request.nexusUserId` is set — the capture sites (research.ts, threads.ts)
 * all use requireAuthWithTier, and reads must resolve the same identity or
 * they'd look under the wrong key prefix. Per-user isolation is additionally
 * enforced by the store (keys are prefixed with the user id).
 */

import type { FastifyInstance } from "fastify";

import { getSessionGraph, listSessionGraphs, type SessionGraph } from "../lib/session-graph.js";
import { requireAuthWithTier } from "../middleware/auth.js";

const AUTH = { preHandler: requireAuthWithTier };

/** Trim heavy payloads for the list view — counts only, not node bodies. */
function summarize(g: SessionGraph) {
  return {
    sessionId: g.sessionId,
    kind: g.kind,
    title: g.title,
    nodeCount: g.nodes.length,
    edgeCount: g.edges.length,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

export async function sessionGraphRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string } }>("/session-graph", AUTH, async (request, reply) => {
    const limit = Math.min(Math.max(parseInt(request.query.limit ?? "50", 10) || 50, 1), 100);
    const graphs = await listSessionGraphs(request.nexusUserId, limit);
    return reply.send({ graphs: graphs.map(summarize) });
  });

  app.get<{ Params: { id: string } }>("/session-graph/:id", AUTH, async (request, reply) => {
    const graph = await getSessionGraph(request.nexusUserId, request.params.id);
    if (!graph) return reply.code(404).send({ error: "not_found" });
    return reply.send({ graph });
  });
}
