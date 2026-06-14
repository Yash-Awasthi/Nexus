// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge Graph routes — backed by @nexus/knowledge-graph InMemoryKGStore.
 *
 * GET  /api/v1/knowledge-graph/nodes            — list nodes (limit, type, minConfidence)
 * GET  /api/v1/knowledge-graph/search           — search nodes by name substring (?q= &k=)
 * GET  /api/v1/knowledge-graph/nodes/:id        — get single node
 * GET  /api/v1/knowledge-graph/nodes/:id/related — 1-hop neighbours
 * POST /api/v1/knowledge-graph/ingest           — ingest text + extract nodes/edges
 * POST /api/v1/knowledge-graph/nodes            — manually upsert a node
 * POST /api/v1/knowledge-graph/edges            — manually upsert an edge
 * DELETE /api/v1/knowledge-graph/nodes/:id      — delete node
 * DELETE /api/v1/knowledge-graph/edges/:id      — delete edge
 * GET  /api/v1/knowledge-graph/stats            — node/edge counts by type
 */

import {
  InMemoryKGStore,
  KnowledgeGraph,
  makeNodeId,
  makeEdgeId,
  nullEntityExtractor,
  nullRelationshipExtractor,
  type EntityType,
} from "@nexus/knowledge-graph";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Singletons ────────────────────────────────────────────────────────────────

const store = new InMemoryKGStore();
const kg = new KnowledgeGraph(store, nullEntityExtractor, nullRelationshipExtractor);

// Seed with a few example nodes so the UI is not empty on first load
(async () => {
  const now = Math.floor(Date.now() / 1000);
  const seed = [
    { name: "Nexus Platform", type: "PRODUCT" as EntityType, confidence: 1.0 },
    { name: "Yash Awasthi",   type: "PERSON"  as EntityType, confidence: 1.0 },
    { name: "NIT Raipur",     type: "ORG"     as EntityType, confidence: 1.0 },
    { name: "TypeScript",     type: "OTHER"   as EntityType, confidence: 0.9 },
    { name: "Multi-agent AI", type: "OTHER"   as EntityType, confidence: 0.9 },
  ];
  const ids: string[] = [];
  for (const s of seed) {
    const id = makeNodeId(s.name, s.type);
    ids.push(id);
    await store.upsertNode({ id, name: s.name, type: s.type, confidence: s.confidence, properties: {}, sources: ["seed"], createdAt: now, updatedAt: now });
  }
  // A few edges
  const edgePairs: [string, string, string][] = [
    [ids[1]!, "builds",    ids[0]!],
    [ids[1]!, "studies_at",ids[2]!],
    [ids[0]!, "uses",      ids[3]!],
    [ids[0]!, "implements",ids[4]!],
  ];
  for (const [s, pred, o] of edgePairs) {
    const id = makeEdgeId(s, pred, o);
    await store.upsertEdge({ id, subjectId: s, predicate: pred, objectId: o, confidence: 0.95, sources: ["seed"], createdAt: now, updatedAt: now });
  }
})();

// ── Shape helpers — translate KGNode/KGEdge to page-expected format ───────────

function nodeToView(n: { id: string; name: string; type: string; confidence: number; properties: Record<string, unknown>; sources: string[] }) {
  return { id: n.id, label: n.name, type: n.type.toLowerCase(), confidence: n.confidence, properties: n.properties, sources: n.sources };
}

