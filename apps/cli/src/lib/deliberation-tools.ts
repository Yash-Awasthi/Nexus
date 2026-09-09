// SPDX-License-Identifier: Apache-2.0
/**
 * deliberation-tools — the served deliberation surface for `nexus code --local`.
 *
 * Mirrors the worker's agent-mcp.ts builders (passes 60-62) with the same
 * conventions, adapted to the CLI's seam: the local agent drives an injected
 * {@link LlmToolFn} (no `@nexus/llm-drivers` driver object), so every served
 * protocol — council deliberate/vote/debate/critique/verify behind
 * `createCouncilMcpServer` plus debate-engine's converging `runMultiAgentDebate`
 * — is bridged over that function. An `onTranscript` hook (the pass-58/59
 * recorder) is threaded through so every invocation leaves the inspectable
 * artifact, exactly like the worker's `tool.transcript` events.
 *
 * The builders take an injected `ILLMTransport`/transport (deterministic to
 * test); `transportFromLlm` adapts a real `LlmToolFn` to both shapes.
 */
import type { RuntimeTool, LlmToolFn, RuntimeMessage } from "@nexus/agent-runtime";
import {
  createCouncilMcpServer,
  recordToolTranscript,
  type CouncilMcpServerOptions,
  type ILLMMessage,
  type ILLMTransport,
  type ToolTranscriptHooks,
} from "@nexus/council";
import { majorityFinalAnswer, runMultiAgentDebate } from "@nexus/debate-engine";
import { createGraphRagMcpServer } from "@nexus/graphrag-query";
import type {
  CommunityReport,
  IndexedEntity,
  IndexedRelation,
  QueryRouter,
} from "@nexus/graphrag-query";
import type { BM25SearchAdapter, VectorSearchAdapter } from "@nexus/hybrid-search";
import { createHybridSearchMcpServer } from "@nexus/hybrid-search";
import type { McpHttpServer, McpCallResult, McpToolDefinition } from "@nexus/mcp-client";
import type { Reranker } from "@nexus/reranker";
export type { TranscriptSink, ToolTranscriptHooks } from "@nexus/council";

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

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
              .filter(
                (c): c is { type: "text"; text: string } =>
                  c.type === "text" && typeof c.text === "string",
              )
              .map((c) => c.text)
              .join("\n");
        const textOut = raw || JSON.stringify(result.content);
        hooks?.onTranscript?.(
          recordToolTranscript(def.name, question, parseToolResult(textOut), startedAt),
        );
        return textOut;
      } catch (err) {
        hooks?.onTranscript?.(
          recordToolTranscript(def.name, question, undefined, startedAt, errMsg(err)),
        );
        throw err;
      }
    },
  };
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

/** Serve the full council protocol set as RuntimeTools over one injected transport. */
export function councilRuntimeTools(
  options: CouncilMcpServerOptions,
  prefix = "council",
  hooks?: ToolTranscriptHooks,
): Promise<RuntimeTool[]> {
  const server = createCouncilMcpServer(options);
  return localMcpToolsFromServer(server, prefix, hooks);
}

/**
 * Adapt the CLI's `LlmToolFn` (tool-aware turns) to council's plain
 * `ILLMTransport` (system/user/assistant completions, no tool schema). The
 * function is called with no tools, so providers return plain text.
 */
export function transportFromLlm(llm: LlmToolFn, model = ""): ILLMTransport {
  return {
    async chat(messages: ILLMMessage[], options) {
      const res = await llm(
        messages.map((m) => ({ role: m.role, content: m.content })) as RuntimeMessage[],
        {},
      );
      return {
        content: res.content,
        model: options?.model ?? model,
        usage: {
          promptTokens: res.usage?.inputTokens ?? 0,
          completionTokens: res.usage?.outputTokens ?? 0,
        },
        latencyMs: 0,
      };
    },
  };
}

/** Convenience: council tools over the CLI's `LlmToolFn`. */
export function councilRuntimeToolsFromLlm(
  llm: LlmToolFn,
  opts?: {
    tools?: CouncilMcpServerOptions["tools"];
    prefix?: string;
    model?: string;
    hooks?: ToolTranscriptHooks;
  },
): Promise<RuntimeTool[]> {
  return councilRuntimeTools(
    {
      llm: transportFromLlm(llm, opts?.model),
      ...(opts?.tools ? { tools: opts.tools } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
    },
    opts?.prefix,
    opts?.hooks,
  );
}

// ── Served hybrid single-query (hybrid-search pass-69/70 served surface) ─────

/**
 * Serve the hybrid single-query tool (dense+BM25 legs, RRF/alpha fusion,
 * metadata/document filters, optional rerank — the pass-69 served surface in
 * @nexus/hybrid-search) as one RuntimeTool a CLI local agent can invoke.
 * Mirrors the worker's agent-mcp.ts builder (pass 69); no LLM seam needed —
 * the caller supplies its corpus adapters, exactly like the deliberation
 * builders inject their transport.
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

// ── Served graphrag search (graphrag-query pass-71 served surface) ────────────

/**
 * Serve the graphrag search tools (local entity-anchored + global map-reduce
 * over community reports) as RuntimeTools a CLI local agent can invoke.
 * Mirrors the worker's agent-mcp.ts builder (pass 71): the caller injects its
 * indexed graph and an LLM transport, adapted to graphrag's QueryRouter.
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
  /** Turn completion function (normally the agent loop's llm). */
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
        rounds: {
          type: "number",
          description: "Round budget (default 3; a cap when convergence is on).",
        },
        convergence: {
          type: "boolean",
          description: "Stop early once positions stabilise (default false).",
        },
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
        opts.hooks?.onTranscript?.(
          recordToolTranscript("debate__run", question, parseToolResult(out), startedAt),
        );
        return out;
      } catch (err) {
        opts.hooks?.onTranscript?.(
          recordToolTranscript("debate__run", question, undefined, startedAt, errMsg(err)),
        );
        throw err;
      }
    },
  };
}

/** Convenience: debate tool over the CLI's `LlmToolFn` (plain completion turns). */
export function debateRuntimeToolFromLlm(
  llm: LlmToolFn,
  opts?: { agents?: string[]; prefix?: string; hooks?: ToolTranscriptHooks },
): RuntimeTool {
  return debateRuntimeTool({
    agents: opts?.agents,
    prefix: opts?.prefix,
    hooks: opts?.hooks,
    transport: async (req) => {
      const res = await llm(
        req.messages.map((m) => ({ role: m.role, content: m.content })) as RuntimeMessage[],
        {},
      );
      return res.content;
    },
  });
}
