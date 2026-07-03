// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ToolRegistry,
  createWebSearchTool,
  createGithubReadFileTool,
  createPapersTool,
  createDatasetTool,
  createSandboxTool,
  createPlanTool,
  createNotifyTool,
  createDefaultRegistry,
  type ToolDefinition,
  type WebSearchInput,
  type WebSearchOutput,
  type NotifyInput,
  type NotifyOutput,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTool<TI, TO>(name: string, handler: (i: TI) => Promise<TO>): ToolDefinition<TI, TO> {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: { x: { type: "string" } } },
    handler,
  };
}

// ── ToolRegistry ──────────────────────────────────────────────────────────────

describe("ToolRegistry – registration", () => {
  it("register adds a tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("echo", async (i) => i));
    expect(registry.has("echo")).toBe(true);
  });

  it("register throws on duplicate name", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("echo", async (i) => i));
    expect(() => registry.register(makeTool("echo", async (i) => i))).toThrow("already registered");
  });

  it("upsert overwrites existing tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("echo", async () => "v1"));
    registry.upsert(makeTool("echo", async () => "v2"));
    const tool = registry.get("echo")!;
    expect(tool).toBeDefined();
  });

  it("register supports chaining", () => {
    const registry = new ToolRegistry();
    const result = registry
      .register(makeTool("a", async (i) => i))
      .register(makeTool("b", async (i) => i));
    expect(result).toBe(registry);
    expect(registry.size()).toBe(2);
  });

  it("unregister removes a tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("echo", async (i) => i));
    expect(registry.unregister("echo")).toBe(true);
    expect(registry.has("echo")).toBe(false);
  });

  it("unregister returns false for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.unregister("ghost")).toBe(false);
  });

  it("clear removes all tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("a", async (i) => i));
    registry.register(makeTool("b", async (i) => i));
    registry.clear();
    expect(registry.size()).toBe(0);
  });

  it("list returns all registered tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("a", async (i) => i));
    registry.register(makeTool("b", async (i) => i));
    expect(registry.list()).toHaveLength(2);
  });

  it("names returns tool names", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("x", async (i) => i));
    registry.register(makeTool("y", async (i) => i));
    expect(registry.names()).toContain("x");
    expect(registry.names()).toContain("y");
  });
});

describe("ToolRegistry – invoke", () => {
  it("invoke calls handler and returns success result", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool<{ v: number }, number>("double", async (i) => i.v * 2));
    const result = await registry.invoke<number>("double", { v: 5 });
    expect(result.success).toBe(true);
    expect(result.output).toBe(10);
    expect(result.tool).toBe("double");
    expect(typeof result.durationMs).toBe("number");
  });

  it("invoke returns error result for unknown tool", async () => {
    const registry = new ToolRegistry();
    const result = await registry.invoke("ghost", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("invoke captures handler exception as error", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool("fail", async () => {
        throw new Error("boom");
      }),
    );
    const result = await registry.invoke("fail", {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
  });

  it("invoke passes ctx to handler", async () => {
    const registry = new ToolRegistry();
    let capturedCtx: unknown;
    registry.register(
      makeTool("ctx_tool", async (_, ctx) => {
        capturedCtx = ctx;
        return null;
      }),
    );
    await registry.invoke("ctx_tool", {}, { sessionId: "s1" });
    expect((capturedCtx as any).sessionId).toBe("s1");
  });

  it("invokeAll runs multiple tools in parallel", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool<number, number>("add1", async (i) => i + 1));
    registry.register(makeTool<number, number>("mul2", async (i) => i * 2));
    const results = await registry.invokeAll([
      { name: "add1", input: 9 },
      { name: "mul2", input: 5 },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.output).toBe(10);
    expect(results[1]!.output).toBe(10);
  });
});

describe("ToolRegistry – toLlmTools", () => {
  it("returns array with name, description, parameters", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("echo", async (i) => i));
    const llmTools = registry.toLlmTools();
    expect(llmTools).toHaveLength(1);
    expect(llmTools[0]!.name).toBe("echo");
    expect(llmTools[0]!.description).toBeDefined();
    expect(llmTools[0]!.parameters).toBeDefined();
  });
});

// ── Built-in tool factories ───────────────────────────────────────────────────

