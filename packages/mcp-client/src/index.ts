// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/mcp-client — MCP protocol client.
 *
 * Connects Nexus TO other MCP servers as a consumer.  Currently Nexus only
 * receives MCP connections (server side); this package closes the missing
 * half — Nexus can now call external tool registries.
 *
 * Architecture
 * ────────────
 *   McpClient           — stateful connection to one MCP server endpoint.
 *   McpHttpTransport    — HTTP/SSE transport (injectable fetch for tests).
 *   McpToolDefinition   — tool schema returned by list_tools.
 *   McpCallResult       — result of a tool call.
 *   McpResourceEntry    — resource entry returned by list_resources.
 *
 * Protocol
 * ────────
 *   MCP JSON-RPC 2.0 over HTTP POST to /mcp  (no streaming for now).
 *   Each request is a single JSON-RPC call; responses are JSON-RPC results.
 *
 * Usage
 * ─────
 * ```ts
 * const client = new McpClient({
 *   serverUrl: "https://tools.example.com/mcp",
 *   apiKey: "...",
 * });
 *
 * const tools = await client.listTools();
 * const result = await client.callTool("search_web", { query: "nexus ai" });
 * console.log(result.content);
 * ```
 */

import { randomUUID } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;

// ── Errors ────────────────────────────────────────────────────────────────────

export class McpClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

// ── JSON-RPC 2.0 types ────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function isError(r: JsonRpcResponse): r is JsonRpcError {
  return "error" in r;
}

// ── MCP schema types ──────────────────────────────────────────────────────────

export interface McpInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
}

/** Mcp tool definition interface definition. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: McpInputSchema;
}

/** Mcp call content interface definition. */
export interface McpCallContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

/** Mcp call result interface definition. */
export interface McpCallResult {
  content: McpCallContent[];
  isError?: boolean;
  /** Convenience: first text content block. */
  text: string;
}

/** Mcp resource entry interface definition. */
export interface McpResourceEntry {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Mcp resource content interface definition. */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** Mcp server info interface definition. */
export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion?: string;
}

/**
 * Capabilities a server advertises during `initialize`. Presence of a key (even
 * an empty object) means the corresponding feature is offered. The client gates
 * every optional method on the matching key so it never issues a request for a
 * capability the server did not scope in — "no unscoped capability".
 */
export interface McpServerCapabilities {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  completions?: Record<string, unknown>;
  logging?: Record<string, unknown>;
  [capability: string]: unknown;
}

/** A single argument accepted by a prompt template. */
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** Mcp prompt definition returned by `prompts/list`. */
export interface McpPromptDefinition {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

/** One message of a rendered prompt returned by `prompts/get`. */
export interface McpPromptMessage {
  role: "user" | "assistant";
  content: McpCallContent;
}

/** Result of `prompts/get` — a fully-rendered prompt. */
export interface McpGetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

/** Mcp resource template returned by `resources/templates/list`. */
export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Reference passed to `completion/complete` — a prompt or a resource. */
export type McpCompletionRef =
  { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string };

/** Result of `completion/complete` — autocompletion candidates for one argument. */
export interface McpCompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

// ── Transport ─────────────────────────────────────────────────────────────────

export interface McpTransport {
  send(method: string, params?: unknown): Promise<unknown>;
}

/** Mcp http transport. */
export class McpHttpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(opts: {
    url: string;
    apiKey?: string;
    extraHeaders?: Record<string, string>;
    fetchFn?: FetchFn;
    timeoutMs?: number;
  }) {
    this.url = opts.url;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      ...(opts.extraHeaders ?? {}),
    };
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchFn(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new McpClientError(`HTTP ${res.status}`, "HTTP_ERROR", { status: res.status });
      }

      const response = (await res.json()) as JsonRpcResponse;

      if (isError(response)) {
        throw new McpClientError(response.error.message, "RPC_ERROR", {
          code: response.error.code,
          data: response.error.data,
        });
      }

      return (response as JsonRpcSuccess).result;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── McpClient ─────────────────────────────────────────────────────────────────

export interface McpClientConfig {
  serverUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

/** Mcp client. */
export class McpClient {
  private readonly transport: McpTransport;
  private _serverInfo?: McpServerInfo;
  private _capabilities: McpServerCapabilities = {};
  private _initialized = false;

  constructor(config: McpClientConfig | McpTransport) {
    if ("send" in config) {
      // Accept a pre-built transport (useful for testing)
      this.transport = config;
    } else {
      this.transport = new McpHttpTransport({
        url: config.serverUrl,
        apiKey: config.apiKey,
        extraHeaders: config.extraHeaders,
        fetchFn: config.fetchFn,
        timeoutMs: config.timeoutMs,
      });
    }
  }

  /**
   * Initialize the MCP session (sends initialize + initialized).
   * Must be called before any other method on a fresh connection.
   * Safe to call multiple times (idempotent).
   */
  async initialize(): Promise<McpServerInfo> {
    if (this._initialized && this._serverInfo) return this._serverInfo;

    const result = (await this.transport.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {} },
      clientInfo: { name: "nexus-mcp-client", version: "0.0.0" },
    })) as Record<string, unknown>;

    this._serverInfo = {
      name: String(
        result["serverInfo"]
          ? ((result["serverInfo"] as Record<string, unknown>)["name"] ?? "")
          : "",
      ),
      version: String(
        result["serverInfo"]
          ? ((result["serverInfo"] as Record<string, unknown>)["version"] ?? "")
          : "",
      ),
      protocolVersion: String(result["protocolVersion"] ?? ""),
    };

    // Remember what the server scoped in so optional methods can be gated.
    this._capabilities =
      result["capabilities"] && typeof result["capabilities"] === "object"
        ? (result["capabilities"] as McpServerCapabilities)
        : {};

