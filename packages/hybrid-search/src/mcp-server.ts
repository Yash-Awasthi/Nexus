// SPDX-License-Identifier: Apache-2.0
/**
 * Served hybrid search — hybrid single-query as an MCP tool (pass 69).
 *
 * The hybrid-search family (RRF + alpha fusion, pass-50 where vocabulary,
 * pass-51 rerank seam, HybridSearchEngine) is pure package machinery with no
 * app surface that can reach it: every agent loop and route that wants
 * retrieval must compose the legs itself. This module is the thin served
 * surface that turns ONE `hybrid_search` call into the full pipeline —
 * parallel dense-vector + BM25 sparse legs, metadata/document filters applied
 * pre-fusion, RRF or alpha fusion, and an optional post-fusion rerank —
 * behind the {@link McpHttpServer} without duplicating any engine logic.
 *
 * Mirrors the council served surface (createCouncilMcpServer): the caller
 * injects its adapters (vector + BM25 + optional reranker), and any host — an
 * agent runtime via localMcpToolsFromServer, an MCP client over HTTP, or a
 * curl — searches through plain MCP JSON-RPC. Adapter injection keeps the
 * whole server deterministic to test and store-agnostic.
 *
 * Tools
 * ─────
 *   hybrid_search {query, limit?, fusion?, vectorWeight?, where?,
 *                  whereDocument?, rerank?} — one hybrid single query:
 *                  fused hits (id/score/text/metadata) plus each leg's
 *                  candidate list and the run's duration.
 */
import { McpHttpServer, type McpCallResult, type McpToolDefinition } from "@nexus/mcp-client";
import type { Reranker } from "@nexus/reranker";
import type { WhereClause, WhereDocumentClause } from "@nexus/retrieval";

import {
  HybridSearchEngine,
  type BM25SearchAdapter,
  type VectorSearchAdapter,
} from "./index.js";

export interface HybridSearchMcpServerOptions {
  /** Dense leg: any @nexus/hybrid-search VectorSearchAdapter implementation. */
  vector: VectorSearchAdapter;
  /** Sparse leg: any BM25SearchAdapter (e.g. the package's InMemoryBM25). */
  bm25: BM25SearchAdapter;
  /**
   * Optional post-fusion reranker. When set, `hybrid_search` reranks by
   * default; callers can opt out per call with `rerank: false`.
   */
  reranker?: Reranker;
  /** Server identity reported by `initialize`. */
  name?: string;
  version?: string;
  /** Cap on the result `limit` a caller may request. Default 50. */
  maxLimit?: number;
}

const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
const num = (v: unknown, dflt: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.max(min, Math.min(max, v))
    : typeof v === "string" && v.trim() !== ""
      ? Math.max(min, Math.min(max, Number(v) || dflt))
      : dflt;
const bool = (v: unknown, dflt = false): boolean => (typeof v === "boolean" ? v : dflt);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const text = (value: unknown): McpCallResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  text: JSON.stringify(value),
});

const err = (message: string): McpCallResult => ({
  content: [],
  isError: true,
  text: message,
});

/**
 * Build an MCP server exposing hybrid single-query. Each `hybrid_search` call
 * runs the injected dense + BM25 legs in parallel, applies the optional
 * metadata/document filters pre-fusion, fuses (RRF or alpha-weighted), and
 * reranks post-fusion when a reranker is configured and not opted out.
 */
export function createHybridSearchMcpServer(
  options: HybridSearchMcpServerOptions,
): McpHttpServer {
  const maxLimit = options.maxLimit ?? 50;
  const engine = new HybridSearchEngine(options.vector, options.bm25);

  const tool: McpToolDefinition = {
    name: "hybrid_search",
    description:
      "Hybrid retrieval single query: run dense-vector and BM25 legs in parallel, filter " +
      "candidates by metadata / document text, fuse by RRF or alpha-weighted scores, and " +
      "optionally rerank. Returns the top hits (id/score/text/metadata) plus each leg's " +
      "candidate list.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: { type: "number", description: "Result count (default 10)." },
        fusion: {
          type: "string",
          enum: ["rrf", "alpha"],
          description: '"rrf" (default) or "alpha" (alpha-weighted normalized scores).',
        },
        vectorWeight: {
          type: "number",
          description: "Dense-side weight: RRF weightA / alpha blend (default 0.5).",
        },
        where: {
          type: "object",
          description:
            'Metadata filter (the pass-50 where vocabulary: exact values or {$eq,$ne,$gt,$gte,$lt,$lte,$in,$nin,$and,$or,$not,$contains,$not_contains}). E.g. {"tier":"gold"} or {"price":{"$gt":5}}.',
        },
        whereDocument: {
          type: "object",
          description:
            'Document-text filter: {"contains":"x"} or {"not_contains":"y"}.',
        },
        rerank: {
          type: "boolean",
          description: "Apply the server's reranker post-fusion (default true when one is configured).",
        },
      },
      required: ["query"],
    },
  };

  return new McpHttpServer({
    name: options.name ?? "hybrid-search",
    version: options.version ?? "1.0.0",
    tools: [tool],
    execute: async (name, args): Promise<McpCallResult> => {
      if (name !== tool.name) return err(`Unknown tool: ${name}`);
      const query = str(args.query).trim();
      if (!query) return err("query is required");
      const reranker =
        options.reranker && bool(args.rerank, true) ? options.reranker : undefined;
      const result = await engine.search({
        query,
        limit: num(args.limit, 10, 1, maxLimit),
        fusion: args.fusion === "alpha" ? "alpha" : "rrf",
        ...(args.vectorWeight !== undefined
          ? { vectorWeight: num(args.vectorWeight, 0.5, 0, 1) }
          : {}),
        ...(isObject(args.where) ? { where: args.where as WhereClause } : {}),
        ...(isObject(args.whereDocument)
          ? { whereDocument: args.whereDocument as WhereDocumentClause }
          : {}),
        ...(reranker ? { reranker } : {}),
      });
      return text({
        hits: result.hits,
        vectorHits: result.vectorHits,
        bm25Hits: result.bm25Hits,
        durationMs: result.durationMs,
      });
    },
  });
}
