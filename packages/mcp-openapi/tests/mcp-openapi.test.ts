// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  generateOpenApiSpec,
  mcpSchemaToOpenApi,
  toolNameToOperationId,
  serializeSpec,
  type OpenApiSpec,
  type McpToolDefinition,
} from "../src/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const READ_FILE_TOOL: McpToolDefinition = {
  name: "read_file",
  description: "Read a file from disk",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
      encoding: { type: "string", description: "File encoding" },
    },
    required: ["path"],
  },
};

const SEARCH_TOOL: McpToolDefinition = {
  name: "search_documents",
  description: "Search through indexed documents",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["query"],
  },
};

const NO_SCHEMA_TOOL: McpToolDefinition = {
  name: "ping",
  description: "Ping the server",
  inputSchema: { type: "object", properties: {} },
};

// ── toolNameToOperationId ─────────────────────────────────────────────────────

describe("toolNameToOperationId", () => {
  it("converts snake_case to camelCase", () => {
    expect(toolNameToOperationId("read_file")).toBe("readFile");
  });

  it("converts multi-segment snake_case", () => {
    expect(toolNameToOperationId("search_documents")).toBe("searchDocuments");
  });

  it("handles single word", () => {
    expect(toolNameToOperationId("ping")).toBe("ping");
  });

  it("handles kebab-case", () => {
    expect(toolNameToOperationId("get-status")).toBe("getStatus");
  });
});

// ── mcpSchemaToOpenApi ────────────────────────────────────────────────────────

describe("mcpSchemaToOpenApi", () => {
  it("converts a simple object schema", () => {
    const schema = mcpSchemaToOpenApi({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(schema.type).toBe("object");
    expect(schema.properties?.["name"]).toBeDefined();
    expect(schema.required).toContain("name");
  });

  it("handles nested object properties", () => {
    const schema = mcpSchemaToOpenApi({
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: { verbose: { type: "boolean" } },
        },
      },
    });
    expect(schema.properties?.["options"]).toBeDefined();
  });

  it("handles array type", () => {
    const schema = mcpSchemaToOpenApi({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.type).toBe("array");
    expect((schema.items as { type: string }).type).toBe("string");
  });

  it("handles empty schema gracefully", () => {
    const schema = mcpSchemaToOpenApi({ type: "object", properties: {} });
    expect(schema.type).toBe("object");
  });

  it("forwards unknown JSON Schema keywords", () => {
    const schema = mcpSchemaToOpenApi({
      type: "string",
      format: "email",
      minLength: 1,
    });
    expect(schema["format"]).toBe("email");
    expect(schema["minLength"]).toBe(1);
  });
});

// ── generateOpenApiSpec ───────────────────────────────────────────────────────

describe("generateOpenApiSpec", () => {
  it("returns a valid OpenAPI 3.1 spec object", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL], { title: "Test API", version: "1.0.0" });
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(spec.info.title).toBe("Test API");
    expect(spec.info.version).toBe("1.0.0");
  });

  it("generates a POST endpoint for each tool", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL, SEARCH_TOOL], { title: "T", version: "0" });
    expect(spec.paths["/tools/read_file"]).toBeDefined();
    expect(spec.paths["/tools/read_file"]?.post).toBeDefined();
    expect(spec.paths["/tools/search_documents"]).toBeDefined();
    expect(spec.paths["/tools/search_documents"]?.post).toBeDefined();
  });

  it("generates a GET endpoint for each tool description", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL], { title: "T", version: "0" });
    expect(spec.paths["/tools/read_file"]?.get).toBeDefined();
  });

  it("generates a GET /tools listing endpoint", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL], { title: "T", version: "0" });
    expect(spec.paths["/tools"]).toBeDefined();
    expect(spec.paths["/tools"]?.get).toBeDefined();
  });

  it("POST operationId is call_<camelCase> (e.g. call_readFile)", () => {
    // The implementation prefixes with "call_": operationId = `call_${toolNameToOperationId(name)}`
    const spec = generateOpenApiSpec([READ_FILE_TOOL], { title: "T", version: "0" });
    const post = spec.paths["/tools/read_file"]?.post;
    expect(post?.operationId).toBe("call_readFile");
  });

  it("GET describe operationId is describe_<camelCase>", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL], { title: "T", version: "0" });
    const get = spec.paths["/tools/read_file"]?.get;
    expect(get?.operationId).toBe("describe_readFile");
  });

  it("includes tool description in operation summary or description", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL], { title: "T", version: "0" });
    const post = spec.paths["/tools/read_file"]?.post;
    const text = (post?.summary ?? "") + (post?.description ?? "");
    expect(text).toContain("Read a file");
  });

  it("handles zero tools without crashing", () => {
    const spec = generateOpenApiSpec([], { title: "Empty", version: "0" });
    expect(spec.paths).toBeDefined();
    // /tools listing should still exist
    expect(spec.paths["/tools"]).toBeDefined();
  });

  it("handles tool with no required fields", () => {
    const spec = generateOpenApiSpec([NO_SCHEMA_TOOL], { title: "T", version: "0" });
    expect(spec.paths["/tools/ping"]).toBeDefined();
  });

  it("is a pure function — multiple calls with same input produce same output", () => {
    const tools = [READ_FILE_TOOL];
    const opts = { title: "T", version: "1" };
    const a = generateOpenApiSpec(tools, opts);
    const b = generateOpenApiSpec(tools, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("includes serverUrl in servers array when provided", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL], {
      title: "T",
      version: "0",
      serverUrl: "https://api.example.com",
    });
    expect(spec.servers?.[0]?.url).toBe("https://api.example.com");
  });

  it("respects custom basePath", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL], {
      title: "T",
      version: "0",
      basePath: "/mcp",
    });
    expect(spec.paths["/mcp/read_file"]).toBeDefined();
  });

  it("can disable the listing endpoint", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL], {
      title: "T",
      version: "0",
      includeListing: false,
    });
    expect(spec.paths["/tools"]).toBeUndefined();
  });
});

// ── serializeSpec ─────────────────────────────────────────────────────────────

describe("serializeSpec", () => {
  it("returns a valid JSON string", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL], { title: "T", version: "0" });
    const json = serializeSpec(spec);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("serialized spec round-trips correctly", () => {
    const spec = generateOpenApiSpec([SEARCH_TOOL], { title: "T", version: "0" });
    const parsed = JSON.parse(serializeSpec(spec)) as OpenApiSpec;
    expect(parsed.openapi).toBe(spec.openapi);
    expect(parsed.info.title).toBe(spec.info.title);
  });

  it("accepts indent parameter (number)", () => {
    const spec = generateOpenApiSpec([READ_FILE_TOOL], { title: "T", version: "0" });
    // serializeSpec(spec, indent?: number) — second arg is indent, not format
    expect(() => serializeSpec(spec, 4)).not.toThrow();
    const json = serializeSpec(spec, 4);
    expect(JSON.parse(json)).toBeDefined();
  });
});
