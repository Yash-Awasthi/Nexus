// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  McpServer,
  McpTool,
  McpResource,
  McpPrompt,
  McpError,
  type McpToolDefinition,
  type InputSchema,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeServer() {
  return new McpServer({ name: "nexus-mcp", version: "1.0.0", description: "Test" });
}

const echoSchema: InputSchema = {
  type: "object",
  properties: { message: { type: "string", description: "Text to echo" } },
  required: ["message"],
};

const echoDef: McpToolDefinition = {
  name: "echo",
  description: "Echo a message",
  inputSchema: echoSchema,
};

// ── McpServer — tools ─────────────────────────────────────────────────────────

describe("McpServer tools", () => {
  it("registers and lists a tool", () => {
    const server = makeServer();
    server.tool(echoDef, (args) => ({ type: "text", text: String(args["message"]) }));
    const tools = server.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("echo");
  });

  it("calls a tool and returns result", async () => {
    const server = makeServer();
    server.tool(echoDef, (args) => ({ type: "text", text: `echo: ${args["message"]}` }));
    const result = await server.callTool("echo", { message: "hello" });
    expect(result.type).toBe("text");
    expect((result as { type: "text"; text: string }).text).toBe("echo: hello");
  });

  it("throws TOOL_NOT_FOUND for unknown tool", async () => {
    const server = makeServer();
    await expect(server.callTool("unknown")).rejects.toThrow(McpError);
    await expect(server.callTool("unknown")).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
  });

  it("hasTool returns true/false", () => {
    const server = makeServer();
    server.tool(echoDef, () => ({ type: "text", text: "" }));
    expect(server.hasTool("echo")).toBe(true);
    expect(server.hasTool("ghost")).toBe(false);
  });

  it("supports async tool handlers", async () => {
    const server = makeServer();
    server.tool(echoDef, async (args) => {
      await Promise.resolve();
      return { type: "text", text: String(args["message"]) };
    });
    const r = await server.callTool("echo", { message: "async" });
    expect((r as { type: "text"; text: string }).text).toBe("async");
  });

  it("supports method chaining", () => {
    const server = makeServer();
    expect(server.tool(echoDef, () => ({ type: "text", text: "" }))).toBe(server);
  });
});

// ── McpServer — resources ─────────────────────────────────────────────────────

describe("McpServer resources", () => {
  const resDef = { uri: "file:///nexus/readme.md", name: "README", mimeType: "text/markdown" };

  it("registers and lists a resource", () => {
    const server = makeServer();
    server.resource(resDef, () => ({ content: "# Nexus" }));
    expect(server.listResources()).toHaveLength(1);
    expect(server.listResources()[0]!.name).toBe("README");
  });

  it("reads a resource", async () => {
    const server = makeServer();
    server.resource(resDef, () => ({ content: "# Nexus", mimeType: "text/markdown" }));
    const r = await server.readResource(resDef.uri);
    expect(r.content).toBe("# Nexus");
    expect(r.mimeType).toBe("text/markdown");
  });

  it("throws RESOURCE_NOT_FOUND for unknown uri", async () => {
    const server = makeServer();
    await expect(server.readResource("unknown://uri")).rejects.toThrow(McpError);
  });

  it("hasResource returns true/false", () => {
    const server = makeServer();
    server.resource(resDef, () => ({ content: "" }));
    expect(server.hasResource(resDef.uri)).toBe(true);
    expect(server.hasResource("ghost://uri")).toBe(false);
  });
});

// ── McpServer — prompts ───────────────────────────────────────────────────────

describe("McpServer prompts", () => {
  const promptDef = {
    name: "greeting",
    description: "A greeting prompt",
    arguments: [{ name: "name", required: true }],
  };

  it("registers and lists a prompt", () => {
    const server = makeServer();
    server.prompt(promptDef, (args) => `Hello, ${args["name"]}!`);
    expect(server.listPrompts()).toHaveLength(1);
    expect(server.listPrompts()[0]!.name).toBe("greeting");
  });

  it("renders a prompt with args", async () => {
    const server = makeServer();
    server.prompt(promptDef, (args) => `Hello, ${args["name"]}!`);
    const rendered = await server.renderPrompt("greeting", { name: "Alice" });
    expect(rendered).toBe("Hello, Alice!");
  });

  it("renders a prompt with no args", async () => {
    const server = makeServer();
    server.prompt({ name: "static" }, () => "Static prompt text");
    const rendered = await server.renderPrompt("static");
    expect(rendered).toBe("Static prompt text");
  });

  it("throws PROMPT_NOT_FOUND for unknown prompt", async () => {
    const server = makeServer();
    await expect(server.renderPrompt("ghost")).rejects.toThrow(McpError);
  });

  it("hasPrompt returns true/false", () => {
    const server = makeServer();
    server.prompt(promptDef, () => "hi");
    expect(server.hasPrompt("greeting")).toBe(true);
    expect(server.hasPrompt("ghost")).toBe(false);
  });
});

// ── McpTool standalone ────────────────────────────────────────────────────────

describe("McpTool", () => {
  it("calls handler with args", async () => {
    const tool = new McpTool(echoDef, (args) => ({ type: "text", text: String(args["message"]) }));
    const r = await tool.call({ message: "test" });
    expect((r as { type: "text"; text: string }).text).toBe("test");
  });
});

// ── McpResource standalone ────────────────────────────────────────────────────

describe("McpResource", () => {
  it("reads content", async () => {
    const res = new McpResource({ uri: "x://y", name: "y" }, () => ({ content: "content" }));
    const r = await res.read();
    expect(r.content).toBe("content");
  });
});

// ── McpPrompt standalone ──────────────────────────────────────────────────────

describe("McpPrompt", () => {
  it("renders with args", async () => {
    const p = new McpPrompt({ name: "greet" }, (args) => `Hi ${args["name"]}`);
    expect(await p.render({ name: "Bob" })).toBe("Hi Bob");
  });
});

// ── McpError ──────────────────────────────────────────────────────────────────

describe("McpError", () => {
  it("has correct code and message", () => {
    const e = new McpError("TOOL_NOT_FOUND", "Tool missing");
    expect(e.code).toBe("TOOL_NOT_FOUND");
    expect(e.message).toBe("Tool missing");
    expect(e.name).toBe("McpError");
  });
});

// ── McpServer info ────────────────────────────────────────────────────────────

describe("McpServer info", () => {
  it("exposes server info", () => {
    const server = makeServer();
    expect(server.info.name).toBe("nexus-mcp");
    expect(server.info.version).toBe("1.0.0");
  });
});
