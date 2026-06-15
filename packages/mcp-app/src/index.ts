// SPDX-License-Identifier: Apache-2.0
/**
 * mcp-app — FastMCP-style Model Context Protocol application framework.
 *
 * Provides:
 *   • McpTool     — define tools with typed input schemas and handlers
 *   • McpResource — define resources (files, URIs) serveable over MCP
 *   • McpPrompt   — define reusable prompt templates
 *   • McpServer   — register tools/resources/prompts and dispatch requests
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type JsonSchemaType = "string" | "number" | "boolean" | "object" | "array" | "null";

export interface JsonSchemaProperty {
  type: JsonSchemaType;
  description?: string;
  enum?: (string | number)[];
  items?: JsonSchemaProperty;
}

export interface InputSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: InputSchema;
}

export type ToolResult =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "error"; text: string };

export type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

// ── Progress notifications ────────────────────────────────────────────────────
// Mirrors the MCP spec's notifications/progress message so long-running tools
// can stream progress to the caller (fastmcp ctx.reportProgress() pattern).

export interface McpProgressNotification {
  /** Opaque token issued per invocation; echoed in every update. */
  progressToken: string;
  /** Units of work completed. */
  progress: number;
  /** Total units (omit when unknown). */
  total?: number;
}

export type ProgressCallback = (n: McpProgressNotification) => void | Promise<void>;

/** Injected into progress-aware handlers so they can emit progress updates. */
export interface ToolContext {
  readonly progressToken: string;
  /**
   * Emit a progress update toward the caller's ProgressCallback.
   * Fire-and-forget — errors in the callback are swallowed.
   */
  reportProgress(progress: number, total?: number): void;
}

/**
 * Progress-aware tool handler.  Accepts both args and a ToolContext.
 * Old ToolHandler implementations still work (extra arg silently ignored).
 */
export type ProgressAwareHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => ToolResult | Promise<ToolResult>;

// ── McpTool ───────────────────────────────────────────────────────────────────

export class McpTool {
  readonly definition: McpToolDefinition;
  // Stored as ProgressAwareHandler (superset of ToolHandler) so both signatures work
  private handler: ProgressAwareHandler;

  constructor(definition: McpToolDefinition, handler: ToolHandler | ProgressAwareHandler) {
    this.definition = definition;
    this.handler = handler as ProgressAwareHandler;
  }

  /**
   * Invoke the tool.  If `ctx` is provided it is forwarded to the handler;
   * old-style handlers (arity 1) silently ignore the second argument.
   */
  async call(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const effectiveCtx: ToolContext = ctx ?? {
      progressToken: "",
      reportProgress: () => { /* no-op when called without a context */ },
    };
    return this.handler(args, effectiveCtx);
  }
}

// ── McpResource ───────────────────────────────────────────────────────────────

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export type ResourceReader = (uri: string) => { content: string; mimeType?: string } | Promise<{ content: string; mimeType?: string }>;

export class McpResource {
  readonly definition: McpResourceDefinition;
  private reader: ResourceReader;

  constructor(definition: McpResourceDefinition, reader: ResourceReader) {
    this.definition = definition;
    this.reader = reader;
  }

  async read(): Promise<{ content: string; mimeType?: string }> {
    return this.reader(this.definition.uri);
  }
}

// ── McpPrompt ─────────────────────────────────────────────────────────────────

export interface McpPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export type PromptBuilder = (args: Record<string, string>) => string | Promise<string>;

export class McpPrompt {
  readonly definition: McpPromptDefinition;
  private builder: PromptBuilder;

  constructor(definition: McpPromptDefinition, builder: PromptBuilder) {
    this.definition = definition;
    this.builder = builder;
  }

  async render(args: Record<string, string> = {}): Promise<string> {
    return this.builder(args);
  }
}

// ── McpError ──────────────────────────────────────────────────────────────────

export class McpError extends Error {
  constructor(
    public readonly code: "TOOL_NOT_FOUND" | "RESOURCE_NOT_FOUND" | "PROMPT_NOT_FOUND" | "VALIDATION_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

// ── McpServer ─────────────────────────────────────────────────────────────────

export interface McpServerInfo {
  name: string;
  version: string;
  description?: string;
}

export class McpServer {
  private tools     = new Map<string, McpTool>();
  private resources = new Map<string, McpResource>();
  private prompts   = new Map<string, McpPrompt>();

  constructor(public readonly info: McpServerInfo) {}

  // ── Registration ──────────────────────────────────────────────────────────

  tool(definition: McpToolDefinition, handler: ToolHandler): this {
    this.tools.set(definition.name, new McpTool(definition, handler));
    return this;
  }

  resource(definition: McpResourceDefinition, reader: ResourceReader): this {
    this.resources.set(definition.uri, new McpResource(definition, reader));
    return this;
  }

  prompt(definition: McpPromptDefinition, builder: PromptBuilder): this {
    this.prompts.set(definition.name, new McpPrompt(definition, builder));
    return this;
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  listTools(): McpToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  listResources(): McpResourceDefinition[] {
    return [...this.resources.values()].map((r) => r.definition);
  }

  listPrompts(): McpPromptDefinition[] {
    return [...this.prompts.values()].map((p) => p.definition);
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  /**
   * Call a registered tool.
   *
   * @param onProgress  Optional callback invoked whenever the handler calls
   *                    ctx.reportProgress().  Enables the server to relay MCP
   *                    notifications/progress events to a connected client.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    onProgress?: ProgressCallback,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new McpError("TOOL_NOT_FOUND", `Tool not found: ${name}`);

    // Build a ToolContext for this invocation
    const progressToken = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ctx: ToolContext = {
      progressToken,
      reportProgress: (progress, total) => {
        if (!onProgress) return;
        void Promise.resolve(
          onProgress({ progressToken, progress, total }),
        ).catch(() => { /* progress errors are non-fatal */ });
      },
    };

    return tool.call(args, ctx);
  }

  async readResource(uri: string): Promise<{ content: string; mimeType?: string }> {
    const resource = this.resources.get(uri);
    if (!resource) throw new McpError("RESOURCE_NOT_FOUND", `Resource not found: ${uri}`);
    return resource.read();
  }

  async renderPrompt(name: string, args: Record<string, string> = {}): Promise<string> {
    const prompt = this.prompts.get(name);
    if (!prompt) throw new McpError("PROMPT_NOT_FOUND", `Prompt not found: ${name}`);
    return prompt.render(args);
  }

  hasTool(name: string): boolean { return this.tools.has(name); }
  hasResource(uri: string): boolean { return this.resources.has(uri); }
  hasPrompt(name: string): boolean { return this.prompts.has(name); }
}
