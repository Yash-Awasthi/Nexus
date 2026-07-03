// SPDX-License-Identifier: Apache-2.0
/**
 * Agent routes — LibrarianAgent and FileExplorerAgent over HTTP.
 *
 * POST /agents/librarian/query    — recall memories + KG entities, assemble context text
 * POST /agents/file/read          — read a file via FileExplorerAgent
 * POST /agents/file/write         — write / overwrite a file
 * GET  /agents/file/list          — list directory entries (optional pattern + query filter)
 *
 * Adapters bridge @nexus/memory + @nexus/knowledge-graph into the lightweight
 * AgentMemory / AgentKG interfaces expected by @nexus/agents — no additional
 * packages required.
 *
 * FileExplorerAgent is wired to Node fs (fs/promises) via a thin AgentFileSystem
 * adapter; paths are resolved relative to AGENT_FS_ROOT (default: /workspace).
 */

import * as fsp from "fs/promises";
import * as path from "path";

import {
  LibrarianAgent,
  FileExplorerAgent,
  type AgentMemory,
  type AgentMemorySearchResult,
  type AgentKG,
  type AgentKGNode,
  type AgentKGEdge,
  type AgentFileSystem,
} from "@nexus/agents";
import { globalHooks } from "@nexus/hooks";
import { KnowledgeGraph, InMemoryKGStore } from "@nexus/knowledge-graph";
import { GroqEmbedder, InMemoryStore, MemoryManager, PgVectorStore } from "@nexus/memory";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Singletons ────────────────────────────────────────────────────────────────

// Memory store — shared with memory route
const _memStore = process.env.DATABASE_URL
  ? new PgVectorStore({ databaseUrl: process.env.DATABASE_URL })
  : new InMemoryStore();

const _embedder = process.env.GROQ_API_KEY
  ? new GroqEmbedder({ apiKey: process.env.GROQ_API_KEY })
  : null;

const _memManager = _embedder ? new MemoryManager({ store: _memStore, embedder: _embedder }) : null;

// KG store
const _kgStore = new InMemoryKGStore();
const _kg = new KnowledgeGraph(_kgStore);

// AgentMemory adapter — bridges MemoryManager into AgentMemory interface
const _agentMemory: AgentMemory = {
  async recall(query, limit = 5, filter) {
    if (!_memManager) return [];
    const userId = (filter as Record<string, unknown> | undefined)?.["userId"] as
      | string
      | undefined;
    const memFilter = userId ? { metadata: { userId } } : undefined;
    const results = await _memManager.recall(query, limit, memFilter);
    return results.map(
      (r): AgentMemorySearchResult => ({
        entry: {
          id: r.entry.id,
          text: r.entry.text,
          metadata: r.entry.metadata ?? {},
          createdAt:
            typeof r.entry.createdAt === "number"
              ? r.entry.createdAt
              : new Date(r.entry.createdAt as string).getTime() / 1000,
        },
        score: r.score,
      }),
    );
  },
  async remember(text, metadata) {
    if (!_memManager) return null;
    return _memManager.remember(text, { metadata });
  },
};

// AgentKG adapter
const _agentKG: AgentKG = {
  async queryNodes(q) {
    const nodes = await _kg.queryNodes({
      nameContains: q?.nameContains,
      type: q?.type as never,
      minConfidence: q?.minConfidence,
      limit: q?.limit,
    });
    return nodes.map(
      (n): AgentKGNode => ({
        id: n.id,
        name: n.name,
        type: n.type,
        confidence: n.confidence,
        sources: n.sources ?? [],
      }),
    );
  },
  async findRelated(nodeId, opts) {
    const result = await _kg.findRelated(nodeId, opts);
    const outbound = result.neighbors
      .filter((nb) => nb.direction === "outbound")
      .map(
        (nb): AgentKGEdge => ({
          id: nb.edge.id,
          subjectId: nb.edge.subjectId,
          predicate: nb.edge.predicate,
          objectId: nb.edge.objectId,
          confidence: nb.edge.confidence,
        }),
      );
    const inbound = result.neighbors
      .filter((nb) => nb.direction === "inbound")
      .map(
        (nb): AgentKGEdge => ({
          id: nb.edge.id,
          subjectId: nb.edge.subjectId,
          predicate: nb.edge.predicate,
          objectId: nb.edge.objectId,
          confidence: nb.edge.confidence,
        }),
      );
    const nodes = result.neighbors.map(
      (nb): AgentKGNode => ({
        id: nb.node.id,
        name: nb.node.name,
        type: nb.node.type,
        confidence: nb.node.confidence,
        sources: nb.node.sources ?? [],
      }),
    );
    return { outbound, inbound, nodes };
  },
};

