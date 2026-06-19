// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/client — Class-based typed isomorphic SDK for the Nexus multi-agent platform.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NexusClientConfig {
  apiKey: string;
  baseUrl?: string; // default: https://api.nexus.dev
  version?: string; // default: v1
  timeout?: number; // default: 30000ms
}

export class NexusError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "NexusError";
  }
}

// ── Gateway / Chat Types ──────────────────────────────────────────────────────

export interface AnthropicContentPart {
  type: "text";
  text: string;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentPart[];
}

export interface GatewayMessageRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  max_spend_usd?: number;
}

export interface GatewayMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: { type: "text"; text: string }[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export type GatewayStreamEvent =
  | { type: "message_start"; message: Partial<GatewayMessageResponse> }
  | { type: "content_block_start"; index: number; content_block: { type: "text"; text: string } }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string; stop_sequence: string | null };
      usage?: { output_tokens: number };
    }
  | { type: "message_stop" };

export interface GatewayModelInfo {
  id: string;
  provider: string;
  backend_model: string;
  available: boolean;
}

export interface GatewayModelsResponse {
  models: GatewayModelInfo[];
  providers: string[];
}

export interface GatewayRaceRequest {
  tier?: "fast" | "standard" | "smart" | "power" | "ultra";
  messages: { role: string; content: string }[];
  models?: string[];
  params?: {
    temperature?: number;
    max_tokens?: number;
    [key: string]: unknown;
  };
  stream?: boolean;
}

export interface GatewayRaceResponse {
  winner: string;
  score: number;
  latencyMs: number;
  reasoning: string;
  response: string;
  scores: Record<string, number>;
}

export interface GatewayToolParameter {
  type: string;
  description?: string;
  required?: boolean;
}

export interface GatewayToolInfo {
  name: string;
  description: string;
  parameters: Record<string, GatewayToolParameter>;
}

export interface GatewayToolsResponse {
  tools: GatewayToolInfo[];
  total: number;
}

export interface ToolResult {
  tool: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface GatewayCostRun {
  runId: string;
  label?: string;
  startedAt: number;
  endedAt: number;
  totalUsd: number;
  totalTokens: number;
  steps: number;
}

export interface GatewayCostReportResponse {
  totalRuns: number;
  totalUsd: number;
  totalTokens: number;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  runs: GatewayCostRun[];
}

// ── Council Types ─────────────────────────────────────────────────────────────

export interface ProposalInput {
  title: string;
  description: string;
  context?: Record<string, unknown>;
  models?: string[];
}

export interface ModelVote {
  model: string;
  provider: string;
  vote: "yes" | "no" | "abstain";
  reasoning: string;
  confidence: number;
  latencyMs: number;
}

export interface ProposalResult {
  proposalId: string;
  title: string;
  outcome: "approved" | "rejected" | "deferred";
  votes: ModelVote[];
  consensus: number;
  dissent: number;
  majority: "yes" | "no" | "tie";
  summary: string;
  deliberatedAt: string;
  totalLatencyMs: number;
  totalCostUsd: number;
}

export interface CouncilResponse {
  ok: boolean;
  result?: ProposalResult;
  error?: string;
}

export interface CouncilVerdict {
  id: string;
  signalId: string | null;
  decision: "approve" | "reject" | "defer" | "escalate";
  confidence: string | number | null;
  rationale: string | null;
  dissents: string[] | null;
  costUsd: string | null;
  createdAt: string;
}

export interface CouncilTranscriptTurn {
  archetype: string;
  role: "assistant";
  content: string;
  confidence: number;
  latencyMs: number;
}

export interface CouncilTranscript {
  id: string;
  verdictId: string;
  turns: CouncilTranscriptTurn[];
  createdAt: string;
}

// ── Memory Types ──────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  createdAt: string | number;
  userId?: string;
  duplicate?: boolean;
}

export interface MemoryRecallResult {
  id: string;
  text: string;
  score: number;
  relevance: number;
  importance: number;
  recencyDecay: number;
  metadata?: Record<string, unknown>;
  createdAt: string | number;
  userId?: string;
}

export interface MemoryRecallResponse {
  results: MemoryRecallResult[];
  total: number;
}

// ── SDK Implementation ─────────────────────────────────────────────────────────

export class NexusClient {
  private apiKey: string;
  private baseUrl: string;
  private version: string;
  private timeout: number;

