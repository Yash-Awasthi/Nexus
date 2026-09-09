// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAPI → MCP tools (the reverse of generateOpenApiSpec).
 *
 * Ported from the OpenAPI→MCP generator lineage (openapi-mcp-generator,
 * openapi-mcp-codegen, openapi-to-mcpserver): every OpenAPI operation becomes
 * an MCP tool whose arguments are the operation's parameters plus a `body`
 * property for the request body. Executing the tool performs the underlying
 * REST call — so an agent (or an MCP server wrapping this) can drive any
 * OpenAPI service without hand-written glue.
 *
 * Conventions (mirroring the upstream generators):
 *   • tool name  = operationId (dots → underscores), else `${method}_${path}`,
 *     sanitized to [A-Za-z0-9_-] and capped at maxToolNameLength (default 64,
 *     the Claude Desktop limit) with a deterministic `head__tail_hash` elision.
 *   • description = operation.description || summary || `Executes METHOD path`.
 *   • input schema = merged path/query/header parameters (path-level params
 *     first, operation params win by name+location) + requestBody under `body`.
 *   • $ref schemas are resolved one level against components.schemas.
 *
 * Dependency-free: no external imports; a tiny FNV-1a hash keeps name
 * shortening deterministic and isomorphic (no node:crypto).
 */

import type { McpInputSchema } from "./index.js";

// ── Minimal OpenAPI 3.x surface ───────────────────────────────────────────────

export const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type ParameterLocation = "path" | "query" | "header";

export interface OpenApiParameter {
  name: string;
  in: ParameterLocation;
  required?: boolean;
  schema?: unknown;
  description?: string;
}

export interface OpenApiRequestBodyDoc {
  required?: boolean;
  content?: Record<string, { schema?: unknown }>;
}

export interface OpenApiOperationDoc {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  tags?: string[];
  security?: unknown[] | null;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBodyDoc;
}

/** A path item: HTTP methods plus optional path-level parameters. */
export interface OpenApiPathItemDoc {
  parameters?: OpenApiParameter[];
  get?: OpenApiOperationDoc;
  put?: OpenApiOperationDoc;
  post?: OpenApiOperationDoc;
  delete?: OpenApiOperationDoc;
  patch?: OpenApiOperationDoc;
  head?: OpenApiOperationDoc;
  options?: OpenApiOperationDoc;
}

export interface OpenApiDoc {
  openapi?: string;
  servers?: { url: string }[];
  paths: Record<string, OpenApiPathItemDoc>;
  components?: { schemas?: Record<string, unknown> };
}

// ── Result types ──────────────────────────────────────────────────────────────

/** A generated MCP tool plus the execution metadata the REST caller needs. */
export interface McpOpenApiTool {
  name: string;
  description?: string;
  inputSchema: McpInputSchema;
  /** Original operationId (unsanitized) — stable for exclude filters. */
  operationId: string;
  method: HttpMethod;
  /** OpenAPI path template, e.g. "/pets/{petId}". */
  path: string;
  /** Media type of the request body (e.g. "application/json"), if any. */
  bodyContentType?: string;
  /** Parameter locations, for building the HTTP request at call time. */
  parameters: { name: string; in: ParameterLocation }[];
}

export interface OpenApiToMcpOptions {
  /** Maximum generated tool-name length (default 64). */
  maxToolNameLength?: number;
}

// ── FNV-1a (32-bit) — deterministic, isomorphic name hashing ──────────────────

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

// ── Tool-name shortening (upstream's head__tail_hash backstop) ────────────────

function shortenToolName(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const ELISION_MARKER = "__";
  const hashSuffix = `_${fnv1a(name)}`;
  // Budget reserves room for both the marker and the hash suffix.
  const nameBudget = maxLength - hashSuffix.length - ELISION_MARKER.length;
  if (nameBudget < 4) return `${name.slice(0, Math.max(1, nameBudget))}${hashSuffix}`;
  const headLength = Math.ceil(nameBudget * 0.6);
  const tailLength = nameBudget - headLength;
  const head = name.slice(0, headLength);
  const tail = tailLength > 0 ? name.slice(name.length - tailLength) : "";
  return `${head}${ELISION_MARKER}${tail}${hashSuffix}`;
}

function sanitizeToolName(raw: string): string {
  return raw.replace(/\./g, "_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function fallbackToolName(method: HttpMethod, path: string): string {
  const segments = path
    .replace(/[{}]/g, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9/_-]/g, "_")
    .replace(/\//g, "_");
  return `${method}_${segments}`;
}

// ── $ref resolution (one level into components.schemas) ───────────────────────

function resolveSchema(schema: unknown, doc: OpenApiDoc): unknown {
  if (typeof schema === "object" && schema !== null) {
    const ref = (schema as { $ref?: unknown }).$ref;
    if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
      const name = ref.slice("#/components/schemas/".length);
      const target = doc.components?.schemas?.[name];
      if (target !== undefined) return target;
    }
  }
  return schema;
}

// ── Parameter → JSON-schema property ──────────────────────────────────────────

function parameterProperty(param: OpenApiParameter): unknown {
  // Prefer the declared schema; fall back to a plain string (the common case
  // for unnamed scalar parameters). OpenAPI 2-style parameters that carry
  // type/format directly on the parameter are accepted via `schema` aliasing.
  const schema = param.schema ?? { type: "string" };
  const prop = typeof schema === "object" && schema !== null ? { ...(schema as object) } : {};
  if (param.description !== undefined) {
    (prop as Record<string, unknown>)["description"] = param.description;
  }
  return prop;
}

