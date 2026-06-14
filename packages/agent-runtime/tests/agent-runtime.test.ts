// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  ToolStreamParser,
  StrReplaceProcessor,
  CacheControl,
  RuntimeToolSet,
  MockLlmStream,
  AgentStepExecutor,
  AgentRuntime,
  CACHE_POLICIES,
  type ToolCallRaw,
  type StepInput,
} from "../src/index.js";

// ── CacheControl ──────────────────────────────────────────────────────────────

describe("CacheControl", () => {
  it("headerFor returns correct policy headers", () => {
    expect(CacheControl.headerFor("no-cache").policy).toBe("no-cache");
    expect(CacheControl.headerFor("ephemeral").maxAgeMs).toBe(60_000);
    expect(CacheControl.headerFor("persistent").maxAgeMs).toBe(3_600_000);
  });

  it("shouldBypassCache is true only for no-cache", () => {
    expect(CacheControl.shouldBypassCache("no-cache")).toBe(true);
    expect(CacheControl.shouldBypassCache("ephemeral")).toBe(false);
    expect(CacheControl.shouldBypassCache("persistent")).toBe(false);
  });

  it("maxAgeMs returns 0 for no-cache", () => {
    expect(CacheControl.maxAgeMs("no-cache")).toBe(0);
    expect(CacheControl.maxAgeMs("ephemeral")).toBe(60_000);
  });

  it("CACHE_POLICIES has all 3 entries", () => {
    expect(Object.keys(CACHE_POLICIES)).toHaveLength(3);
  });
});

// ── ToolStreamParser ──────────────────────────────────────────────────────────

