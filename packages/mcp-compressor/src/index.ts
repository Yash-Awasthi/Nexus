// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/mcp-compressor — shrink MCP tool manifests 60–95%.
 *
 * A powerful MCP server can expose dozens or hundreds of tools, each carrying a
 * name, description, and a potentially large JSON Schema. Sending all of that to
 * the model up front burns thousands of tokens before the agent does any work.
 *
 * This library collapses that surface into a fixed **3-tool gateway** the model
 * drills into on demand — the same interaction pattern as Atlassian's
 * `mcp-compressor`, implemented as a dependency-free TypeScript library:
 *
 *   • `list_tools`       — returns a compact catalog (name + one-line summary).
 *   • `get_tool_schema`  — returns the full input schema for ONE named tool.
 *   • `invoke_tool`      — calls a named backend tool with arguments.
 *
 * The model first sees three small tools instead of the whole manifest, lists
 * the catalog, fetches the schema only for the tool it wants, then invokes it.
 *
 * Two entry points:
 *   • {@link compressManifest} — pure function: manifest in, compact gateway +
 *     savings stats out. No I/O; ideal for measuring or for static wiring.
 *   • {@link CompressedToolProxy} — wraps any backend exposing `listTools` /
 *     `callTool` (structurally an `@nexus/mcp-client` `McpClient`) and serves the
 *     gateway surface, routing gateway calls to the backend on demand. Unknown
 *     tool names pass straight through, so mixed direct/gateway use still works.
 */

// ── Structural backend contract ───────────────────────────────────────────────
// Mirrors the slice of `@nexus/mcp-client`'s McpClient this library needs, so we
// take no dependency on the transport package (same seam as agent-runtime's
// mcp-tools bridge).

/** A tool advertised by a backend — subset of McpToolDefinition. */
export interface ToolManifestEntry {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    description?: string;
  };
}

/** Result of a tool call — subset of McpCallResult. */
export interface ToolCallResult {
  content: { type: string; text?: string; [k: string]: unknown }[];
  isError?: boolean;
  /** Convenience: first text content block. */
  text: string;
}

