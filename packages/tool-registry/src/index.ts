// SPDX-License-Identifier: Apache-2.0
/**
 * tool-registry — First-class typed native tool definitions with JSON schemas.
 *
 * Separate from MCP — these are agent-internal tools with:
 *   • ToolSchema     — JSON Schema describing input parameters
 *   • ToolDefinition — name + description + schema + async handler
 *   • ToolRegistry   — register / get / list / invoke with error capture
 *   • ToolResult     — typed success/error envelope
 *   • Built-in tools — web_search, github_read_file, papers, dataset,
 *                      sandbox, plan, notify
 */

// ── JSON Schema subset ────────────────────────────────────────────────────────

export type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
}

// ── Tool types ────────────────────────────────────────────────────────────────

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (input: TInput, ctx?: ToolContext) => Promise<TOutput>;
}

export interface ToolContext {
  sessionId?: string;
  userId?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface ToolResult<T = unknown> {
  tool: string;
  success: boolean;
  output?: T;
  error?: string;
  durationMs: number;
}

// ── ToolRegistry ──────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<unknown, unknown>>();

  register<TI, TO>(tool: ToolDefinition<TI, TO>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>);
    return this;
  }

  /** Register or overwrite an existing tool. */
  upsert<TI, TO>(tool: ToolDefinition<TI, TO>): this {
    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>);
    return this;
  }

  get(name: string): ToolDefinition<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean { return this.tools.has(name); }

  list(): ToolDefinition<unknown, unknown>[] {
    return [...this.tools.values()];
  }

  names(): string[] { return [...this.tools.keys()]; }

  unregister(name: string): boolean { return this.tools.delete(name); }

  clear(): void { this.tools.clear(); }

  size(): number { return this.tools.size; }

  /** Invoke a tool by name. Returns a typed ToolResult. */
  async invoke<T = unknown>(name: string, input: unknown, ctx?: ToolContext): Promise<ToolResult<T>> {
    const tool = this.tools.get(name);
    const t0 = Date.now();

    if (!tool) {
      return { tool: name, success: false, error: `Tool '${name}' not found`, durationMs: 0 };
    }

    try {
      const output = await tool.handler(input, ctx);
      return { tool: name, success: true, output: output as T, durationMs: Date.now() - t0 };
    } catch (err) {
      return {
        tool: name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      };
    }
  }

  /** Invoke multiple tools in parallel. */
  async invokeAll(calls: Array<{ name: string; input: unknown; ctx?: ToolContext }>): Promise<ToolResult[]> {
    return Promise.all(calls.map(({ name, input, ctx }) => this.invoke(name, input, ctx)));
  }

  /** Return tool schemas in a format suitable for LLM function-calling. */
  toLlmTools(): Array<{ name: string; description: string; parameters: JsonSchema }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }
}

// ── Built-in tool input/output types ─────────────────────────────────────────

export interface WebSearchInput {
  query: string;
  maxResults?: number;
  freshness?: "day" | "week" | "month" | "any";
}
export interface WebSearchOutput {
  results: Array<{ title: string; url: string; snippet: string }>;
  query: string;
  totalResults?: number;
}

export interface GithubReadFileInput {
  owner: string;
  repo: string;
  path: string;
  ref?: string; // branch/tag/commit
}
export interface GithubReadFileOutput {
  content: string;
  encoding: string;
  size: number;
  sha: string;
  path: string;
}

export interface PapersSearchInput {
  query: string;
  maxResults?: number;
  fields?: string[];
  yearFrom?: number;
  yearTo?: number;
}
export interface PapersSearchOutput {
  papers: Array<{
    paperId: string;
    title: string;
    authors: string[];
    year?: number;
    abstract?: string;
    citationCount?: number;
    url?: string;
  }>;
}

export interface DatasetInput {
  name: string;
  split?: "train" | "validation" | "test";
  maxRows?: number;
  columns?: string[];
}
export interface DatasetOutput {
  rows: Record<string, unknown>[];
  totalRows: number;
  schema: Record<string, string>;
}

export interface SandboxInput {
  language: "python" | "r" | "julia";
  code: string;
  timeoutMs?: number;
}
export interface SandboxOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface PlanInput {
  goal: string;
  context?: string;
  maxSteps?: number;
}
export interface PlanOutput {
  steps: Array<{ step: number; description: string; tools?: string[] }>;
  estimatedTurns: number;
}

export interface NotifyInput {
  channel: "email" | "slack" | "webhook" | "log";
  subject: string;
  body: string;
  recipient?: string;
}
export interface NotifyOutput {
  sent: boolean;
  channel: string;
  messageId?: string;
}

// ── Injectable handler type ───────────────────────────────────────────────────

