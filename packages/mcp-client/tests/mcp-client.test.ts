// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  McpClient,
  McpHttpTransport,
  McpClientError,
  type McpToolDefinition,
  type McpResourceEntry,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────
// McpHttpTransport.send(method, params) → calls fetchFn(url, { method: "POST", body: jsonRpc })
// Response must be { jsonrpc, id, result } or { jsonrpc, id, error }

function makeRpcResponse(result: unknown) {
  // id doesn't need to match — implementation doesn't validate it
  return { jsonrpc: "2.0", id: "any", result };
}

function makeRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", id: "any", error: { code, message } };
}

function mockFetch(responseBody: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => responseBody,
  }) as unknown as typeof fetch;
}

// McpClient uses { serverUrl } config; McpHttpTransport uses { url }
const SERVER_URL = "http://localhost:3000/rpc";

const INIT_RESULT = {
  serverInfo: { name: "test-server", version: "1.0.0" },
  capabilities: { tools: {}, resources: {} },
  protocolVersion: "2024-11-05",
};

const TOOLS_RESULT: McpToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file from disk",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write a file to disk",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
];

// ── McpHttpTransport ──────────────────────────────────────────────────────────

describe("McpHttpTransport", () => {
  it("sends a POST request to the configured URL", async () => {
    const fetchFn = mockFetch(makeRpcResponse({ ok: true }));
    // constructor: { url, fetchFn }
    const transport = new McpHttpTransport({ url: SERVER_URL, fetchFn });

    await transport.send("initialize", {});

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SERVER_URL);
    expect(init.method).toBe("POST");
  });

  it("encodes method and params in JSON-RPC 2.0 body", async () => {
    let capturedBody: unknown;
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return { ok: true, json: async () => makeRpcResponse({}) };
    }) as unknown as typeof fetch;

    const transport = new McpHttpTransport({ url: SERVER_URL, fetchFn });
    await transport.send("tools/list", { cursor: null });

    const body = capturedBody as { jsonrpc: string; method: string; params: unknown };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/list");
  });

  it("throws McpClientError on non-ok HTTP response", async () => {
    const fetchFn = mockFetch({}, false);
    const transport = new McpHttpTransport({ url: SERVER_URL, fetchFn });

    await expect(transport.send("ping", {})).rejects.toThrow(McpClientError);
  });

  it("throws McpClientError when response contains JSON-RPC error", async () => {
    const fetchFn = mockFetch(makeRpcError(-32601, "Method not found"));
    const transport = new McpHttpTransport({ url: SERVER_URL, fetchFn });

    await expect(transport.send("unknown", {})).rejects.toThrow(McpClientError);
  });
});

// ── McpClient.initialize ──────────────────────────────────────────────────────

describe("McpClient.initialize", () => {
  it("returns McpServerInfo on success", async () => {
    // initialize() calls send("initialize") + send("notifications/initialized") → 2 fetches
    const fetchFn = mockFetch(makeRpcResponse(INIT_RESULT));
    const client = new McpClient({ serverUrl: SERVER_URL, fetchFn });

    const info = await client.initialize();
    expect(info.name).toBe("test-server");
    expect(info.version).toBe("1.0.0");
    expect(info.protocolVersion).toBe("2024-11-05");
  });

  it("is idempotent — second call does not re-fetch", async () => {
    const fetchFn = mockFetch(makeRpcResponse(INIT_RESULT));
    const client = new McpClient({ serverUrl: SERVER_URL, fetchFn });

    await client.initialize();
    const countAfterFirst = (fetchFn.mock.calls as unknown[]).length;
    await client.initialize(); // should be cached
    const countAfterSecond = (fetchFn.mock.calls as unknown[]).length;

    expect(countAfterSecond).toBe(countAfterFirst); // no new calls
  });

  it("exposes server info via .serverInfo getter after init", async () => {
    const fetchFn = mockFetch(makeRpcResponse(INIT_RESULT));
    const client = new McpClient({ serverUrl: SERVER_URL, fetchFn });

    expect(client.serverInfo).toBeUndefined();
    await client.initialize();
    expect(client.serverInfo?.name).toBe("test-server");
  });
});

// ── McpClient.listTools ───────────────────────────────────────────────────────

