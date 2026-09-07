// SPDX-License-Identifier: Apache-2.0
/**
 * agent-mcp — bridge external MCP servers into the agent loop as RuntimeTools.
 *
 * Connects to an MCP server via @nexus/mcp-client, lists its tools, and wraps each
 * as a RuntimeTool whose handler calls `callTool`. The MCP tool's `inputSchema`
 * becomes the RuntimeTool's `parameters` (advertised to native tool-calling), so
 * the model can invoke MCP tools exactly like built-in ones. Tool names are
 * namespaced `<server>__<tool>` to avoid collisions across servers.
 *
 * This mirrors jcode's "convert MCP tools → the harness Tool type" pattern.
 * The per-user encrypted MCP registry (apps/api `/mcp/servers`) is the eventual
 * source of these configs; for now they arrive on the job payload.
 */
import type { RuntimeTool } from "@nexus/agent-runtime";
import { runMultiAgentDebate, majorityFinalAnswer } from "@nexus/debate-engine";
import { createHybridSearchMcpServer } from "@nexus/hybrid-search";
import type { BM25SearchAdapter, VectorSearchAdapter } from "@nexus/hybrid-search";
import { createGraphRagMcpServer } from "@nexus/graphrag-query";
import type { CommunityReport, IndexedEntity, IndexedRelation, QueryRouter } from "@nexus/graphrag-query";
import type { Reranker } from "@nexus/reranker";
import {
  createCouncilMcpServer,
  recordToolTranscript,
  type CouncilMcpServerOptions,
  type ILLMMessage,
  type ILLMTransport,
  type TranscriptSink,
  type ToolTranscriptHooks,
} from "@nexus/council";
export type { TranscriptSink, ToolTranscriptHooks } from "@nexus/council";
import {
  McpClient,
  McpHttpServer,
  type McpCallResult,
  type McpToolDefinition,
} from "@nexus/mcp-client";