describe("createWebSearchTool", () => {
  it("creates a tool with correct name and schema", () => {
    const tool = createWebSearchTool();
    expect(tool.name).toBe("web_search");
    expect(tool.inputSchema.required).toContain("query");
  });

  it("handler calls injected function", async () => {
    const mockHandler = vi.fn(
      async (_: WebSearchInput): Promise<WebSearchOutput> => ({
        results: [{ title: "R", url: "https://x.com", snippet: "s" }],
        query: "test",
      }),
    );
    const tool = createWebSearchTool(mockHandler);
    const result = await tool.handler({ query: "test" });
    expect(mockHandler).toHaveBeenCalledWith({ query: "test" });
    expect(result.results).toHaveLength(1);
  });

  it("throws when no handler injected", () => {
    const tool = createWebSearchTool();
    expect(() => tool.handler({ query: "x" })).toThrow("no handler injected");
  });
});

describe("createGithubReadFileTool", () => {
  it("has correct name and required fields", () => {
    const tool = createGithubReadFileTool();
    expect(tool.name).toBe("github_read_file");
    expect(tool.inputSchema.required).toContain("owner");
    expect(tool.inputSchema.required).toContain("repo");
    expect(tool.inputSchema.required).toContain("path");
  });
});

describe("createPapersTool", () => {
  it("has correct name and required query field", () => {
    const tool = createPapersTool();
    expect(tool.name).toBe("papers");
    expect(tool.inputSchema.required).toContain("query");
  });
});

describe("createDatasetTool", () => {
  it("has correct name and required name field", () => {
    const tool = createDatasetTool();
    expect(tool.name).toBe("dataset");
    expect(tool.inputSchema.required).toContain("name");
  });
});

describe("createSandboxTool", () => {
  it("has correct name and required fields", () => {
    const tool = createSandboxTool();
    expect(tool.name).toBe("sandbox");
    expect(tool.inputSchema.required).toContain("language");
    expect(tool.inputSchema.required).toContain("code");
  });

  it("language enum includes python/r/julia", () => {
    const tool = createSandboxTool();
    const languageProp = tool.inputSchema.properties?.["language"];
    expect(languageProp?.enum).toContain("python");
    expect(languageProp?.enum).toContain("r");
    expect(languageProp?.enum).toContain("julia");
  });
});

describe("createPlanTool", () => {
  it("has goal as required field", () => {
    const tool = createPlanTool();
    expect(tool.name).toBe("plan");
    expect(tool.inputSchema.required).toContain("goal");
  });
});

describe("createNotifyTool", () => {
  it("has correct name and required fields", () => {
    const tool = createNotifyTool();
    expect(tool.name).toBe("notify");
    expect(tool.inputSchema.required).toContain("channel");
    expect(tool.inputSchema.required).toContain("subject");
    expect(tool.inputSchema.required).toContain("body");
  });

  it("handler calls injected notify function", async () => {
    const mockNotify = vi.fn(
      async (i: NotifyInput): Promise<NotifyOutput> => ({
        sent: true,
        channel: i.channel,
        messageId: "msg-1",
      }),
    );
    const tool = createNotifyTool(mockNotify);
    const result = await tool.handler({ channel: "log", subject: "Test", body: "Hello" });
    expect(result.sent).toBe(true);
    expect(result.channel).toBe("log");
  });
});

// ── createDefaultRegistry ─────────────────────────────────────────────────────

describe("createDefaultRegistry", () => {
  it("registers all 7 built-in tools", () => {
    const registry = createDefaultRegistry();
    expect(registry.size()).toBe(7);
    expect(registry.names()).toContain("web_search");
    expect(registry.names()).toContain("github_read_file");
    expect(registry.names()).toContain("papers");
    expect(registry.names()).toContain("dataset");
    expect(registry.names()).toContain("sandbox");
    expect(registry.names()).toContain("plan");
    expect(registry.names()).toContain("notify");
  });

  it("injects handlers via createDefaultRegistry", async () => {
    const mockSearch = vi.fn(
      async (_: WebSearchInput): Promise<WebSearchOutput> => ({
        results: [],
        query: "q",
      }),
    );
    const registry = createDefaultRegistry({ web_search: mockSearch });
    await registry.invoke("web_search", { query: "hello" });
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it("toLlmTools returns all 7 tool descriptors", () => {
    const registry = createDefaultRegistry();
    const tools = registry.toLlmTools();
    expect(tools).toHaveLength(7);
    tools.forEach((t) => {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.parameters.type).toBe("object");
    });
  });
});