  constructor(config: NexusClientConfig) {
    if (!config.apiKey) {
      throw new Error("Nexus apiKey is required");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.nexus.dev";
    this.version = config.version ?? "v1";
    this.timeout = config.timeout ?? 30000;
  }

  /**
   * Helper to parse a Response body as a typed JSON value.
   * TypeScript 5 changed Response.json() to return Promise<unknown>;
   * this wrapper restores the typed convenience of the older signature.
   */
  private async _json<T>(res: Response): Promise<T> {
    return res.json() as unknown as T;
  }

  /**
   * Helper to perform HTTP requests.
   */
  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const url = `${this.baseUrl}/api/${this.version}${path}`;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(id);

      if (!response.ok) {
        let errDetails: unknown = null;
        try {
          errDetails = await response.json();
        } catch {
          // ignore parsing error if it wasn't JSON
        }
        throw new NexusError(
          "HTTP_ERROR",
          `Request failed with status ${response.status}`,
          response.status,
          errDetails,
        );
      }

      return response;
    } catch (err) {
      clearTimeout(id);
      if (err instanceof NexusError) {
        throw err;
      }
      throw new NexusError("NETWORK_ERROR", err instanceof Error ? err.message : String(err));
    }
  }

  // ── Gateway Namespace ────────────────────────────────────────────────────────

  public readonly gateway = {
    /**
     * Send a non-streaming message to the gateway.
     */
    sendMessage: async (opts: GatewayMessageRequest): Promise<GatewayMessageResponse> => {
      const response = await this.request("POST", "/gateway/messages", {
        ...opts,
        stream: false,
      });
      return this._json(response);
    },

    /**
     * Send a streaming message to the gateway.
     * Yields parsed Server-Sent Events.
     */
    sendMessageStream: async function* (
      this: NexusClient,
      opts: GatewayMessageRequest,
    ): AsyncGenerator<GatewayStreamEvent, void, unknown> {
      const response = await this.request("POST", "/gateway/messages", {
        ...opts,
        stream: true,
      });

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Response body is not readable");
      }
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = (await reader.read()) as {
            done: boolean;
            value: Uint8Array | undefined;
          };
          if (done) break;
          if (value !== undefined) buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("data: ")) {
              const dataStr = trimmed.slice(6).trim();
              if (dataStr === "[DONE]") {
                return;
              }
              try {
                const parsed = JSON.parse(dataStr) as GatewayStreamEvent;
                yield parsed;
              } catch {
                // Ignore parse errors on half-formed lines or non-JSON payloads
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }.bind(this),

    /**
     * List available models and providers.
     */
    listModels: async (): Promise<GatewayModelsResponse> => {
      const response = await this.request("GET", "/gateway/models");
      return this._json(response);
    },

    /**
     * Race N models via Ultraplinian.
     */
    race: async (opts: GatewayRaceRequest): Promise<GatewayRaceResponse> => {
      const response = await this.request("POST", "/gateway/race", opts);
      return this._json(response);
    },

    /**
     * List all registered tools.
     */
    listTools: async (): Promise<GatewayToolsResponse> => {
      const response = await this.request("GET", "/gateway/tools");
      return this._json(response);
    },

    /**
     * Invoke a tool by name.
     */
    invokeTool: async (name: string, input?: unknown): Promise<ToolResult> => {
      const response = await this.request("POST", "/gateway/tools/invoke", {
        name,
        input,
      });
      return this._json(response);
    },

    /**
     * Get aggregate run-cost and token usage reports.
     */
    getCostReport: async (opts?: {
      limit?: number;
      cursor?: string;
    }): Promise<GatewayCostReportResponse> => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.cursor) params.set("cursor", opts.cursor);

      const response = await this.request("GET", `/gateway/cost-report?${params.toString()}`);
      return this._json(response);
    },
  };

  // ── Council Namespace ────────────────────────────────────────────────────────

  public readonly council = {
    /**
     * Deliberate on a proposal ad-hoc.
     */
    deliberate: async (
      proposal: ProposalInput,
      opts?: { budgetUsd?: number; timeoutMs?: number; signalId?: string },
    ): Promise<CouncilResponse> => {
      const body = {
        proposal,
        budgetUsd: opts?.budgetUsd,
        timeoutMs: opts?.timeoutMs,
        signal_id: opts?.signalId,
      };
      const response = await this.request("POST", "/council/deliberate", body);
      return this._json(response);
    },

    /**
     * Get a list of past verdicts.
     */
    getVerdicts: async (): Promise<CouncilVerdict[]> => {
      const response = await this.request("GET", "/council/verdicts");
      return this._json(response);
    },

    /**
     * Get a specific past verdict.
     */
    getVerdict: async (verdictId: string): Promise<CouncilVerdict> => {
      const response = await this.request("GET", `/council/verdicts/${verdictId}`);
      return this._json(response);
    },

    /**
     * Get past transcripts for a verdict.
     */
    getTranscript: async (verdictId: string): Promise<CouncilTranscript> => {
      const response = await this.request("GET", `/council/transcripts/${verdictId}`);
      return this._json(response);
    },

    /**
     * Deliberate by triggering off an ingested signal ID.
     */
    trigger: async (opts: { signalId: string }): Promise<unknown> => {
      const response = await this.request("POST", "/council/trigger", {
        signalId: opts.signalId,
      });
      return response.json();
    },
  };

  // ── Memory Namespace ─────────────────────────────────────────────────────────

  public readonly memory = {
    /**
     * Persist a new text entry in long-term memory.
     */
    remember: async (
      text: string,
      opts?: { metadata?: Record<string, unknown>; ttl?: number; userId?: string },
    ): Promise<MemoryEntry> => {
      const response = await this.request("POST", "/memory", {
        text,
        metadata: opts?.metadata,
        ttl: opts?.ttl,
        userId: opts?.userId,
      });
      return this._json(response);
    },

    /**
     * Semantically recall memories matching a query string.
     */
    recall: async (
      query: string,
      opts?: { limit?: number; userId?: string },
    ): Promise<MemoryRecallResponse> => {
      const params = new URLSearchParams();
      if (query) params.set("query", query);
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.userId) params.set("userId", opts.userId);

      const response = await this.request("GET", `/memory?${params.toString()}`);
      return this._json(response);
    },

    /**
     * Idempotently forget a memory entry.
     */
    forget: async (id: string): Promise<void> => {
      await this.request("DELETE", `/memory/${id}`);
    },

    /**
     * List all memory entries (fast path, no similarity search).
     */
    list: async (opts?: { userId?: string }): Promise<MemoryEntry[]> => {
      const params = new URLSearchParams();
      if (opts?.userId) params.set("userId", opts.userId);

      const response = await this.request("GET", `/memory/list?${params.toString()}`);
      return this._json(response);
    },
  };

  // ── Agents Namespace ─────────────────────────────────────────────────────────

  public readonly agents = {
    /**
     * Query the librarian agent.
     */
    queryLibrarian: async (query: string, opts?: { limit?: number }): Promise<unknown> => {
      const response = await this.request("POST", "/agents/librarian/query", {
        query,
        limit: opts?.limit,
      });
      return response.json();
    },

    /**
     * Read a file in the agent sandbox.
     */
    readFile: async (path: string): Promise<{ content: string }> => {
      const params = new URLSearchParams({ path });
      const response = await this.request("GET", `/agents/file/read?${params.toString()}`);
      return this._json(response);
    },

    /**
     * Write a file in the agent sandbox.
     */
    writeFile: async (path: string, content: string): Promise<{ success: boolean }> => {
      const response = await this.request("POST", "/agents/file/write", {
        path,
        content,
      });
      return this._json(response);
    },

    /**
     * List files in the agent sandbox.
     */
    listFiles: async (opts?: { limit?: number }): Promise<string[]> => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      const response = await this.request("GET", `/agents/file/list?${params.toString()}`);
      return this._json(response);
    },
  };

  // ── Research Namespace ───────────────────────────────────────────────────────

  public readonly research = {
    /**
     * Start a new general research task.
     */
    startResearch: async (
      instruction: string,
      opts?: { limit?: number },
    ): Promise<{ runId: string }> => {
      const response = await this.request("POST", "/researcher/research", {
        instruction,
        limit: opts?.limit,
      });
      return this._json(response);
    },

    /**
     * Start a new academic research task.
     */
    startAcademic: async (
      instruction: string,
      opts?: { limit?: number },
    ): Promise<{ runId: string }> => {
      const response = await this.request("POST", "/researcher/academic", {
        instruction,
        limit: opts?.limit,
      });
      return this._json(response);
    },

    /**
     * Get citations for a research run.
     */
    getCitations: async (runId: string): Promise<unknown[]> => {
      const response = await this.request("GET", `/researcher/${runId}/citations`);
      return this._json(response);
    },
  };
}
