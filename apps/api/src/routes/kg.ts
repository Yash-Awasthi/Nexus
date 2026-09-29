// SPDX-License-Identifier: Apache-2.0
/**
 * POST /kg/sync exchanges knowledge-graph state with a federated peer over the
 * CRDT join in @nexus/knowledge-graph, so one round trip converges both sides.
 * GET /kg/communities, GET /kg/search and GET /kg/graph read the caller's own graph;
 * DELETE /kg/nodes/:id and DELETE /kg/edges/:id remove from it, leaving tombstones that
 * a sync carries to peers so a deleted fact does not come back.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import {
  graphSearch,
  mergeSnapshots,
  summarizeCommunities,
  type KGEdge,
  type KGNode,
  type KGSearchType,
} from "@nexus/knowledge-graph";
import type { FastifyInstance } from "fastify";

import { getKGStore } from "../lib/knowledge-graph-store.js";

const SEARCH_TYPES: KGSearchType[] = [
  "ENTITIES",
  "TRIPLETS",
  "LOCAL_GRAPH",
  "COMMUNITY",
  "GRAPH_COMPLETION",
  "LEXICAL",
];

const MAX_GRAPH_NODES = 300;

export async function kgRoutes(app: FastifyInstance): Promise<void> {
  /** The best-connected entities and the relationships between them, for drawing the graph. */
  app.get<{ Querystring: { limit?: string } }>("/kg/graph", async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 150, 1), MAX_GRAPH_NODES);
    const store = getKGStore();
    const [nodes, edges] = await Promise.all([store.findNodes({}), store.findEdges({})]);
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.subjectId, (degree.get(e.subjectId) ?? 0) + 1);
      degree.set(e.objectId, (degree.get(e.objectId) ?? 0) + 1);
    }
    const shown = nodes
      .map((n) => ({ id: n.id, name: n.name, type: n.type, rank: degree.get(n.id) ?? 0 }))
      .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
      .slice(0, limit);
    const ids = new Set(shown.map((n) => n.id));
    return reply.send({
      nodes: shown,
      edges: edges
        .filter((e) => ids.has(e.subjectId) && ids.has(e.objectId))
        .map((e) => ({
          id: e.id,
          subjectId: e.subjectId,
          predicate: e.predicate,
          objectId: e.objectId,
        })),
      total: { nodes: nodes.length, edges: edges.length },
    });
  });

  /** Removes an entity and every relationship that touches it. */
  app.delete<{ Params: { id: string } }>("/kg/nodes/:id", async (request, reply) => {
    const store = getKGStore();
    if (!(await store.getNode(request.params.id))) {
      return reply.code(404).send({ error: "entity not found" });
    }
    const touching = new Map<string, true>();
    for (const q of [{ subjectId: request.params.id }, { objectId: request.params.id }]) {
      for (const e of await store.findEdges(q)) touching.set(e.id, true);
    }
    for (const id of touching.keys()) await store.deleteEdge(id);
    await store.deleteNode(request.params.id);
    return reply.send({ deleted: { nodes: 1, edges: touching.size } });
  });

  app.delete<{ Params: { id: string } }>("/kg/edges/:id", async (request, reply) => {
    const store = getKGStore();
    if (!(await store.getEdge(request.params.id))) {
      return reply.code(404).send({ error: "relationship not found" });
    }
    await store.deleteEdge(request.params.id);
    return reply.send({ deleted: { edges: 1 } });
  });

  app.get("/kg/communities", async (_request, reply) =>
    reply.send({ communities: await summarizeCommunities(getKGStore()) }),
  );

  app.get<{ Querystring: { q?: string; type?: string; limit?: string } }>(
    "/kg/search",
    async (request, reply) => {
      const q = request.query.q?.trim();
      const type = (request.query.type ?? "LOCAL_GRAPH").toUpperCase() as KGSearchType;
      if (!q) return reply.code(400).send({ error: "q is required" });
      if (!SEARCH_TYPES.includes(type))
        return reply.code(400).send({ error: `type is one of ${SEARCH_TYPES.join(", ")}` });
      const store = getKGStore();
      const needsCommunities = type === "COMMUNITY" || type === "GRAPH_COMPLETION";
      return reply.send(
        await graphSearch(store, q, type, {
          topK: Math.min(Math.max(Number(request.query.limit) || 20, 1), 100),
          communities: needsCommunities ? await summarizeCommunities(store) : [],
        }),
      );
    },
  );

  /**
   * The peer sends what it has; we fold it in and answer with the merged
   * graph. The merge is a CRDT join, so a duplicate or out-of-order exchange
   * is harmless and neither side has to track what it already sent.
   */
  app.post<{ Body: { nodes?: KGNode[]; edges?: KGEdge[] } }>(
    "/kg/sync",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            nodes: { type: "array", maxItems: 10_000 },
            edges: { type: "array", maxItems: 10_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const store = getKGStore();
      const incoming = {
        nodes: request.body?.nodes ?? [],
        edges: request.body?.edges ?? [],
      };
      const mine = {
        nodes: await store.findNodes({ includeDeleted: true }),
        edges: await store.findEdges({ includeDeleted: true }),
      };

      const merged = mergeSnapshots(mine, incoming);
      // Only rows the peer mentioned can have moved, so only those are written
      // back — a sync must not rewrite the whole graph to absorb one fact.
      const sentNodes = new Set(incoming.nodes.map((n) => n.id));
      const sentEdges = new Set(incoming.edges.map((e) => e.id));
      const changedNodes = merged.nodes.filter((n) => sentNodes.has(n.id));
      const changedEdges = merged.edges.filter((e) => sentEdges.has(e.id));
      for (const n of changedNodes) await store.upsertNode(n);
      for (const e of changedEdges) await store.upsertEdge(e);

      return reply.send({
        nodes: merged.nodes,
        edges: merged.edges,
        applied: { nodes: changedNodes.length, edges: changedEdges.length },
      });
    },
  );
}