// AgentHooks adapter — wraps globalHooks
const _agentHooks = {
  async emit(event: string, payload: Record<string, unknown>) {
    return globalHooks.emit(event as never, payload as never);
  },
};

// LibrarianAgent
const librarian = new LibrarianAgent({
  memory: _agentMemory,
  kg: _agentKG,
  hooks: _agentHooks,
});

// AgentFileSystem adapter
const FS_ROOT = process.env.AGENT_FS_ROOT ?? "/workspace";

const _agentFs: AgentFileSystem = {
  async readFile(p) {
    return fsp.readFile(path.resolve(FS_ROOT, p), "utf8");
  },
  async writeFile(p, content) {
    const abs = path.resolve(FS_ROOT, p);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    return fsp.writeFile(abs, content, "utf8");
  },
  async listDir(dir) {
    const abs = path.resolve(FS_ROOT, dir);
    const entries = await fsp.readdir(abs);
    return entries.map((e) => path.join(dir, e));
  },
  async exists(p) {
    return fsp
      .access(path.resolve(FS_ROOT, p))
      .then(() => true)
      .catch(() => false);
  },
};

// FileExplorerAgent
const fileExplorer = new FileExplorerAgent({
  fs: _agentFs,
  hooks: _agentHooks,
});

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function agentsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /agents/librarian/query
   *
   * Recall memories + KG entities and assemble a context block ready for
   * injection into an LLM prompt.
   *
   * Body:
   *   query             — natural language query (required)
   *   limit             — max memory results (default: 5)
   *   nodeLimit         — max KG entities (default: 10)
   *   minScore          — minimum cosine similarity threshold (default: 0)
   *   maxContextTokens  — max tokens in contextText (default: 2048)
   *   filter            — metadata filter forwarded to memory.recall
   */
  app.post<{
    Body: {
      query: string;
      limit?: number;
      nodeLimit?: number;
      minScore?: number;
      maxContextTokens?: number;
      filter?: Record<string, unknown>;
    };
  }>("/agents/librarian/query", { preHandler: requireAuth }, async (request, reply) => {
    const { query, ...opts } = request.body;
    if (!query) return reply.code(400).send({ error: "query is required" });

    const result = await librarian.recall(query, opts);
    return reply.send({
      query,
      memories: result.memories,
      entities: result.entities,
      contextText: result.contextText,
      kgError: result.kgError,
    });
  });

  /**
   * POST /agents/file/read
   *
   * Read a file via FileExplorerAgent.
   * Body: { path: string }
   *
   * Returns: { path, content, bytes }
   */
  app.post<{ Body: { path: string } }>(
    "/agents/file/read",
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
      const { path: filePath } = request.body;
      if (!filePath) return reply.code(400).send({ error: "path is required" });

      try {
        const content = await fileExplorer.readFile(filePath);
        return reply.send({ path: filePath, content, bytes: Buffer.byteLength(content) });
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  /**
   * POST /agents/file/write
   *
   * Write content to a file via FileExplorerAgent (fire hooks; creates dirs).
   * Body: { path: string, content: string }
   *
   * Returns EditResult: { ok, path, bytesWritten, aborted?, error? }
   */
  app.post<{
    Body: { path: string; content: string };
  }>("/agents/file/write", { preHandler: requireAuth }, async (request, reply) => {
    const { path: filePath, content } = request.body;
    if (!filePath) return reply.code(400).send({ error: "path is required" });
    if (content === undefined) return reply.code(400).send({ error: "content is required" });

    const result = await fileExplorer.editFile(filePath, content);
    return reply.code(result.ok ? 201 : 422).send(result);
  });

  /**
   * GET /agents/file/list?dir=&pattern=&query=
   *
   * List directory entries. Results optionally filtered by name pattern and
   * ranked by TF query score.
   *
   * Query params:
   *   dir     — directory path (default: ".")
   *   pattern — name substring filter (case-insensitive)
   *   query   — query terms for TF ranking
   */
  app.get<{
    Querystring: { dir?: string; pattern?: string; query?: string };
  }>("/agents/file/list", { preHandler: requireAuth }, async (request, reply) => {
    const { dir = ".", pattern, query } = request.query;

    try {
      const files = await fileExplorer.listFiles(dir, { pattern, query });
      return reply.send({ dir, files, total: files.length });
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