    // Notify server we are ready
    await this.transport.send("notifications/initialized").catch(() => {
      /* optional */
    });
    this._initialized = true;
    return this._serverInfo;
  }

  /**
   * List every tool the server offers, transparently following `nextCursor`
   * pagination until the listing is exhausted.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    return this.listPaged<McpToolDefinition>("tools/list", "tools");
  }

  /**
   * Call a tool on the server.
   * @param name    Tool name (must match one returned by listTools).
   * @param args    Arguments matching the tool's inputSchema.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    const result = (await this.transport.send("tools/call", {
      name,
      arguments: args,
    })) as Record<string, unknown>;

    const contentRaw = result["content"];
    const content: McpCallContent[] = Array.isArray(contentRaw)
      ? (contentRaw as McpCallContent[])
      : [];

    const isError = Boolean(result["isError"]);

    const text = content.find((c) => c.type === "text")?.text ?? "";

    return { content, isError, text };
  }

  /** List resources exposed by the server, following `nextCursor` pagination. */
  async listResources(): Promise<McpResourceEntry[]> {
    return this.listPaged<McpResourceEntry>("resources/list", "resources");
  }

  /** Read a resource by URI. */
  async readResource(uri: string): Promise<McpResourceContent> {
    const result = (await this.transport.send("resources/read", { uri })) as Record<
      string,
      unknown
    >;
    const contents = result["contents"];
    const first = Array.isArray(contents)
      ? (contents[0] as Record<string, unknown> | undefined)
      : undefined;
    return {
      uri,
      mimeType: String(first?.["mimeType"] ?? "text/plain"),
      text: first?.["text"] !== undefined ? String(first["text"]) : undefined,
      blob: first?.["blob"] !== undefined ? String(first["blob"]) : undefined,
    };
  }

  /**
   * Liveness check. Sends the JSON-RPC `ping`; resolves if the server answers,
   * rejects (via the transport) otherwise. Always allowed — no capability needed.
   */
  async ping(): Promise<void> {
    await this.transport.send("ping");
  }

  /**
   * List prompt templates offered by the server, following pagination.
   * Requires the server to have advertised the `prompts` capability.
   */
  async listPrompts(): Promise<McpPromptDefinition[]> {
    this.requireCapability("prompts");
    return this.listPaged<McpPromptDefinition>("prompts/list", "prompts");
  }

  /**
   * Render a prompt template by name with the given arguments.
   * Requires the `prompts` capability.
   */
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpGetPromptResult> {
    this.requireCapability("prompts");
    const result = (await this.transport.send("prompts/get", {
      name,
      arguments: args,
    })) as Record<string, unknown>;
    const messagesRaw = result["messages"];
    const messages: McpPromptMessage[] = Array.isArray(messagesRaw)
      ? (messagesRaw as McpPromptMessage[])
      : [];
    return {
      description: result["description"] !== undefined ? String(result["description"]) : undefined,
      messages,
    };
  }

  /**
   * List parameterised resource templates (URI templates) the server exposes,
   * following pagination. Requires the `resources` capability.
   */
  async listResourceTemplates(): Promise<McpResourceTemplate[]> {
    this.requireCapability("resources");
    return this.listPaged<McpResourceTemplate>("resources/templates/list", "resourceTemplates");
  }

  /**
   * Request argument autocompletion for a prompt or resource reference.
   * Requires the `completions` capability.
   */
  async complete(
    ref: McpCompletionRef,
    argument: { name: string; value: string },
  ): Promise<McpCompletionResult> {
    this.requireCapability("completions");
    const result = (await this.transport.send("completion/complete", {
      ref,
      argument,
    })) as Record<string, unknown>;
    const completion = (result["completion"] ?? {}) as Record<string, unknown>;
    const valuesRaw = completion["values"];
    return {
      values: Array.isArray(valuesRaw) ? valuesRaw.map((v) => String(v)) : [],
      total: completion["total"] !== undefined ? Number(completion["total"]) : undefined,
      hasMore: completion["hasMore"] !== undefined ? Boolean(completion["hasMore"]) : undefined,
    };
  }

  /** Capabilities the server advertised during the last initialize() call. */
  get capabilities(): McpServerCapabilities {
    return this._capabilities;
  }

  /** Server info from the last initialize() call. */
  get serverInfo(): McpServerInfo | undefined {
    return this._serverInfo;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * Drive a list method (tools/list, resources/list, ...) to completion,
   * concatenating every page's `key` array while a non-empty `nextCursor` is
   * returned. A hard page cap guards against a server that loops on one cursor.
   */
  private async listPaged<T>(method: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = (await this.transport.send(
        method,
        cursor !== undefined ? { cursor } : undefined,
      )) as Record<string, unknown>;
      const items = result[key];
      if (Array.isArray(items)) out.push(...(items as T[]));
      const next = result["nextCursor"];
      if (typeof next === "string" && next.length > 0 && next !== cursor) {
        cursor = next;
      } else {
        break;
      }
    }
    return out;
  }

  /**
   * Enforce that an optional method is only ever called after a successful
   * `initialize()` AND that the server scoped in the matching capability. This is
   * the "no unscoped capability" guard: the client refuses to emit a request the
   * server never said it could serve.
   */
  private requireCapability(name: keyof McpServerCapabilities): void {
    if (!this._initialized) {
      throw new McpClientError(
        `initialize() must be called before "${String(name)}" methods`,
        "NOT_INITIALIZED",
        { capability: name },
      );
    }
    if (this._capabilities[name] === undefined) {
      throw new McpClientError(
        `server does not advertise the "${String(name)}" capability`,
        "CAPABILITY_UNSUPPORTED",
        { capability: name },
      );
    }
  }
}