describe("McpClient.listTools", () => {
  // listTools() calls transport.send("tools/list") directly — no auto-init
  function makeClient() {
    const fetchFn = mockFetch(makeRpcResponse({ tools: TOOLS_RESULT }));
    return new McpClient({ serverUrl: SERVER_URL, fetchFn });
  }

  it("returns list of tool definitions", async () => {
    const client = makeClient();
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("read_file");
    expect(tools[1]?.name).toBe("write_file");
  });

  it("each tool has name, description, inputSchema", async () => {
    const client = makeClient();
    const tools = await client.listTools();
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeDefined();
    }
  });
});

// ── McpClient.callTool ────────────────────────────────────────────────────────

describe("McpClient.callTool", () => {
  // callTool returns { content, isError, text }
  // RPC result shape that the server would return: { content: [...], isError: false }
  const CALL_RPC_RESULT = {
    content: [{ type: "text", text: "file contents here" }],
    isError: false,
  };

  it("returns tool call result with content array", async () => {
    const fetchFn = mockFetch(makeRpcResponse(CALL_RPC_RESULT));
    const client = new McpClient({ serverUrl: SERVER_URL, fetchFn });
    const result = await client.callTool("read_file", { path: "/tmp/test.txt" });
    expect(result.content[0]?.text).toBe("file contents here");
    expect(result.isError).toBe(false);
  });

  it("populates convenience .text field", async () => {
    const fetchFn = mockFetch(makeRpcResponse(CALL_RPC_RESULT));
    const client = new McpClient({ serverUrl: SERVER_URL, fetchFn });
    const result = await client.callTool("read_file", { path: "/tmp/test.txt" });
    expect(result.text).toBe("file contents here");
  });

  it("passes tool name and arguments in params", async () => {
    let capturedBody: unknown;
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return { ok: true, json: async () => makeRpcResponse(CALL_RPC_RESULT) };
    }) as unknown as typeof fetch;

    const client = new McpClient({ serverUrl: SERVER_URL, fetchFn });
    await client.callTool("read_file", { path: "/etc/hosts" });

    const body = capturedBody as { method: string; params: { name: string; arguments: Record<string, unknown> } };
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("read_file");
    expect(body.params.arguments.path).toBe("/etc/hosts");
  });
});

// ── McpClient.listResources ───────────────────────────────────────────────────

describe("McpClient.listResources", () => {
  const RESOURCES: McpResourceEntry[] = [
    { uri: "file:///docs/readme.md", name: "readme", mimeType: "text/markdown" },
    { uri: "file:///docs/api.md", name: "api-docs", mimeType: "text/markdown" },
  ];

  it("returns list of resource entries", async () => {
    const fetchFn = mockFetch(makeRpcResponse({ resources: RESOURCES }));
    const client = new McpClient({ serverUrl: SERVER_URL, fetchFn });
    const resources = await client.listResources();
    expect(resources).toHaveLength(2);
    expect(resources[0]?.uri).toBe("file:///docs/readme.md");
  });

  it("each resource has a uri", async () => {
    const fetchFn = mockFetch(makeRpcResponse({ resources: RESOURCES }));
    const client = new McpClient({ serverUrl: SERVER_URL, fetchFn });
    const resources = await client.listResources();
    for (const r of resources) {
      expect(r.uri).toBeTruthy();
    }
  });
});

// ── McpClient.readResource ────────────────────────────────────────────────────

describe("McpClient.readResource", () => {
  it("returns resource content with text", async () => {
    const fetchFn = mockFetch(
      makeRpcResponse({ contents: [{ uri: "file:///docs/readme.md", text: "# Hello" }] }),
    );
    const client = new McpClient({ serverUrl: SERVER_URL, fetchFn });
    // readResource returns McpResourceContent { uri, mimeType, text }
    const content = await client.readResource("file:///docs/readme.md");
    expect(content.text).toBe("# Hello");
    expect(content.uri).toBe("file:///docs/readme.md");
  });
});

// ── McpClientError ────────────────────────────────────────────────────────────

describe("McpClientError", () => {
  it("is an instance of Error", () => {
    // constructor: McpClientError(message, code, context?)
    const err = new McpClientError("test error", "TEST_ERR");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("test error");
    expect(err.code).toBe("TEST_ERR");
  });

  it("name is McpClientError", () => {
    const err = new McpClientError("oops", "OOPS");
    expect(err.name).toBe("McpClientError");
  });

  it("propagates on network failure", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const client = new McpClient({ serverUrl: SERVER_URL, fetchFn });
    await expect(client.initialize()).rejects.toThrow();
  });
});
