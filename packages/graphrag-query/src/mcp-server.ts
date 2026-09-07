// SPDX-License-Identifier: Apache-2.0
/**
 * Served graphrag — graphrag query as MCP tools (pass 71).
 *
 * The graphrag-query family (GraphRAGQueryEngine's global map-reduce over
 * community reports, LocalSearchEngine's entity-anchored local search) is pure
 * package machinery with no app surface that can reach it. This module is the
 * thin served surface that turns two MCP calls — `graphrag_local_search` and
 * `graphrag_global_search` — into those engines, behind the {@link McpHttpServer}
 * without duplicating any engine logic.
 *
 * Mirrors the council / hybrid-search served surfaces (createCouncilMcpServer,
 * createHybridSearchMcpServer): the caller injects its indexed graph (entities
 * + relations, plus optional community reports for global search) and a
 * {@link QueryRouter} — the exact router shape graphrag-query's engines take,
 * which the worker/CLI agent loops adapt from their `ILLMTransport` seam. Any
 * host — an agent runtime via localMcpToolsFromServer, an MCP client over
 * HTTP, or a curl — runs graphrag local/global search through plain MCP
 * JSON-RPC. Index + router injection keeps the whole server deterministic to
 * test and pipeline-agnostic.
 *
 * Tools
 * ─────
 *   graphrag_local_search {question, maxEntities?, levels?, maxContextTokens?,
 *                          topKRelationships?, includeReports?} — entity-anchored
 *                          single-pass search (pass 54): anchors on query-matched
 *                          entities, expands neighbors, assembles one budgeted
 *                          context window, answers in one completion.
 *   graphrag_global_search {question, communityLevel?, maxCommunities?,
 *                           dynamicSelection?} — map-reduce over hierarchical
 *                           community reports (GraphRAG's global variant).
 */
import { McpHttpServer, type McpCallResult, type McpToolDefinition } from "@nexus/mcp-client";

import type { IndexedEntity, IndexedRelation } from "./index-graphrag.js";
import {
  GraphRAGQueryEngine,
  LocalSearchEngine,
  type CommunityReport,
  type QueryRouter,
} from "./index.js";

export interface GraphRagMcpServerOptions {
  /** Indexed entity graph the local-search engine anchors on. */
  entities: IndexedEntity[];
  /** Indexed relations between those entities. */
  relations: IndexedRelation[];
  /** Community reports (level 0+) for the global search engine. */
  reports?: CommunityReport[];
  /** The single LLM router driving every completion (local + global). */
  router: QueryRouter;
  /** Model alias reported on router completions. Default "graphrag". */
  model?: string;
  /** Server identity reported by `initialize`. */
  name?: string;
  version?: string;
}

const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
const num = (v: unknown, dflt: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.max(min, Math.min(max, v))
    : typeof v === "string" && v.trim() !== ""
      ? Math.max(min, Math.min(max, Number(v) || dflt))
      : dflt;
const bool = (v: unknown, dflt = false): boolean => (typeof v === "boolean" ? v : dflt);

const text = (value: unknown): McpCallResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  text: JSON.stringify(value),
});

const err = (message: string): McpCallResult => ({
  content: [],
  isError: true,
  text: message,
});

const inputSchema = (properties: Record<string, unknown>, extraRequired: string[] = []) => ({
  type: "object" as const,
  properties,
  required: ["question", ...extraRequired],
});

/**
 * Build an MCP server exposing graphrag local + global search over one
 * injected index and router.
 */
export function createGraphRagMcpServer(options: GraphRagMcpServerOptions): McpHttpServer {
  const model = options.model ?? "graphrag";
  const local = new LocalSearchEngine(
    options.entities,
    options.relations,
    options.router,
    model,
    options.reports ?? [],
  );
  const global = new GraphRAGQueryEngine(options.router, model);
  if (options.reports) global.addReports(options.reports);

  const definitions: McpToolDefinition[] = [
    {
      name: "graphrag_local_search",
      description:
        "Entity-anchored local search (GraphRAG dual-mode): anchor on query-matched entities, expand through the graph to neighbors, assemble one token-budgeted context window from entity/relationship tables (plus linked community reports), and answer in a single LLM pass. No map-reduce.",
      inputSchema: inputSchema({
        question: { type: "string", description: "The question to answer from the graph." },
        maxEntities: { type: "number", description: "Max selected entities before expansion (default 10)." },
        levels: { type: "number", description: "Neighbor levels to expand (default 1)." },
        maxContextTokens: { type: "number", description: "Token budget for the assembled context (default 8000)." },
        topKRelationships: { type: "number", description: "Per-entity relationship budget (default 10)." },
        includeReports: { type: "boolean", description: "Attach linked community reports (default true)." },
      }),
    },
    {
      name: "graphrag_global_search",
      description:
        "Global map-reduce search over hierarchical community reports: select relevant communities, summarize each in parallel, and synthesize the summaries into one answer.",
      inputSchema: inputSchema({
        question: { type: "string", description: "The question to answer from community reports." },
        communityLevel: { type: "number", description: "Report hierarchy level to search (default 0)." },
        maxCommunities: { type: "number", description: "Community budget (default 5)." },
        dynamicSelection: { type: "boolean", description: "LLM-narrow the selected set before the map phase (default false)." },
      }),
    },
  ];

  return new McpHttpServer({
    name: options.name ?? "graphrag",
    version: options.version ?? "1.0.0",
    tools: definitions,
    execute: async (name, args): Promise<McpCallResult> => {
      const question = str(args.question).trim();
      if (!question) return err("question is required");
      switch (name) {
        case "graphrag_local_search": {
          const result = await local.search(question, {
            ...(args.maxEntities !== undefined
              ? { maxEntities: num(args.maxEntities, 10, 1, 500) }
              : {}),
            ...(args.levels !== undefined ? { levels: num(args.levels, 1, 0, 10) } : {}),
            ...(args.maxContextTokens !== undefined
              ? { maxContextTokens: num(args.maxContextTokens, 8000, 100, 100_000) }
              : {}),
            ...(args.topKRelationships !== undefined
              ? { topKRelationships: num(args.topKRelationships, 10, 1, 1000) }
              : {}),
            ...(args.includeReports !== undefined
              ? { includeReports: bool(args.includeReports, true) }
              : {}),
          });
          return text({
            answer: result.answer,
            entitiesUsed: result.entitiesUsed,
            relationshipsUsed: result.relationshipsUsed,
            reportsUsed: result.reportsUsed,
            context: result.context,
            durationMs: result.durationMs,
          });
        }
        case "graphrag_global_search": {
          const result = await global.query(question, {
            ...(args.communityLevel !== undefined
              ? { communityLevel: num(args.communityLevel, 0, 0, 100) }
              : {}),
            ...(args.maxCommunities !== undefined
              ? { maxCommunities: num(args.maxCommunities, 5, 1, 100) }
              : {}),
            ...(args.dynamicSelection !== undefined
              ? { dynamicSelection: bool(args.dynamicSelection) }
              : {}),
          });
          return text({
            answer: result.answer,
            communitiesUsed: result.communitiesUsed.map((c) => ({
              id: c.id,
              title: c.title,
              level: c.level,
            })),
            context: result.context,
            durationMs: result.durationMs,
          });
        }
        default:
          return err(`Unknown tool: ${name}`);
      }
    },
  });
}
