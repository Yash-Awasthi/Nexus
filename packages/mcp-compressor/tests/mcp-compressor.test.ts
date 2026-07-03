// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  compressManifest,
  CompressedToolProxy,
  DEFAULT_GATEWAY_NAMES,
  type CompressorBackend,
  type ToolManifestEntry,
  type ToolCallResult,
} from "../src/index.js";

// A backend manifest with verbose schemas — the case the compressor targets.
function bigManifest(count: number): ToolManifestEntry[] {
  const tools: ToolManifestEntry[] = [];
  for (let i = 0; i < count; i++) {
    tools.push({
      name: `tool_${i}`,
      description: `Tool number ${i}. It does an elaborate thing with many options and a long, detailed explanation that costs tokens.`,
      inputSchema: {
        type: "object",
        properties: {
          alpha: { type: "string", description: "first argument with a wordy description" },
          beta: { type: "number", description: "second argument with a wordy description" },
          gamma: { type: "boolean", description: "third argument with a wordy description" },
        },
        required: ["alpha"],
      },
    });
  }
  return tools;
}

function fakeBackend(tools: ToolManifestEntry[]): CompressorBackend & {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: `ran ${name}` }], isError: false, text: `ran ${name}` };
    }),
  };
}

// ── compressManifest ──────────────────────────────────────────────────────────

describe("compressManifest", () => {
  it("emits exactly the three gateway tools", () => {
    const { gatewayTools } = compressManifest(bigManifest(20));
    expect(gatewayTools.map((t) => t.name)).toEqual([
      DEFAULT_GATEWAY_NAMES.listTools,
      DEFAULT_GATEWAY_NAMES.getToolSchema,
      DEFAULT_GATEWAY_NAMES.invokeTool,
    ]);
  });

  it("shrinks a large manifest by well over 60%", () => {
    const { stats } = compressManifest(bigManifest(40));
    expect(stats.backendTools).toBe(40);
    expect(stats.ratio).toBeGreaterThan(0.6);
    expect(stats.compressedChars).toBeLessThan(stats.fullChars);
    expect(stats.approxCompressedTokens).toBeLessThan(stats.approxFullTokens);
  });

  it("builds a catalog with a trimmed one-line summary per tool", () => {
    const { catalog } = compressManifest(bigManifest(3), { summaryMaxChars: 40 });
    expect(catalog).toHaveLength(3);
    for (const c of catalog) {
      expect(c.name).toMatch(/^tool_\d$/);
      expect(c.summary.length).toBeLessThanOrEqual(40);
    }
  });

  it("handles an empty manifest with ratio 0", () => {
    const { stats, catalog } = compressManifest([]);
    expect(catalog).toEqual([]);
    expect(stats.ratio).toBe(0);
    expect(stats.backendTools).toBe(0);
  });

  it("honours custom gateway names", () => {
    const { gatewayTools } = compressManifest(bigManifest(2), {
      names: { invokeTool: "run" },
    });
    expect(gatewayTools.map((t) => t.name)).toContain("run");
  });
});

// ── CompressedToolProxy ───────────────────────────────────────────────────────

describe("CompressedToolProxy", () => {
  it("listTools returns the compact gateway, not the backend manifest", async () => {
    const proxy = new CompressedToolProxy(fakeBackend(bigManifest(50)));
    const tools = await proxy.listTools();
    expect(tools).toHaveLength(3);
    expect(tools[0]?.name).toBe(DEFAULT_GATEWAY_NAMES.listTools);
  });

  it("init snapshots the backend manifest exactly once", async () => {
    const backend = fakeBackend(bigManifest(5));
    const proxy = new CompressedToolProxy(backend);
    await proxy.init();
    await proxy.listTools();
    await proxy.callTool("list_tools");
    expect(backend.listTools as unknown as { mock: { calls: unknown[] } }).toBeTruthy();
    expect((backend.listTools as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(
      1,
    );
  });

  it("list_tools returns the JSON catalog", async () => {
    const proxy = new CompressedToolProxy(fakeBackend(bigManifest(3)));
    const res = await proxy.callTool("list_tools");
    const rows = JSON.parse(res.text) as Array<{ name: string; summary: string }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.name).toBe("tool_0");
  });

  it("list_tools honours a case-insensitive filter", async () => {
    const tools = [
      { name: "search_web", description: "Search the web", inputSchema: { type: "object" as const } },
      { name: "read_file", description: "Read a file", inputSchema: { type: "object" as const } },
    ];
    const proxy = new CompressedToolProxy(fakeBackend(tools));
    const res = await proxy.callTool("list_tools", { filter: "WEB" });
    const rows = JSON.parse(res.text) as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("search_web");
  });

  it("get_tool_schema returns the full schema for one tool", async () => {
    const proxy = new CompressedToolProxy(fakeBackend(bigManifest(4)));
    const res = await proxy.callTool("get_tool_schema", { name: "tool_2" });
    const schema = JSON.parse(res.text) as { name: string; inputSchema: { properties: unknown } };
    expect(schema.name).toBe("tool_2");
    expect(schema.inputSchema.properties).toBeDefined();
  });

  it("get_tool_schema returns an error result for an unknown tool", async () => {
    const proxy = new CompressedToolProxy(fakeBackend(bigManifest(2)));
    const res = await proxy.callTool("get_tool_schema", { name: "nope" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("unknown tool");
  });

  it("invoke_tool forwards to the backend with the un-nested arguments", async () => {
    const backend = fakeBackend(bigManifest(3));
    const proxy = new CompressedToolProxy(backend);
    const res = await proxy.callTool("invoke_tool", {
      name: "tool_1",
      arguments: { alpha: "x" },
    });
    expect(res.text).toBe("ran tool_1");
    expect(backend.calls).toEqual([{ name: "tool_1", args: { alpha: "x" } }]);
  });

  it("invoke_tool rejects an unknown backend tool without calling the backend", async () => {
    const backend = fakeBackend(bigManifest(2));
    const proxy = new CompressedToolProxy(backend);
    const res = await proxy.callTool("invoke_tool", { name: "ghost" });
    expect(res.isError).toBe(true);
    expect(backend.calls).toHaveLength(0);
  });

  it("passes an unknown (non-gateway) tool name straight through to the backend", async () => {
    const backend = fakeBackend(bigManifest(3));
    const proxy = new CompressedToolProxy(backend);
    const res = await proxy.callTool("tool_0", { alpha: "y" });
    expect(res.text).toBe("ran tool_0");
    expect(backend.calls).toEqual([{ name: "tool_0", args: { alpha: "y" } }]);
  });

  it("exposes savings stats after init", async () => {
    const proxy = new CompressedToolProxy(fakeBackend(bigManifest(30)));
    const stats = await proxy.init();
    expect(stats.ratio).toBeGreaterThan(0.6);
    expect(proxy.stats?.backendTools).toBe(30);
  });
});