/** The backend surface the compressor sits in front of. */
export interface CompressorBackend {
  listTools(): Promise<ToolManifestEntry[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

// ── Options ───────────────────────────────────────────────────────────────────

/** Names for the three gateway tools; override to namespace or avoid collisions. */
export interface GatewayToolNames {
  listTools: string;
  getToolSchema: string;
  invokeTool: string;
}

export const DEFAULT_GATEWAY_NAMES: GatewayToolNames = {
  listTools: "list_tools",
  getToolSchema: "get_tool_schema",
  invokeTool: "invoke_tool",
};

/** Options for {@link compressManifest} / {@link CompressedToolProxy}. */
export interface CompressOptions {
  /** Override the gateway tool names. */
  names?: Partial<GatewayToolNames>;
  /** Max characters of each tool's one-line catalog summary. Default 100. */
  summaryMaxChars?: number;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/** Manifest-size comparison, char-based with a ~4-chars/token approximation. */
export interface CompressStats {
  backendTools: number;
  gatewayTools: number;
  /** Chars of the full backend manifest (JSON). */
  fullChars: number;
  /** Chars of the compact gateway surface (JSON). */
  compressedChars: number;
  savedChars: number;
  /** savedChars / fullChars, 0..1 (0 when the manifest was already empty). */
  ratio: number;
  approxFullTokens: number;
  approxCompressedTokens: number;
}

/** A catalog row: one backend tool, name + trimmed summary. */
export interface CatalogEntry {
  name: string;
  summary: string;
}

/** Output of {@link compressManifest}. */
export interface CompressedManifest {
  gatewayTools: ToolManifestEntry[];
  catalog: CatalogEntry[];
  stats: CompressStats;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveNames(names?: Partial<GatewayToolNames>): GatewayToolNames {
  return { ...DEFAULT_GATEWAY_NAMES, ...names };
}

/** First sentence / line of a description, collapsed and truncated. */
function summarize(description: string | undefined, maxChars: number): string {
  if (!description) return "";
  const collapsed = description.replace(/\s+/g, " ").trim();
  const period = collapsed.indexOf(". ");
  const firstSentence = period > 0 ? collapsed.slice(0, period + 1) : collapsed;
  if (firstSentence.length <= maxChars) return firstSentence;
  return `${firstSentence.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Rough token estimate: 4 chars per token, rounded up. */
function approxTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function textResult(text: string, isError = false): ToolCallResult {
  return { content: [{ type: "text", text }], isError, text };
}

/** Build the three gateway tool definitions. */
function buildGatewayTools(names: GatewayToolNames): ToolManifestEntry[] {
  return [
    {
      name: names.listTools,
      description:
        "List the available backend tools as a compact catalog (name + one-line " +
        "summary). Optionally filter by a case-insensitive substring. Call this " +
        "first to discover tools without loading every schema.",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description: "Optional case-insensitive substring to match on name or summary.",
          },
        },
      },
    },
    {
      name: names.getToolSchema,
      description:
        "Return the full input schema and description for ONE backend tool by " +
        "name. Call this only for the tool you intend to invoke.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "The backend tool name." } },
        required: ["name"],
      },
    },
    {
      name: names.invokeTool,
      description:
        "Invoke a backend tool by name with its arguments. Fetch its schema with " +
        "get_tool_schema first if you are unsure of the arguments.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The backend tool name to invoke." },
          arguments: {
            type: "object",
            description: "Arguments matching the tool's input schema.",
          },
        },
        required: ["name"],
      },
    },
  ];
}

// ── Pure compression ──────────────────────────────────────────────────────────

/**
 * Collapse a backend tool manifest into the compact 3-tool gateway surface and
 * report how much was saved. Pure — no I/O.
 */
export function compressManifest(
  tools: ToolManifestEntry[],
  opts: CompressOptions = {},
): CompressedManifest {
  const names = resolveNames(opts.names);
  const summaryMax = opts.summaryMaxChars ?? 100;

  const catalog: CatalogEntry[] = tools.map((t) => ({
    name: t.name,
    summary: summarize(t.description, summaryMax),
  }));
  const gatewayTools = buildGatewayTools(names);

  const fullChars = JSON.stringify(tools).length;
  const compressedChars = JSON.stringify(gatewayTools).length;
  const savedChars = Math.max(0, fullChars - compressedChars);
  const ratio = fullChars > 0 ? savedChars / fullChars : 0;

  return {
    gatewayTools,
    catalog,
    stats: {
      backendTools: tools.length,
      gatewayTools: gatewayTools.length,
      fullChars,
      compressedChars,
      savedChars,
      ratio,
      approxFullTokens: approxTokens(fullChars),
      approxCompressedTokens: approxTokens(compressedChars),
    },
  };
}

// ── Live proxy ────────────────────────────────────────────────────────────────

/** Error raised by the compressor for malformed gateway calls. */
export class McpCompressorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "McpCompressorError";
  }
}

/**
 * Wraps a {@link CompressorBackend} and serves the compact gateway surface.
 *
 * `listTools()` returns the three gateway tools. `callTool()` routes:
 *   • `list_tools`      → the compact catalog (optionally filtered),
 *   • `get_tool_schema` → the full schema of one backend tool,
 *   • `invoke_tool`     → a forwarded backend call,
 *   • anything else     → passed straight through to the backend.
 *
 * Call {@link init} once (or any routing method auto-inits) to snapshot the
 * backend manifest.
 */
export class CompressedToolProxy {
  private readonly backend: CompressorBackend;
  private readonly names: GatewayToolNames;
  private readonly summaryMax: number;
  private manifest?: CompressedManifest;
  private byName = new Map<string, ToolManifestEntry>();

  constructor(backend: CompressorBackend, opts: CompressOptions = {}) {
    this.backend = backend;
    this.names = resolveNames(opts.names);
    this.summaryMax = opts.summaryMaxChars ?? 100;
  }

  /** Snapshot the backend manifest and build the gateway. Idempotent. */
  async init(force = false): Promise<CompressStats> {
    if (this.manifest && !force) return this.manifest.stats;
    const tools = await this.backend.listTools();
    this.manifest = compressManifest(tools, {
      names: this.names,
      summaryMaxChars: this.summaryMax,
    });
    this.byName = new Map(tools.map((t) => [t.name, t]));
    return this.manifest.stats;
  }

  private async ensureInit(): Promise<CompressedManifest> {
    if (!this.manifest) await this.init();
    return this.manifest!;
  }

  /** The compact gateway tools the model should see. */
  async listTools(): Promise<ToolManifestEntry[]> {
    const m = await this.ensureInit();
    return m.gatewayTools;
  }

  /** Savings stats from the last {@link init}, if any. */
  get stats(): CompressStats | undefined {
    return this.manifest?.stats;
  }

  /** Route a (gateway or passthrough) tool call. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const m = await this.ensureInit();

    if (name === this.names.listTools) {
      const filter = typeof args["filter"] === "string" ? args["filter"].toLowerCase() : undefined;
      const rows = filter
        ? m.catalog.filter(
            (c) =>
              c.name.toLowerCase().includes(filter) || c.summary.toLowerCase().includes(filter),
          )
        : m.catalog;
      return textResult(JSON.stringify(rows));
    }

    if (name === this.names.getToolSchema) {
      const target = String(args["name"] ?? "");
      const tool = this.byName.get(target);
      if (!tool) {
        return textResult(`unknown tool: ${target}`, true);
      }
      return textResult(
        JSON.stringify({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        }),
      );
    }

    if (name === this.names.invokeTool) {
      const target = String(args["name"] ?? "");
      if (!this.byName.has(target)) {
        return textResult(`unknown tool: ${target}`, true);
      }
      const toolArgs =
        args["arguments"] && typeof args["arguments"] === "object"
          ? (args["arguments"] as Record<string, unknown>)
          : {};
      return this.backend.callTool(target, toolArgs);
    }

    // Passthrough: a direct backend tool name still works.
    return this.backend.callTool(name, args);
  }
}