// ── Core: spec → tools ────────────────────────────────────────────────────────

export function openApiToMcpTools(
  spec: OpenApiDoc,
  opts: OpenApiToMcpOptions = {},
): McpOpenApiTool[] {
  const maxToolNameLength = Math.max(8, opts.maxToolNameLength ?? 64);
  const tools: McpOpenApiTool[] = [];
  const usedNames = new Set<string>();

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!item) continue;
    const pathParams: OpenApiParameter[] = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;

      const rawOperationId = op.operationId || fallbackToolName(method, path);
      const sanitized = sanitizeToolName(rawOperationId);
      let name = shortenToolName(sanitized, maxToolNameLength);
      let attempt = 0;
      while (usedNames.has(name)) {
        const suffix = `_${fnv1a(`${sanitized}#${attempt++}`)}`;
        const headRoom = Math.max(1, maxToolNameLength - suffix.length);
        name = `${name.slice(0, headRoom)}${suffix}`;
      }
      usedNames.add(name);

      const description =
        op.description || op.summary || `Executes ${method.toUpperCase()} ${path}`;

      // Merge path-level + operation parameters (operation wins by name+location).
      const merged = new Map<string, OpenApiParameter>();
      for (const p of pathParams) merged.set(`${p.in}:${p.name}`, p);
      for (const p of op.parameters ?? []) merged.set(`${p.in}:${p.name}`, p);

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const paramMeta: { name: string; in: ParameterLocation }[] = [];

      for (const p of merged.values()) {
        properties[p.name] = parameterProperty(p);
        paramMeta.push({ name: p.name, in: p.in });
        if (p.required === true || p.in === "path") required.push(p.name);
      }

      let bodyContentType: string | undefined;
      if (op.requestBody) {
        const content = op.requestBody.content ?? {};
        const jsonKey = Object.keys(content).find((k) => k.includes("json"));
        const mediaKey = jsonKey ?? Object.keys(content)[0];
        if (mediaKey !== undefined) {
          bodyContentType = mediaKey;
          const rawSchema = content[mediaKey]?.schema;
          properties["requestBody"] = {
            ...((resolveSchema(rawSchema, spec) as object) ?? {}),
            description: "Request body",
          };
          if (op.requestBody.required === true) required.push("requestBody");
        }
      }

      // Preserve description override if the operation never declared one.
      const inputSchema: McpInputSchema = { type: "object", properties };
      if (required.length > 0) inputSchema.required = [...new Set(required)];

      tools.push({
        name,
        description,
        inputSchema,
        operationId: rawOperationId,
        method,
        path,
        bodyContentType,
        parameters: paramMeta,
      });
    }
  }

  return tools;
}

// ── Executor: tool call → REST request ────────────────────────────────────────

export interface OpenApiCallResponse {
  status: number;
  ok: boolean;
  text: string;
}

export interface OpenApiCallInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Minimal injectable fetch surface (mirrors globalThis.fetch). */
export type OpenApiFetchFn = (
  url: string,
  init: OpenApiCallInit,
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface OpenApiCallerOptions {
  /** Base URL; overrides spec `servers[0]`. */
  baseUrl?: string;
  /** Injectable fetch (defaults to globalThis.fetch). */
  fetch?: OpenApiFetchFn;
  /** Extra headers sent on every call (e.g. Authorization). */
  headers?: Record<string, string>;
}

const RESERVED_HEADERS = new Set([
  "content-type",
  "content-length",
  "host",
  "connection",
  "accept-encoding",
  "transfer-encoding",
]);

/**
 * Build a caller that executes a generated tool against its REST backend.
 * Returns an async (toolName, args) => response function.
 */
export function createOpenApiCaller(
  tools: McpOpenApiTool[],
  opts: OpenApiCallerOptions = {},
): (name: string, args: Record<string, unknown>) => Promise<OpenApiCallResponse> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
  const doFetch: OpenApiFetchFn = opts.fetch ?? (globalThis as { fetch?: OpenApiFetchFn }).fetch!;

  return async (name, args) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`No tool named "${name}"`);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };

    let url = `${baseUrl}${tool.path}`;
    for (const param of tool.parameters) {
      const value = args[param.name];
      if (param.in === "path") {
        if (value === undefined) {
          throw new Error(`Missing required path parameter "${param.name}" for ${name}`);
        }
        url = url.replace(`{${param.name}}`, encodeURIComponent(String(value)));
      } else if (param.in === "header" && value !== undefined) {
        if (!RESERVED_HEADERS.has(param.name.toLowerCase())) {
          headers[param.name] = String(value);
        }
      }
    }

    const query = tool.parameters
      .filter((p) => p.in === "query" && args[p.name] !== undefined)
      .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(String(args[p.name]))}`);
    if (query.length > 0) url += `?${query.join("&")}`;

    const init: OpenApiCallInit = { method: tool.method.toUpperCase(), headers };
    const body = args["requestBody"];
    if (tool.bodyContentType && body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      headers["content-type"] = tool.bodyContentType;
    }

    const res = await doFetch(url, init);
    return { status: res.status, ok: res.ok, text: await res.text() };
  };
}
