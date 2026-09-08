// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge-graph surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * The whole /kg/* surface: graph, search (GET+POST), extract, traverse
 * (GET+POST) and communities (hierarchical label-propagation clustering).
 * Response shapes are byte-identical to the pre-extraction handlers. The
 * store/graph singletons are shared via lib/knowledge-graph-store.ts (also
 * used by the /symbolic/* surface that stays in api-bridge).
 *
 * Known inert wiring (kept byte-identical for the extraction): the default
 * KnowledgeGraph uses null extractors, so POST /kg/extract returns zero
 * entities/relationships unless real extractors (e.g. @nexus/nlp-utils) are
 * wired in — a separate enhancement slice.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import { clusterGraph, buildCommunities } from "@nexus/knowledge-graph";
import type { FastifyInstance } from "fastify";

import { getKG, getKGStore } from "../lib/knowledge-graph-store.js";

/** Register the /kg/* surface. Called from apiBridgeRoutes. */
export async function kgRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: number; q?: string } }>("/kg/graph", async (request, reply) => {
    const store = getKGStore();
    const { limit = 50, q } = request.query;
    const nodes = await store.findNodes(q ? { nameContains: q, limit } : { limit });
    const edges = await store.findEdges({ limit });
    return reply.send({ nodes, edges });
  });

  app.get<{ Querystring: { q?: string; k?: number } }>("/kg/search", async (request, reply) => {
    const store = getKGStore();
    const nodes = await store.findNodes({
      nameContains: request.query.q ?? "",
      limit: request.query.k ?? 10,
    });
    return reply.send({ nodes });
  });

  // POST variant used by knowledge-graph.tsx UI
  app.post<{ Body: { query?: string; q?: string; k?: number } }>(
    "/kg/search",
    async (request, reply) => {
      const store = getKGStore();
      const q = request.body.query ?? request.body.q ?? "";
      const k = request.body.k ?? 10;
      const nodes = await store.findNodes({ nameContains: q, limit: k });
      return reply.send({ nodes });
    },
  );

  app.post<{ Body: { text: string } }>("/kg/extract", async (request, reply) => {
    const kg = getKG();
    const result = await kg.ingest(request.body.text);
    return reply.code(201).send(result);
  });

  app.get<{ Querystring: { id?: string } }>("/kg/traverse", async (request, reply) => {
    const store = getKGStore();
    const subjectId = request.query.id ?? "";
    const edges = await store.findEdges({ subjectId, limit: 50 });
    const nodeIds = [...new Set(edges.flatMap((e) => [e.subjectId, e.objectId]))];
    const nodes = await Promise.all(nodeIds.map((id) => store.getNode(id)));
    return reply.send({ nodes: nodes.filter(Boolean), edges });
  });

  // POST variant used by knowledge-graph.tsx UI
  app.post<{ Body: { id?: string; entityId?: string; depth?: number } }>(
    "/kg/traverse",
    async (request, reply) => {
      const store = getKGStore();
      const subjectId = request.body.id ?? request.body.entityId ?? "";
      const edges = await store.findEdges({ subjectId, limit: 50 });
      const nodeIds = [...new Set(edges.flatMap((e) => [e.subjectId, e.objectId]))];
      const nodes = await Promise.all(nodeIds.map((id) => store.getNode(id)));
      return reply.send({ nodes: nodes.filter(Boolean), edges });
    },
  );

  // KG communities — hierarchical label-propagation clustering via @nexus/knowledge-graph
  app.get<{ Querystring: { maxLevels?: string; maxClusterSize?: string } }>(
    "/kg/communities",
    async (request, reply) => {
      try {
        const store = getKGStore();
        const maxLevels = Math.min(parseInt(request.query.maxLevels ?? "2", 10) || 2, 4);
        const maxClusterSize = Math.min(
          parseInt(request.query.maxClusterSize ?? "10", 10) || 10,
          50,
        );

        const clusters = await clusterGraph(store, { maxLevels, maxClusterSize });
        const communities = buildCommunities(clusters);

        return reply.send({
          communities,
          total: communities.length,
          levels: maxLevels,
          message:
            communities.length === 0
              ? "No entities in graph yet — ingest documents first."
              : `${communities.length} communities detected across ${maxLevels} level(s).`,
        });
      } catch (err) {
        return reply.code(500).send({
          error: "community_detection_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}