export type ToolHandlerMap = {
  web_search?: (input: WebSearchInput, ctx?: ToolContext) => Promise<WebSearchOutput>;
  github_read_file?: (input: GithubReadFileInput, ctx?: ToolContext) => Promise<GithubReadFileOutput>;
  papers?: (input: PapersSearchInput, ctx?: ToolContext) => Promise<PapersSearchOutput>;
  dataset?: (input: DatasetInput, ctx?: ToolContext) => Promise<DatasetOutput>;
  sandbox?: (input: SandboxInput, ctx?: ToolContext) => Promise<SandboxOutput>;
  plan?: (input: PlanInput, ctx?: ToolContext) => Promise<PlanOutput>;
  notify?: (input: NotifyInput, ctx?: ToolContext) => Promise<NotifyOutput>;
};

// ── Default (stub) handlers ───────────────────────────────────────────────────

function notImpl(name: string): () => never {
  return () => { throw new Error(`${name}: no handler injected`); };
}

// ── Built-in tool definitions ─────────────────────────────────────────────────

export function createWebSearchTool(handler?: ToolHandlerMap["web_search"]): ToolDefinition<WebSearchInput, WebSearchOutput> {
  return {
    name: "web_search",
    description: "Search the web for up-to-date information",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        maxResults: { type: "integer", default: 10, minimum: 1, maximum: 50 },
        freshness: { type: "string", enum: ["day", "week", "month", "any"], default: "any" },
      },
      required: ["query"],
    },
    handler: handler ?? notImpl("web_search"),
  };
}

export function createGithubReadFileTool(handler?: ToolHandlerMap["github_read_file"]): ToolDefinition<GithubReadFileInput, GithubReadFileOutput> {
  return {
    name: "github_read_file",
    description: "Read a file from a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner (user or org)" },
        repo: { type: "string", description: "Repository name" },
        path: { type: "string", description: "File path within the repository" },
        ref: { type: "string", description: "Branch, tag, or commit SHA (default: HEAD)" },
      },
      required: ["owner", "repo", "path"],
    },
    handler: handler ?? notImpl("github_read_file"),
  };
}

export function createPapersTool(handler?: ToolHandlerMap["papers"]): ToolDefinition<PapersSearchInput, PapersSearchOutput> {
  return {
    name: "papers",
    description: "Search academic papers on Semantic Scholar",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer", default: 10, minimum: 1, maximum: 100 },
        fields: { type: "array", items: { type: "string" } },
        yearFrom: { type: "integer" },
        yearTo: { type: "integer" },
      },
      required: ["query"],
    },
    handler: handler ?? notImpl("papers"),
  };
}

export function createDatasetTool(handler?: ToolHandlerMap["dataset"]): ToolDefinition<DatasetInput, DatasetOutput> {
  return {
    name: "dataset",
    description: "Load rows from a named ML dataset",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Dataset identifier (e.g. HuggingFace path)" },
        split: { type: "string", enum: ["train", "validation", "test"], default: "train" },
        maxRows: { type: "integer", default: 100 },
        columns: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
    },
    handler: handler ?? notImpl("dataset"),
  };
}

export function createSandboxTool(handler?: ToolHandlerMap["sandbox"]): ToolDefinition<SandboxInput, SandboxOutput> {
  return {
    name: "sandbox",
    description: "Execute code in an isolated sandbox environment",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "r", "julia"] },
        code: { type: "string", description: "Code to execute" },
        timeoutMs: { type: "integer", default: 30000, minimum: 1000, maximum: 300000 },
      },
      required: ["language", "code"],
    },
    handler: handler ?? notImpl("sandbox"),
  };
}

export function createPlanTool(handler?: ToolHandlerMap["plan"]): ToolDefinition<PlanInput, PlanOutput> {
  return {
    name: "plan",
    description: "Break a goal into an ordered execution plan",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The objective to plan for" },
        context: { type: "string" },
        maxSteps: { type: "integer", default: 10, minimum: 1, maximum: 50 },
      },
      required: ["goal"],
    },
    handler: handler ?? notImpl("plan"),
  };
}

export function createNotifyTool(handler?: ToolHandlerMap["notify"]): ToolDefinition<NotifyInput, NotifyOutput> {
  return {
    name: "notify",
    description: "Send a notification via the specified channel",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["email", "slack", "webhook", "log"] },
        subject: { type: "string" },
        body: { type: "string" },
        recipient: { type: "string" },
      },
      required: ["channel", "subject", "body"],
    },
    handler: handler ?? notImpl("notify"),
  };
}

/** Create a ToolRegistry pre-loaded with all built-in tools. */
export function createDefaultRegistry(handlers: ToolHandlerMap = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createWebSearchTool(handlers.web_search));
  registry.register(createGithubReadFileTool(handlers.github_read_file));
  registry.register(createPapersTool(handlers.papers));
  registry.register(createDatasetTool(handlers.dataset));
  registry.register(createSandboxTool(handlers.sandbox));
  registry.register(createPlanTool(handlers.plan));
  registry.register(createNotifyTool(handlers.notify));
  return registry;
}