function edgeToView(e: { id: string; subjectId: string; predicate: string; objectId: string; confidence: number }) {
  return { id: e.id, source: e.subjectId, target: e.objectId, relation: e.predicate, confidence: e.confidence };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function knowledgeGraphRoutes(app: FastifyInstance): Promise<void> {
  /** GET /knowledge-graph/nodes?type=&limit=&minConfidence= */
  app.get<{
    Querystring: { type?: string; limit?: string; minConfidence?: string };
  }>("/knowledge-graph/nodes", { preHandler: requireAuth }, async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? "50"), 200);
    const nodes = await kg.queryNodes({
      type: request.query.type as EntityType | undefined,
      minConfidence: request.query.minConfidence ? parseFloat(request.query.minConfidence) : undefined,
      limit,
    });
    const edges = await kg.queryEdges({ limit: 200 });
    const stats = await kg.stats();
    return reply.send({
      nodes: nodes.map(nodeToView),
      edges: edges.map(edgeToView),
      totalNodes: stats.nodes,
      totalEdges: stats.edges,
    });
  });

  /** GET /knowledge-graph/search?q=&k= */
  app.get<{
    Querystring: { q?: string; k?: string };
  }>("/knowledge-graph/search", { preHandler: requireAuth }, async (request, reply) => {
    const q = request.query.q ?? "";
    const k = Math.min(parseInt(request.query.k ?? "20"), 100);
    const nodes = q
      ? await kg.queryNodes({ nameContains: q, limit: k })
      : await kg.queryNodes({ limit: k });

    // For each found node, pull its edges so the UI can draw the subgraph
    const nodeIds = new Set(nodes.map((n) => n.id));
    const allEdges = await kg.queryEdges({ limit: 500 });
    const relevantEdges = allEdges.filter(
      (e) => nodeIds.has(e.subjectId) && nodeIds.has(e.objectId),
    );
    const stats = await kg.stats();

    return reply.send({
      nodes: nodes.map(nodeToView),
      edges: relevantEdges.map(edgeToView),
      totalNodes: stats.nodes,
      totalEdges: stats.edges,
    });
  });

  /** GET /knowledge-graph/nodes/:id */
  app.get<{ Params: { id: string } }>(
    "/knowledge-graph/nodes/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const node = await kg.getNode(request.params.id);
      if (!node) return reply.code(404).send({ error: "Node not found" });
      return reply.send(nodeToView(node));
    },
  );

  /** GET /knowledge-graph/nodes/:id/related?direction=&limit= */
  app.get<{
    Params: { id: string };
    Querystring: { direction?: "outbound" | "inbound" | "both"; limit?: string };
  }>("/knowledge-graph/nodes/:id/related", { preHandler: requireAuth }, async (request, reply) => {
    const result = await kg.findRelated(request.params.id, {
      direction: request.query.direction ?? "both",
      limit: request.query.limit ? parseInt(request.query.limit) : undefined,
    });
    if (!result.node) return reply.code(404).send({ error: "Node not found" });
    return reply.send({
      node: nodeToView(result.node),
      neighbors: result.neighbors.map((n) => ({
        node: nodeToView(n.node),
        edge: edgeToView(n.edge),
        direction: n.direction,
      })),
    });
  });

  /** POST /knowledge-graph/ingest — text → entities → edges */
  app.post<{
    Body: { text: string; source?: string };
  }>("/knowledge-graph/ingest", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.body.text?.trim()) {
      return reply.code(400).send({ error: "text is required" });
    }
    const result = await kg.ingest(request.body.text, { source: request.body.source });
    return reply.code(201).send(result);
  });

  /** POST /knowledge-graph/nodes — manual upsert */
  app.post<{
    Body: { name: string; type: EntityType; confidence?: number; properties?: Record<string, unknown>; sources?: string[] };
  }>("/knowledge-graph/nodes", { preHandler: requireAuth }, async (request, reply) => {
    const { name, type, confidence = 0.8, properties = {}, sources = [] } = request.body;
    if (!name?.trim() || !type) return reply.code(400).send({ error: "name and type are required" });
    const now = Math.floor(Date.now() / 1000);
    const id = makeNodeId(name, type);
    const node = await store.upsertNode({ id, name, type, confidence, properties, sources, createdAt: now, updatedAt: now });
    return reply.code(201).send(nodeToView(node));
  });

  /** POST /knowledge-graph/edges — manual upsert */
  app.post<{
    Body: { subjectId: string; predicate: string; objectId: string; confidence?: number; sources?: string[] };
  }>("/knowledge-graph/edges", { preHandler: requireAuth }, async (request, reply) => {
    const { subjectId, predicate, objectId, confidence = 0.8, sources = [] } = request.body;
    if (!subjectId || !predicate || !objectId) {
      return reply.code(400).send({ error: "subjectId, predicate and objectId are required" });
    }
    const now = Math.floor(Date.now() / 1000);
    const id = makeEdgeId(subjectId, predicate, objectId);
    const edge = await store.upsertEdge({ id, subjectId, predicate, objectId, confidence, sources, createdAt: now, updatedAt: now });
    return reply.code(201).send(edgeToView(edge));
  });

  /** DELETE /knowledge-graph/nodes/:id */
  app.delete<{ Params: { id: string } }>(
    "/knowledge-graph/nodes/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      await store.deleteNode(request.params.id);
      return reply.code(204).send();
    },
  );

  /** DELETE /knowledge-graph/edges/:id */
  app.delete<{ Params: { id: string } }>(
    "/knowledge-graph/edges/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      await store.deleteEdge(request.params.id);
      return reply.code(204).send();
    },
  );

  /** GET /knowledge-graph/stats */
  app.get("/knowledge-graph/stats", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send(await kg.stats());
  });
}
