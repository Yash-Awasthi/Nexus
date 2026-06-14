// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/mcp-bulk — FastMCP bulk tool caller.
 *
 * Batches multiple MCP tool calls in a single operation with result
 * aggregation.  Currently all MCP calls are one-at-a-time; this closes
 * that gap.
 *
 * Architecture
 * ────────────
 *   bulkCall()          — execute N tool calls in parallel, collect results.
 *   sequentialBulkCall()— execute N calls sequentially (for rate-limited APIs).
 *   BulkToolCaller      — stateful; wraps an McpClient-like interface.
 *   BulkCallResult      — per-call result with success/error isolation.
 *
 * Key property
 * ────────────
 *   One failure does NOT abort the batch.  Each call gets its own result
 *   slot.  The caller decides whether to retry individual failures.
 *
 * Usage
 * ─────
 * ```ts
 * const caller = new BulkToolCaller({ client: mcpClient });
 * const results = await caller.call([
 *   { tool: "search_web",  args: { query: "nexus ai" } },
 *   { tool: "read_file",   args: { path: "/etc/hosts" } },
 *   { tool: "get_weather", args: { city: "NYC" } },
 * ]);
 * ```
 */

// ── Injectable tool client ────────────────────────────────────────────────────

export interface McpCallContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

export interface McpToolCallResult {
  content: McpCallContent[];
  isError?: boolean;
  text: string;
}

export interface McpToolClient {
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
}

// ── Request / Result types ────────────────────────────────────────────────────

export interface BulkToolRequest {
  /** Correlation ID for the caller to match results. Default: auto-generated index. */
  id?: string;
  tool: string;
  args?: Record<string, unknown>;
}

export interface BulkCallResult {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  result?: McpToolCallResult;
  error?: string;
  durationMs: number;
}

export interface BulkCallSummary {
  total: number;
  succeeded: number;
  failed: number;
  totalDurationMs: number;
  results: BulkCallResult[];
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Execute N tool calls in parallel. One failure does not abort others.
 */
export async function bulkCall(
  client: McpToolClient,
  requests: BulkToolRequest[],
): Promise<BulkCallSummary> {
  const t0 = Date.now();

  const pending = requests.map(async (req, i): Promise<BulkCallResult> => {
    const id = req.id ?? String(i);
    const args = req.args ?? {};
    const callStart = Date.now();

    try {
      const result = await client.callTool(req.tool, args);
      return {
        id,
        tool: req.tool,
        args,
        success: !result.isError,
        result,
        durationMs: Date.now() - callStart,
      };
    } catch (err) {
      return {
        id,
        tool: req.tool,
        args,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - callStart,
      };
    }
  });

  const results = await Promise.all(pending);
  const succeeded = results.filter((r) => r.success).length;

  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    totalDurationMs: Date.now() - t0,
    results,
  };
}

/**
 * Execute N tool calls sequentially. Useful for APIs with strict rate limits.
 * One failure is recorded but does not abort remaining calls.
 */
export async function sequentialBulkCall(
  client: McpToolClient,
  requests: BulkToolRequest[],
  opts: { delayMs?: number } = {},
): Promise<BulkCallSummary> {
  const t0 = Date.now();
  const results: BulkCallResult[] = [];
  const delayMs = opts.delayMs ?? 0;

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]!;
    const id = req.id ?? String(i);
    const args = req.args ?? {};
    const callStart = Date.now();

    try {
      const result = await client.callTool(req.tool, args);
      results.push({
        id,
        tool: req.tool,
        args,
        success: !result.isError,
        result,
        durationMs: Date.now() - callStart,
      });
    } catch (err) {
      results.push({
        id,
        tool: req.tool,
        args,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - callStart,
      });
    }

    if (delayMs > 0 && i < requests.length - 1) {
      await sleep(delayMs);
    }
  }

  const succeeded = results.filter((r) => r.success).length;

  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    totalDurationMs: Date.now() - t0,
    results,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── BulkToolCaller class ──────────────────────────────────────────────────────

export type ExecutionMode = "parallel" | "sequential";

export interface BulkToolCallerConfig {
  client: McpToolClient;
  mode?: ExecutionMode;
  /** Only used in sequential mode. */
  delayMs?: number;
  /** Maximum number of requests per batch (0 = unlimited, default: 50) */
  maxBatchSize?: number;
}

export class BulkToolCaller {
  private readonly client: McpToolClient;
  private readonly mode: ExecutionMode;
  private readonly delayMs: number;
  private readonly maxBatchSize: number;

  constructor(config: BulkToolCallerConfig) {
    this.client = config.client;
    this.mode = config.mode ?? "parallel";
    this.delayMs = config.delayMs ?? 0;
    this.maxBatchSize = config.maxBatchSize ?? 50;
  }

  async call(requests: BulkToolRequest[]): Promise<BulkCallSummary> {
    if (requests.length === 0) {
      return { total: 0, succeeded: 0, failed: 0, totalDurationMs: 0, results: [] };
    }

    if (this.maxBatchSize > 0 && requests.length > this.maxBatchSize) {
      throw new Error(
        `Batch size ${requests.length} exceeds maxBatchSize ${this.maxBatchSize}`,
      );
    }

    if (this.mode === "sequential") {
      return sequentialBulkCall(this.client, requests, { delayMs: this.delayMs });
    }

    return bulkCall(this.client, requests);
  }

  /**
   * Partition requests into batches and execute each batch.
   * Useful when the server has a per-request limit but you have many calls.
   */
  async callInBatches(
    requests: BulkToolRequest[],
    batchSize: number,
  ): Promise<BulkCallSummary[]> {
    const summaries: BulkCallSummary[] = [];

    for (let i = 0; i < requests.length; i += batchSize) {
      const batch = requests.slice(i, i + batchSize);
      const summary = await this.call(batch);
      summaries.push(summary);
    }

    return summaries;
  }
}

// ── Null client for tests ────────────────────────────────────────────────────

export interface NullMcpClientOptions {
  responses?: Record<string, McpToolCallResult>;
  error?: string;
  delayMs?: number;
}

export class NullMcpToolClient implements McpToolClient {
  private readonly responses: Record<string, McpToolCallResult>;
  private readonly errorMsg: string | undefined;
  private readonly delayMs: number;

  constructor(opts: NullMcpClientOptions = {}) {
    this.responses = opts.responses ?? {};
    this.errorMsg = opts.error;
    this.delayMs = opts.delayMs ?? 0;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (this.errorMsg) throw new Error(this.errorMsg);
    const saved = this.responses[name];
    if (saved !== undefined) return saved;
    return {
      content: [{ type: "text", text: `null result for ${name}(${JSON.stringify(args)})` }],
      isError: false,
      text: `null result for ${name}`,
    };
  }
}