describe("ToolStreamParser", () => {
  it("feed parses single tool call", () => {
    const parser = new ToolStreamParser();
    const calls = parser.feed('[TOOL:search]{"query":"hello"}[/TOOL]');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("search");
    expect((calls[0]!.arguments as any).query).toBe("hello");
  });

  it("feed parses multiple tool calls", () => {
    const parser = new ToolStreamParser();
    const calls = parser.feed('[TOOL:a]{"x":1}[/TOOL] text [TOOL:b]{"y":2}[/TOOL]');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("feed handles partial chunks across multiple calls", () => {
    const parser = new ToolStreamParser();
    parser.feed('[TOOL:calc]{"op":"');
    const calls = parser.feed('add"}[/TOOL]');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("calc");
  });

  it("flush extracts remaining parsed calls", () => {
    const parser = new ToolStreamParser();
    parser.feed('[TOOL:x]{}[/TOOL]rest');
    const calls = parser.flush();
    // already consumed, so flush returns empty
    expect(calls).toHaveLength(0);
  });

  it("stripTools removes tool blocks from text", () => {
    const text = "Start [TOOL:x]{}[/TOOL] middle [TOOL:y]{}[/TOOL] end";
    expect(ToolStreamParser.stripTools(text)).toBe("Start  middle  end");
  });

  it("reset clears buffer", () => {
    const parser = new ToolStreamParser();
    parser.feed("partial [TOOL:");
    parser.reset();
    expect(parser.getBuffer()).toBe("");
  });

  it("invalid JSON arguments produce raw fallback", () => {
    const parser = new ToolStreamParser();
    const calls = parser.feed("[TOOL:x]not-json[/TOOL]");
    expect(calls).toHaveLength(1);
    expect((calls[0]!.arguments as any).raw).toBe("not-json");
  });
});

// ── StrReplaceProcessor ───────────────────────────────────────────────────────

describe("StrReplaceProcessor", () => {
  it("process replaces string in file", () => {
    const files = new Map([["src/a.ts", "const x = 1;"]]);
    const proc = new StrReplaceProcessor(files);
    const result = proc.process({ path: "src/a.ts", oldStr: "const x = 1;", newStr: "const x = 42;" });
    expect(result.success).toBe(true);
    expect(result.replaced).toBe(true);
    expect(proc.getFile("src/a.ts")).toContain("const x = 42;");
  });

  it("process returns error for missing file", () => {
    const proc = new StrReplaceProcessor();
    const result = proc.process({ path: "missing.ts", oldStr: "x", newStr: "y" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("File not found");
  });

  it("process returns error when string not found", () => {
    const proc = new StrReplaceProcessor(new Map([["f.ts", "hello"]]));
    const result = proc.process({ path: "f.ts", oldStr: "MISSING", newStr: "NEW" });
    expect(result.success).toBe(false);
    expect(result.replaced).toBe(false);
  });

  it("processAll runs all replacements", () => {
    const files = new Map([["a.ts", "old_a"], ["b.ts", "old_b"]]);
    const proc = new StrReplaceProcessor(files);
    const results = proc.processAll([
      { path: "a.ts", oldStr: "old_a", newStr: "new_a" },
      { path: "b.ts", oldStr: "old_b", newStr: "new_b" },
    ]);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("setFile and getFile work", () => {
    const proc = new StrReplaceProcessor();
    proc.setFile("f.ts", "content");
    expect(proc.getFile("f.ts")).toBe("content");
  });

  it("snapshot returns all files", () => {
    const proc = new StrReplaceProcessor(new Map([["a.ts", "a"], ["b.ts", "b"]]));
    const snap = proc.snapshot();
    expect(snap["a.ts"]).toBe("a");
    expect(snap["b.ts"]).toBe("b");
  });
});

// ── RuntimeToolSet ────────────────────────────────────────────────────────────

describe("RuntimeToolSet", () => {
  it("add and get works", () => {
    const ts = new RuntimeToolSet();
    ts.add({ name: "search", description: "Search docs", handler: async () => ["result"] });
    expect(ts.has("search")).toBe(true);
    expect(ts.get("search")?.name).toBe("search");
  });

  it("invoke calls handler", async () => {
    const ts = new RuntimeToolSet();
    ts.add({ name: "echo", description: "Echoes input", handler: async (args) => args.text });
    const result = await ts.invoke("echo", { text: "hello" });
    expect(result.output).toBe("hello");
    expect(result.error).toBeUndefined();
  });

  it("invoke returns error for unknown tool", async () => {
    const ts = new RuntimeToolSet();
    const result = await ts.invoke("unknown", {});
    expect(result.error).toContain("Tool not found");
  });

  it("invoke captures handler errors", async () => {
    const ts = new RuntimeToolSet();
    ts.add({ name: "bad", description: "Fails", handler: async () => { throw new Error("fail"); } });
    const result = await ts.invoke("bad", {});
    expect(result.error).toBe("fail");
  });

  it("names returns all tool names", () => {
    const ts = new RuntimeToolSet();
    ts.add({ name: "a", description: "", handler: async () => {} });
    ts.add({ name: "b", description: "", handler: async () => {} });
    expect(ts.names()).toContain("a");
    expect(ts.names()).toContain("b");
  });

  it("toLlmDescription returns formatted string", () => {
    const ts = new RuntimeToolSet();
    ts.add({ name: "search", description: "Search the web", handler: async () => {} });
    const desc = ts.toLlmDescription();
    expect(desc).toContain("search");
    expect(desc).toContain("Search the web");
  });

  it("add supports chaining", () => {
    const ts = new RuntimeToolSet();
    const result = ts.add({ name: "a", description: "", handler: async () => {} });
    expect(result).toBe(ts);
  });
});

// ── MockLlmStream ─────────────────────────────────────────────────────────────

describe("MockLlmStream", () => {
  it("streams configured chunks", async () => {
    const mock = new MockLlmStream(["chunk1", " chunk2", " chunk3"]);
    const stream = mock.asStream();
    let output = "";
    for await (const chunk of stream("sys", "user")) {
      output += chunk;
    }
    expect(output).toBe("chunk1 chunk2 chunk3");
  });

  it("records user prompts", async () => {
    const mock = new MockLlmStream(["ok"]);
    const stream = mock.asStream();
    for await (const _ of stream("sys", "my instruction")) { /* consume */ }
    expect(mock.calls).toContain("my instruction");
  });
});

// ── AgentStepExecutor ─────────────────────────────────────────────────────────

describe("AgentStepExecutor", () => {
  it("execute returns step output with content", async () => {
    const mock = new MockLlmStream(["Hello from agent"]);
    const ts = new RuntimeToolSet();
    const executor = new AgentStepExecutor({ llm: mock.asStream(), toolSet: ts, systemPrompt: "You are helpful." });
    const step = await executor.execute({ stepIndex: 0, instruction: "Say hello" });
    expect(step.content).toContain("Hello from agent");
    expect(step.stepIndex).toBe(0);
    expect(step.stopped).toBe(false);
  });

  it("execute parses tool calls and invokes them", async () => {
    const toolResults: unknown[] = [];
    const ts = new RuntimeToolSet();
    ts.add({ name: "echo", description: "echo", handler: async (args) => { toolResults.push(args); return "echoed"; } });
    const mock = new MockLlmStream(['[TOOL:echo]{"msg":"hi"}[/TOOL] Done.']);
    const executor = new AgentStepExecutor({ llm: mock.asStream(), toolSet: ts, systemPrompt: "sys" });
    const step = await executor.execute({ stepIndex: 0, instruction: "echo hi" });
    expect(step.toolCalls).toHaveLength(1);
    expect(step.toolResults[0]!.output).toBe("echoed");
  });

  it("execute includes previous tool results in prompt", async () => {
    const mock = new MockLlmStream(["response"]);
    const ts = new RuntimeToolSet();
    const executor = new AgentStepExecutor({ llm: mock.asStream(), toolSet: ts, systemPrompt: "sys" });
    const prevResults = [{ name: "search", output: "results", callId: "1" }];
    await executor.execute({ stepIndex: 1, instruction: "continue", toolResults: prevResults });
    expect(mock.calls[0]).toContain("continue");
    expect(mock.calls[0]).toContain("results");
  });
});

// ── AgentRuntime ──────────────────────────────────────────────────────────────

describe("AgentRuntime", () => {
  it("run executes single step when no tool calls", async () => {
    const mock = new MockLlmStream(["Task complete."]);
    const runtime = new AgentRuntime({ llm: mock.asStream() });
    const result = await runtime.run("Do something");
    expect(result.steps).toHaveLength(1);
    expect(result.finalContent).toBe("Task complete.");
    expect(result.aborted).toBe(false);
  });

  it("run terminates at maxSteps", async () => {
    // Each step returns a tool call, which triggers another step
    const mock = new MockLlmStream(['[TOOL:noop]{}[/TOOL] partial']);
    const ts = new RuntimeToolSet();
    ts.add({ name: "noop", description: "noop", handler: async () => null });
    const runtime = new AgentRuntime({ llm: mock.asStream(), toolSet: ts, maxSteps: 3 });
    const result = await runtime.run("Run forever");
    expect(result.steps.length).toBeLessThanOrEqual(3);
  });

  it("run returns aborted=true when signal fires", async () => {
    const controller = new AbortController();
    const mock = new MockLlmStream(["chunk"]);
    const runtime = new AgentRuntime({ llm: mock.asStream() });
    controller.abort();
    const result = await runtime.run("task", controller.signal);
    expect(result.aborted).toBe(true);
  });

  it("getExecutor returns AgentStepExecutor", () => {
    const mock = new MockLlmStream(["ok"]);
    const runtime = new AgentRuntime({ llm: mock.asStream() });
    expect(runtime.getExecutor()).toBeDefined();
  });

  it("run with tool set invokes tools", async () => {
    const ts = new RuntimeToolSet();
    const called: unknown[] = [];
    ts.add({ name: "act", description: "acts", handler: async (a) => { called.push(a); return "done"; } });
    const mock = new MockLlmStream(['[TOOL:act]{"step":1}[/TOOL] finished']);
    const runtime = new AgentRuntime({ llm: mock.asStream(), toolSet: ts, maxSteps: 2 });
    const result = await runtime.run("do it");
    expect(called.length).toBeGreaterThan(0);
  });
});
