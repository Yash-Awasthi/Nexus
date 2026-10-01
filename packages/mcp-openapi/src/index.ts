// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAPI → MCP: every operation in an OpenAPI 3 spec becomes an MCP tool whose input schema is
 * its parameters (plus `body` for a JSON request body), with an executor that makes the call.
 * Pair it with McpHttpServer to serve any REST API to agents as MCP tools.
 */
import type { McpCallResult, McpToolDefinition } from "@nexus/mcp-client";

interface Parameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
}

export interface OpenApiSpec {
  servers?: { url: string }[];
  paths?: Record<string, Record<string, Operation | Parameter[] | unknown>>;
}

export interface OpenApiToMcpOptions {
  /** Overrides the spec's first server URL. */
  baseUrl?: string;
  /** Sent with every call, e.g. an authorization header. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

interface Route {
  method: string;
  path: string;
  params: Parameter[];
  hasBody: boolean;
}

/** Tools for every operation in `spec`, and the executor that calls them. */
export function openApiToMcp(spec: OpenApiSpec, opts: OpenApiToMcpOptions = {}) {
  const baseUrl = (opts.baseUrl ?? spec.servers?.[0]?.url ?? "").replace(/\/+$/, "");
  const routes = new Map<string, Route>();
  const tools: McpToolDefinition[] = [];

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const shared = (item["parameters"] as Parameter[] | undefined) ?? [];
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (!op) continue;
      const name =
        op.operationId ??
        `${method}_${path
          .replace(/[{}]/g, "")
          .replace(/[^A-Za-z0-9]+/g, "_")
          .replace(/^_|_$/g, "")}`;
      const params = [...shared, ...(op.parameters ?? [])].filter(
        (p) => p.in === "path" || p.in === "query",
      );
      const json = op.requestBody?.content?.["application/json"];
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of params) {
        properties[p.name] = {
          ...(p.schema ?? { type: "string" }),
          ...(p.description ? { description: p.description } : {}),
        };
        if (p.required || p.in === "path") required.push(p.name);
      }
      if (json) {
        properties["body"] = json.schema ?? { type: "object" };
        if (op.requestBody?.required !== false) required.push("body");
      }
      tools.push({
        name,
        description: op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`,
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
      });
      routes.set(name, { method: method.toUpperCase(), path, params, hasBody: !!json });
    }
  }

  async function execute(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const route = routes.get(name);
    if (!route) throw new Error(`Unknown tool: ${name}`);
    let path = route.path;
    const query = new URLSearchParams();
    for (const p of route.params) {
      const value = args[p.name];
      if (value === undefined) continue;
      if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
      else query.set(p.name, String(value));
    }
    const qs = query.toString();
    const res = await (opts.fetch ?? fetch)(`${baseUrl}${path}${qs ? `?${qs}` : ""}`, {
      method: route.method,
      headers: {
        ...(route.hasBody ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      ...(route.hasBody && args["body"] !== undefined
        ? { body: JSON.stringify(args["body"]) }
        : {}),
    });
    const text = await res.text();
    return { content: [{ type: "text", text }], text, ...(res.ok ? {} : { isError: true }) };
  }

  return { tools, execute };
}