export interface McpServerConfig {
  /** Short label; also the tool-name prefix. */
  name: string;
  serverUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Provider tool names must match ^[a-zA-Z0-9_-]{1,64}$ (Anthropic + OpenAI). */
function toToolName(server: string, tool: string): string {
  const name = `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return name.length > 64 ? name.slice(0, 64) : name;
}

/** Coerce an MCP inputSchema into a usable JSON-Schema object for tool-calling. */
function toParameters(schema: unknown): Record<string, unknown> {
  return schema && typeof schema === "object"
    ? (schema as Record<string, unknown>)
    : { type: "object", properties: {} };
}

function wrapMcpTool(client: McpClient, server: string, def: McpToolDefinition): RuntimeTool {
  return {
    name: toToolName(server, def.name),
    description: def.description ?? `MCP tool '${def.name}' from server '${server}'`,
    parameters: toParameters(def.inputSchema),
    handler: async (args) => {
      const result = await client.callTool(def.name, args);
      if (result.isError) throw new Error(result.text || "MCP tool returned an error");
      return result.text || JSON.stringify(result.content);
    },
  };
}

/** Connect to one MCP server and wrap its tools. */
export async function mcpToolsFromServer(cfg: McpServerConfig): Promise<RuntimeTool[]> {
  const client = new McpClient({
    serverUrl: cfg.serverUrl,
    apiKey: cfg.apiKey,
    extraHeaders: cfg.headers,
    timeoutMs: cfg.timeoutMs ?? 20_000,
  });
  await client.initialize();
  const defs = await client.listTools();
  return defs.map((def) => wrapMcpTool(client, cfg.name, def));
}

/** Connect to multiple MCP servers; a failed server is logged and skipped. */
export async function mcpToolsFromServers(servers: McpServerConfig[]): Promise<RuntimeTool[]> {
  const settled = await Promise.allSettled(servers.map((s) => mcpToolsFromServer(s)));
  const tools: RuntimeTool[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") tools.push(...r.value);
    else
      console.error(
        JSON.stringify({
          level: "error",
          event: "mcp.connect_failed",
          server: servers[i]?.name,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        }),
      );
  });
  return tools;
}

// ── Local (in-process) MCP servers → RuntimeTools ────────────────────────────
//
// The external-server path above goes through McpClient over HTTP. Some MCP
// servers are local surfaces that exist to be SERVED (pass 35's
// createCouncilMcpServer); an agent runtime can consume them in-process through
// the same JSON-RPC `handle()` seam the HTTP host uses, with no network hop.

interface RpcEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

async function localRpc(
  server: McpHttpServer,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcEnvelope> {
  const res = await server.handle({
    method: "POST",
    path: "/mcp",
    body: { jsonrpc: "2.0", id: 1, method, params },
  });
  const body = res.body as RpcEnvelope | null;
  if (res.status !== 200 || body?.error) {
    throw new Error(body?.error?.message ?? `MCP ${method} failed (HTTP ${res.status})`);
  }
  if (!body?.result) throw new Error(`MCP ${method} returned no result`);
  return body;
}

// ── Tool-call transcripts (pass 58 recorder) ───────────────────────────────────
//
// Every council/debate tool invocation through the agent loop leaves the
// inspectable run artifact: route evidence, one stage per vote/round where the
// protocol output carries it, and finalizeTranscript's OR-of-five degradation
// verdict + metrics. Failures still produce a degraded transcript before the
// error rethrows, so failed tool calls stay observable too.
//
// The recorder itself (recordToolTranscript + the TranscriptSink /
// ToolTranscriptHooks contracts) lives in @nexus/council run-transcript.ts
// (pass 66) so every surface shares one artifact contract.

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Parse a tool result (local text or content-entry serialization) into a record. */
function parseToolResult(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function wrapLocalMcpTool(
  server: McpHttpServer,
  prefix: string,
  def: McpToolDefinition,
  hooks?: ToolTranscriptHooks,
): RuntimeTool {
  return {
    name: toToolName(prefix, def.name),
    description: def.description ?? `MCP tool '${def.name}' from local server '${prefix}'`,
    parameters: toParameters(def.inputSchema),
    handler: async (args) => {
      const startedAt = Date.now();
      const question = asRecord(args).question !== undefined ? str(asRecord(args).question) : "";
      try {
        const body = await localRpc(server, "tools/call", {
          name: def.name,
          arguments: (args ?? {}) as Record<string, unknown>,
        });
        const result = body.result as McpCallResult;
        if (result.isError) throw new Error(result.text || "MCP tool returned an error");
        const raw = result.text
          ? result.text
          : (result.content ?? [])
              .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text)
              .join("\n");
        const textOut = raw || JSON.stringify(result.content);
        hooks?.onTranscript?.(
          recordToolTranscript(def.name, question, parseToolResult(textOut), startedAt),
        );
        return textOut;
      } catch (err) {
        hooks?.onTranscript?.(recordToolTranscript(def.name, question, undefined, startedAt, errMsg(err)));
        throw err;
      }
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Expose a local MCP server's tools as RuntimeTools (in-process, no network). */
export async function localMcpToolsFromServer(
  server: McpHttpServer,
  prefix: string,
  hooks?: ToolTranscriptHooks,
): Promise<RuntimeTool[]> {
  const body = await localRpc(server, "tools/list", {});
  const defs = (body.result as { tools: McpToolDefinition[] }).tools ?? [];
  return defs.map((def) => wrapLocalMcpTool(server, prefix, def, hooks));
}

/**
 * Serve the full council protocol set (batch-35 served surface — deliberate /
 * vote / debate / critique / verify) as RuntimeTools an agent can invoke, all
 * driven by one injected ILLMTransport.
 */
export function councilRuntimeTools(
  options: CouncilMcpServerOptions,
  prefix = "council",
  hooks?: ToolTranscriptHooks,
): Promise<RuntimeTool[]> {
  const server = createCouncilMcpServer(options);
  return localMcpToolsFromServer(server, prefix, hooks);
}

/** Convenience: council tools over an existing transport (worker LlmDrivers-style). */
export function councilRuntimeToolsFromTransport(
  llm: ILLMTransport,
  opts?: {
    tools?: CouncilMcpServerOptions["tools"];
    prefix?: string;
    model?: string;
    hooks?: ToolTranscriptHooks;
  },
): Promise<RuntimeTool[]> {
  return councilRuntimeTools(
    { llm, ...(opts?.tools ? { tools: opts.tools } : {}), ...(opts?.model ? { model: opts.model } : {}) },
    opts?.prefix,
    opts?.hooks,
  );
}

// ── Served hybrid single-query (hybrid-search pass-69 served surface) ─────────

/**
 * Serve the hybrid single-query tool (dense+BM25 legs, RRF/alpha fusion,
 * metadata/document filters, optional rerank — the pass-69 served surface in
 * @nexus/hybrid-search) as one RuntimeTool an agent can invoke like any
 * built-in tool. Adaptors are injected by the caller (whoever owns the
 * corpus), mirroring how external MCP servers arrive config-driven.
 */
export async function hybridSearchRuntimeTools(opts: {
  /** Dense leg adapter over the caller's vector index. */
  vector: VectorSearchAdapter;
  /** Sparse leg adapter over the caller's BM25 index (e.g. InMemoryBM25). */
  bm25: BM25SearchAdapter;
  /** Optional post-fusion reranker (applied unless the call opts out). */
  reranker?: Reranker;
  /** Namespacing prefix. Default "hybrid" → "hybrid__hybrid_search". */
  prefix?: string;
  /** Optional transcript sink — leaves the pass-58 artifact per invocation. */
  hooks?: ToolTranscriptHooks;
}): Promise<RuntimeTool[]> {
  const server = createHybridSearchMcpServer({
    vector: opts.vector,
    bm25: opts.bm25,
    ...(opts.reranker ? { reranker: opts.reranker } : {}),
  });
  return localMcpToolsFromServer(server, opts.prefix ?? "hybrid", opts.hooks);
}

// ── Served graphrag local/global search (graphrag-query pass-71 served surface) ─

/**
 * Serve the graphrag search tools (local entity-anchored + global map-reduce
 * over community reports — the pass-71 served surface in @nexus/graphrag-query)
 * as RuntimeTools an agent can invoke. The caller injects its indexed graph
 * and its loop transport (same ILLMTransport seam the council tools use); the
 * transport is adapted to graphrag's plain QueryRouter shape.
 */
export async function graphRagRuntimeTools(opts: {
  /** Indexed entity graph the local-search engine anchors on. */
  entities: IndexedEntity[];
  /** Indexed relations between those entities. */
  relations: IndexedRelation[];
  /** Community reports (level 0+) for the global search engine. */
  reports?: CommunityReport[];
  /** The loop's LLM transport — adapted to graphrag's QueryRouter. */
  llm: ILLMTransport;
  /** Model alias reported on completions. Default "graphrag". */
  model?: string;
  /** Namespacing prefix. Default "graphrag". */
  prefix?: string;
  /** Optional transcript sink — leaves the pass-58 artifact per invocation. */
  hooks?: ToolTranscriptHooks;
}): Promise<RuntimeTool[]> {
  const router: QueryRouter = {
    async complete(params) {
      const res = await opts.llm.chat(params.messages as ILLMMessage[], {
        model: params.model,
        ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      });
      return { content: res.content };
    },
  };
  const server = createGraphRagMcpServer({
    entities: opts.entities,
    relations: opts.relations,
    ...(opts.reports ? { reports: opts.reports } : {}),
    router,
    ...(opts.model ? { model: opts.model } : {}),
  });
  return localMcpToolsFromServer(server, opts.prefix ?? "graphrag", opts.hooks);
}

// ── Converging debate tool (debate-engine pass-34 convergence) ────────────────

/** Transport shape consumed by runMultiAgentDebate (agent + round + messages). */
export type DebateAgentTransport = (req: {
  agent: string;
  round: number;
  messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
}) => Promise<string>;

export interface DebateToolOptions {
  /** Turn completion function (normally the agent loop's driver). */
  transport: DebateAgentTransport;
  /** Default panel when the caller omits `agents`. Default: two, A and B. */
  agents?: string[];
  /** Namespacing prefix. Default "debate" → "debate__run". */
  prefix?: string;
  /** Optional transcript sink — leaves the pass-58 artifact per invocation. */
  hooks?: ToolTranscriptHooks;
}

/**
 * Wrap debate-engine's runMultiAgentDebate (pass-34 convergence: positions
 * stable for `patience` rounds after `minRounds`) as one in-process
 * RuntimeTool an agent can invoke like any built-in tool.
 */
export function debateRuntimeTool(opts: DebateToolOptions): RuntimeTool {
  const defaultAgents = opts.agents ?? ["Debater A", "Debater B"];
  return {
    name: toToolName(opts.prefix ?? "debate", "run"),
    description:
      "Run a structured multi-round debate where agents refine their positions from peer answers. " +
      "With convergence enabled, the round budget becomes a cap and the debate stops early once " +
      "every position stops changing (stability-with-patience detector). Returns whether it " +
      "converged, how many rounds ran, and the majority final answer.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to debate." },
        context: { type: "string", description: "Optional background context." },
        agents: { type: "array", description: "Debater names (default: two generic debaters)." },
        rounds: { type: "number", description: "Round budget (default 3; a cap when convergence is on)." },
        convergence: { type: "boolean", description: "Stop early once positions stabilise (default false)." },
      },
      required: ["question"],
    },
    handler: async (args) => {
      const startedAt = Date.now();
      const question = typeof args.question === "string" ? args.question : "";
      const agents = Array.isArray(args.agents)
        ? args.agents.filter((a): a is string => typeof a === "string")
        : defaultAgents;
      try {
        const result = await runMultiAgentDebate({
          question,
          agents: agents.length > 0 ? agents : defaultAgents,
          rounds: typeof args.rounds === "number" ? args.rounds : 3,
          ...(args.convergence === true ? { convergence: true } : {}),
          systemPrompt:
            typeof args.context === "string" && args.context
              ? `Context: ${args.context}`
              : undefined,
          transport: opts.transport,
        });
        const out = JSON.stringify({
          converged: result.converged,
          roundsRun: result.roundsRun,
          majority: majorityFinalAnswer(result),
          finalAnswers: result.finalAnswers,
        });
        opts.hooks?.onTranscript?.(recordToolTranscript("debate__run", question, parseToolResult(out), startedAt));
        return out;
      } catch (err) {
        opts.hooks?.onTranscript?.(recordToolTranscript("debate__run", question, undefined, startedAt, errMsg(err)));
        throw err;
      }
    },
  };
}
