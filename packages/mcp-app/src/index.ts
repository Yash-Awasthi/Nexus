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

// ── McpTool ───────────────────────────────────────────────────────────────────

export class McpTool {
  readonly definition: McpToolDefinition;
  private handler: ToolHandler;

  constructor(definition: McpToolDefinition, handler: ToolHandler) {
    this.definition = definition;
    this.handler = handler;
  }

  async call(args: Record<string, unknown>): Promise<ToolResult> {
    return this.handler(args);
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

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new McpError("TOOL_NOT_FOUND", `Tool not found: ${name}`);
    return tool.call(args);
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
