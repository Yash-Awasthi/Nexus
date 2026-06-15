// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/mcp-openapi — FastMCP OpenAPI spec generator.
 *
 * Auto-generates an OpenAPI 3.1 spec from registered MCP tool definitions.
 * Lets external systems discover and call Nexus MCP tools via standard REST
 * without understanding the MCP JSON-RPC protocol.
 *
 * Architecture
 * ────────────
 *   generateOpenApiSpec()   — pure function: McpToolDefinition[] → OpenAPI spec.
 *   mcpTypeToJsonSchema()   — map MCP input schema to OpenAPI parameter types.
 *   generateToolPath()      — convert one tool into a POST /tools/{name} path.
 *
 * Generated spec structure
 * ────────────────────────
 *   POST /tools/{toolName}    — call a tool (body = tool arguments)
 *   GET  /tools               — list all tools
 *   GET  /tools/{toolName}    — describe a single tool
 *
 * Usage
 * ─────
 * ```ts
 * import { generateOpenApiSpec } from "@nexus/mcp-openapi";
 *
 * const spec = generateOpenApiSpec(tools, {
 *   title: "My Nexus MCP API",
 *   serverUrl: "https://api.example.com",
 * });
 * // Serve spec as JSON at /openapi.json
 * ```
 */

// ── Input types (structural subset of MCP types) ──────────────────────────────

export interface McpInputSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
}

/** Mcp tool definition interface definition. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: McpInputSchema;
}

// ── OpenAPI 3.1 types (minimal) ───────────────────────────────────────────────

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

/** Open api server interface definition. */
export interface OpenApiServer {
  url: string;
  description?: string;
}

/** Json schema type type alias. */
export type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

/** Open api schema interface definition. */
export interface OpenApiSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  format?: string;
  [key: string]: unknown;
}

/** Open api request body interface definition. */
export interface OpenApiRequestBody {
  required: boolean;
  description?: string;
  content: {
    "application/json": {
      schema: OpenApiSchema;
    };
  };
}

/** Open api response interface definition. */
export interface OpenApiResponse {
  description: string;
  content?: {
    "application/json": {
      schema: OpenApiSchema;
    };
  };
}

/** Open api operation interface definition. */
export interface OpenApiOperation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
}

/** Open api path item interface definition. */
export interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  delete?: OpenApiOperation;
}

/** Open api spec interface definition. */
export interface OpenApiSpec {
  openapi: "3.1.0";
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, unknown>;
  };
  tags?: Array<{ name: string; description?: string }>;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface GenerateOpenApiOptions {
  /** API title (default: "Nexus MCP API") */
  title?: string;
  /** Semver version (default: "1.0.0") */
  version?: string;
  /** API description */
  description?: string;
  /** Server base URL */
  serverUrl?: string;
  /** Path prefix for tool endpoints (default: "/tools") */
  basePath?: string;
  /** Include a GET /tools listing endpoint (default: true) */
  includeListing?: boolean;
}

// ── Schema conversion ─────────────────────────────────────────────────────────

/**
 * Convert an MCP input schema to an OpenAPI-compatible JSON Schema.
 * MCP input schemas are a subset of JSON Schema — pass-through is safe.
 */
export function mcpSchemaToOpenApi(schema: McpInputSchema): OpenApiSchema {
  const result: OpenApiSchema = {};

  if (schema.type !== undefined) result["type"] = schema.type as JsonSchemaType;
  if (schema.description !== undefined) result["description"] = schema.description;
  if (schema.required !== undefined) result["required"] = schema.required;

  if (schema.properties !== undefined) {
    result["properties"] = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [
        k,
        mcpSchemaToOpenApi(v as McpInputSchema),
      ]),
    );
  }

  // Forward any other JSON Schema keywords
  for (const [key, val] of Object.entries(schema)) {
    if (
      key !== "type" &&
      key !== "description" &&
      key !== "required" &&
      key !== "properties"
    ) {
      result[key] = val;
    }
  }

  return result;
}

// ── Tool name → path key ──────────────────────────────────────────────────────

export function toolNameToOperationId(name: string): string {
  // snake_case or kebab-case → camelCase
  return name.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ── Generate one tool's path ──────────────────────────────────────────────────

function generateToolPath(tool: McpToolDefinition, basePath: string): [string, OpenApiPathItem] {
  const pathKey = `${basePath}/${tool.name}`;

  const inputSchema = mcpSchemaToOpenApi(tool.inputSchema);

  const callOp: OpenApiOperation = {
    operationId: `call_${toolNameToOperationId(tool.name)}`,
    summary: `Call ${tool.name}`,
    description: tool.description,
    tags: ["tools"],
    requestBody: {
      required: true,
      description: `Arguments for ${tool.name}`,
      content: {
        "application/json": {
          schema: {
            ...inputSchema,
            type: "object",
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Tool call result",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                content: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["text", "image", "resource"] },
                      text: { type: "string" },
                      data: { type: "string" },
                      mimeType: { type: "string" },
                    },
                    required: ["type"],
                  },
                },
                isError: { type: "boolean" },
              },
              required: ["content"],
            },
          },
        },
      },
      "400": { description: "Invalid arguments" },
      "404": { description: "Tool not found" },
      "500": { description: "Tool execution error" },
    },
  };

  const describeOp: OpenApiOperation = {
    operationId: `describe_${toolNameToOperationId(tool.name)}`,
    summary: `Describe ${tool.name}`,
    description: `Get the schema for the ${tool.name} tool`,
    tags: ["tools"],
    responses: {
      "200": {
        description: "Tool definition",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                inputSchema: { type: "object" },
              },
              required: ["name", "inputSchema"],
            },
          },
        },
      },
      "404": { description: "Tool not found" },
    },
  };

  return [pathKey, { post: callOp, get: describeOp }];
}

// ── Generate listing path ─────────────────────────────────────────────────────

function generateListingPath(basePath: string): [string, OpenApiPathItem] {
  return [
    basePath,
    {
      get: {
        operationId: "list_tools",
        summary: "List all available MCP tools",
        tags: ["tools"],
        responses: {
          "200": {
            description: "Tool list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tools: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          description: { type: "string" },
                          inputSchema: { type: "object" },
                        },
                        required: ["name", "inputSchema"],
                      },
                    },
                  },
                  required: ["tools"],
                },
              },
            },
          },
        },
      },
    },
  ];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate a complete OpenAPI 3.1 spec from an array of MCP tool definitions.
 * Pure function — no I/O.
 */
export function generateOpenApiSpec(
  tools: McpToolDefinition[],
  opts: GenerateOpenApiOptions = {},
): OpenApiSpec {
  const basePath = opts.basePath ?? "/tools";
  const includeListing = opts.includeListing !== false;

  const paths: Record<string, OpenApiPathItem> = {};

  if (includeListing) {
    const [listPath, listItem] = generateListingPath(basePath);
    paths[listPath] = listItem;
  }

  for (const tool of tools) {
    const [pathKey, pathItem] = generateToolPath(tool, basePath);
    paths[pathKey] = pathItem;
  }

  const spec: OpenApiSpec = {
    openapi: "3.1.0",
    info: {
      title: opts.title ?? "Nexus MCP API",
      version: opts.version ?? "1.0.0",
      description: opts.description,
    },
    paths,
    tags: [{ name: "tools", description: "MCP tool operations" }],
  };

  if (opts.serverUrl) {
    spec.servers = [{ url: opts.serverUrl }];
  }

  return spec;
}

/**
 * Serialize the spec to a JSON string.
 */
export function serializeSpec(spec: OpenApiSpec, indent = 2): string {
  return JSON.stringify(spec, null, indent);
}
