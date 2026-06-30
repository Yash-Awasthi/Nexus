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
  ToolAgentRuntime,
  classifyTool,
  compactMessages,
  estimateMessageTokens,
  estimateContextTokens,
  IMAGE_TOKEN_COST,
  CACHE_POLICIES,
  type LlmToolFn,
  type RuntimeMessage,
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
    expect((calls[0]!.arguments as Record<string, unknown>).query).toBe("hello");
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
    parser.feed("[TOOL:x]{}[/TOOL]rest");
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
    expect((calls[0]!.arguments as Record<string, unknown>).raw).toBe("not-json");
  });
});

// ── StrReplaceProcessor ───────────────────────────────────────────────────────

describe("StrReplaceProcessor", () => {
  it("process replaces string in file", () => {
    const files = new Map([["src/a.ts", "const x = 1;"]]);
    const proc = new StrReplaceProcessor(files);
    const result = proc.process({
      path: "src/a.ts",
      oldStr: "const x = 1;",
      newStr: "const x = 42;",
    });
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
    const files = new Map([
      ["a.ts", "old_a"],
      ["b.ts", "old_b"],
    ]);
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
    const proc = new StrReplaceProcessor(
      new Map([
        ["a.ts", "a"],
        ["b.ts", "b"],
      ]),
    );
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
    ts.add({
      name: "bad",
      description: "Fails",
      handler: async () => {
        throw new Error("fail");
      },
    });
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
    for await (const _ of stream("sys", "my instruction")) {
      /* consume */
    }
    expect(mock.calls).toContain("my instruction");
  });
});

// ── AgentStepExecutor ─────────────────────────────────────────────────────────

describe("AgentStepExecutor", () => {
  it("execute returns step output with content", async () => {
    const mock = new MockLlmStream(["Hello from agent"]);
    const ts = new RuntimeToolSet();
    const executor = new AgentStepExecutor({
      llm: mock.asStream(),
      toolSet: ts,
      systemPrompt: "You are helpful.",
    });
    const step = await executor.execute({ stepIndex: 0, instruction: "Say hello" });
    expect(step.content).toContain("Hello from agent");
    expect(step.stepIndex).toBe(0);
    expect(step.stopped).toBe(false);
  });

  it("execute parses tool calls and invokes them", async () => {
    const toolResults: unknown[] = [];
    const ts = new RuntimeToolSet();
    ts.add({
      name: "echo",
      description: "echo",
      handler: async (args) => {
        toolResults.push(args);
        return "echoed";
      },
    });
    const mock = new MockLlmStream(['[TOOL:echo]{"msg":"hi"}[/TOOL] Done.']);
    const executor = new AgentStepExecutor({
      llm: mock.asStream(),
      toolSet: ts,
      systemPrompt: "sys",
    });
    const step = await executor.execute({ stepIndex: 0, instruction: "echo hi" });
    expect(step.toolCalls).toHaveLength(1);
    expect(step.toolResults[0]!.output).toBe("echoed");
  });

  it("execute includes previous tool results in prompt", async () => {
    const mock = new MockLlmStream(["response"]);
    const ts = new RuntimeToolSet();
    const executor = new AgentStepExecutor({
      llm: mock.asStream(),
      toolSet: ts,
      systemPrompt: "sys",
    });
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
    const mock = new MockLlmStream(["[TOOL:noop]{}[/TOOL] partial"]);
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
    ts.add({
      name: "act",
      description: "acts",
      handler: async (a) => {
        called.push(a);
        return "done";
      },
    });
    const mock = new MockLlmStream(['[TOOL:act]{"step":1}[/TOOL] finished']);
    const runtime = new AgentRuntime({ llm: mock.asStream(), toolSet: ts, maxSteps: 2 });
    await runtime.run("do it");
    expect(called.length).toBeGreaterThan(0);
  });
});

// ── classifyTool (permission tier) ──────────────────────────────────────────────

describe("classifyTool", () => {
  it("auto-allows read-only tool names (case-insensitive)", () => {
    for (const n of ["read_file", "grep", "LS", "list_files", "session_search"]) {
      expect(classifyTool(n)).toBe("auto_allowed");
    }
  });
  it("requires permission for mutating / unknown tools", () => {
    for (const n of ["write_file", "edit_file", "run_command", "mcp__do_thing"]) {
      expect(classifyTool(n)).toBe("requires_permission");
    }
  });
});

// ── ToolAgentRuntime permission gate ────────────────────────────────────────────

/** Build an LlmToolFn that calls `toolName` once, then returns plain text (done). */
function scriptedLlm(toolName: string, args: Record<string, unknown> = {}): LlmToolFn {
  let turn = 0;
  return (_messages: RuntimeMessage[]) => {
    turn += 1;
    if (turn === 1) {
      return Promise.resolve({
        content: "",
        toolCalls: [{ name: toolName, arguments: args, callId: "call_1" }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
    }
    return Promise.resolve({ content: "done", toolCalls: [] });
  };
}

describe("ToolAgentRuntime permission gate", () => {
  function toolSetWith(name: string, calls: string[]): RuntimeToolSet {
    return new RuntimeToolSet().add({
      name,
      description: name,
      handler: () => {
        calls.push(name);
        return Promise.resolve(`ran ${name}`);
      },
    });
  }

  it("denies a mutating tool when the gate refuses, feeding an error back (loop continues)", async () => {
    const calls: string[] = [];
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm("write_file", { path: "x" }),
      toolSet: toolSetWith("write_file", calls),
      maxSteps: 3,
      permissionGate: () => ({ allowed: false, reason: "test policy" }),
    });
    const result = await runtime.run("write something");
    expect(calls).toEqual([]); // handler never ran
    expect(result.aborted).toBe(false); // loop did not crash
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("permission_denied");
  });

  it("allows a mutating tool when the gate approves", async () => {
    const calls: string[] = [];
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm("write_file", { path: "x" }),
      toolSet: toolSetWith("write_file", calls),
      maxSteps: 3,
      permissionGate: () => ({ allowed: true }),
    });
    await runtime.run("write something");
    expect(calls).toEqual(["write_file"]);
  });

  it("never gates an auto-allowed tool (gate not consulted)", async () => {
    const calls: string[] = [];
    let gateCalls = 0;
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm("read_file", { path: "x" }),
      toolSet: toolSetWith("read_file", calls),
      maxSteps: 3,
      permissionGate: () => {
        gateCalls += 1;
        return { allowed: false };
      },
    });
    await runtime.run("read something");
    expect(calls).toEqual(["read_file"]); // ran despite a deny-all gate
    expect(gateCalls).toBe(0); // gate never consulted for auto-allowed
  });

  it("runs all tools when no gate is set (back-compatible)", async () => {
    const calls: string[] = [];
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm("run_command", { command: "ls" }),
      toolSet: toolSetWith("run_command", calls),
      maxSteps: 3,
    });
    await runtime.run("run it");
    expect(calls).toEqual(["run_command"]);
  });
});

// ── ToolAgentRuntime tool-output compression ─────────────────────────────────────

describe("ToolAgentRuntime tool-output compression", () => {
  // A tool whose output is ANSI-noisy with repeated lines — exactly what the
  // lossless preset folds away.
  const NOISY = "\x1b[31mERROR\x1b[0m: boom\nboom\nboom";
  function noisyToolSet(): RuntimeToolSet {
    return new RuntimeToolSet().add({
      name: "read_file",
      description: "read_file",
      handler: () => Promise.resolve(NOISY),
    });
  }

  it("compresses tool output losslessly by default (ANSI stripped, repeats folded)", async () => {
    const events: { savedTokens: number; applied: string[] }[] = [];
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm("read_file", { path: "x" }),
      toolSet: noisyToolSet(),
      maxSteps: 3,
      onToolCompress: (e) => events.push(e),
    });
    const result = await runtime.run("read it");
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).not.toContain("\x1b["); // ANSI gone
    expect(toolMsg?.content).toContain("ERROR: boom"); // signal preserved
    expect(toolMsg?.content).toContain("×2"); // repeat count preserved (lossless)
    expect(events[0]?.savedTokens).toBeGreaterThan(0);
    expect(events[0]?.applied).toContain("strip-ansi");
  });

  it("leaves tool output untouched when disabled", async () => {
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm("read_file", { path: "x" }),
      toolSet: noisyToolSet(),
      maxSteps: 3,
      compressToolOutput: false,
    });
    const result = await runtime.run("read it");
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe(NOISY); // verbatim
  });
});

// ── Context compaction ──────────────────────────────────────────────────────────

describe("token estimation", () => {
  it("estimates text tokens at ~chars/4", () => {
    expect(estimateMessageTokens({ role: "user", content: "a".repeat(40) })).toBe(10);
  });

  it("charges a flat cost per inline image, not raw base64 length", () => {
    const big = "data:image/png;base64," + "A".repeat(100_000);
    const est = estimateMessageTokens({ role: "user", content: big });
    // Flat image cost dominates; nowhere near 100k/4 = 25k tokens.
    expect(est).toBeGreaterThanOrEqual(IMAGE_TOKEN_COST);
    expect(est).toBeLessThan(IMAGE_TOKEN_COST + 30_000);
  });

  it("includes fixed system overhead in the context estimate", () => {
    const msgs: RuntimeMessage[] = [{ role: "user", content: "hi" }];
    expect(estimateContextTokens(msgs, 18_000)).toBeGreaterThanOrEqual(18_000);
  });
});

describe("compactMessages", () => {
  const summarize = (): Promise<string> => Promise.resolve("SUMMARY");

  it("is a no-op below the threshold", async () => {
    const msgs: RuntimeMessage[] = [
      { role: "user", content: "short" },
      { role: "assistant", content: "ok" },
    ];
    const r = await compactMessages(msgs, { summarize, tokenBudget: 1_000_000, systemOverhead: 0 });
    expect(r.compacted).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it("summarizes older turns and keeps the recent tail when over threshold", async () => {
    // 20 fat messages; tiny budget forces compaction.
    const msgs: RuntimeMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: "x".repeat(400),
    }));
    const r = await compactMessages(msgs, {
      summarize,
      tokenBudget: 1_000,
      threshold: 0.8,
      recentTurnsToKeep: 5,
      systemOverhead: 0,
    });
    expect(r.compacted).toBe(true);
    expect(r.summarizedCount).toBe(15);
    // 1 summary system message + 5 recent.
    expect(r.messages).toHaveLength(6);
    expect(r.messages[0]!.role).toBe("system");
    expect(r.messages[0]!.content).toContain("SUMMARY");
    expect(r.postTokens).toBeLessThan(r.preTokens);
  });

  it("preserves a leading system message above the summary", async () => {
    const msgs: RuntimeMessage[] = [
      { role: "system", content: "SYSTEM RULES" },
      ...Array.from({ length: 12 }, () => ({ role: "user" as const, content: "y".repeat(400) })),
    ];
    const r = await compactMessages(msgs, {
      summarize,
      tokenBudget: 1_000,
      recentTurnsToKeep: 3,
      systemOverhead: 0,
    });
    expect(r.compacted).toBe(true);
    expect(r.messages[0]!.content).toBe("SYSTEM RULES");
    expect(r.messages[1]!.content).toContain("SUMMARY");
  });

  it("does not summarize when nothing is older than the kept tail", async () => {
    const msgs: RuntimeMessage[] = Array.from({ length: 4 }, () => ({
      role: "user" as const,
      content: "z".repeat(4000),
    }));
    const r = await compactMessages(msgs, {
      summarize,
      tokenBudget: 100,
      recentTurnsToKeep: 10,
      systemOverhead: 0,
    });
    expect(r.compacted).toBe(false);
  });
});

describe("ToolAgentRuntime compaction", () => {
  it("is off by default — history is never compacted without opts.compaction", async () => {
    const llm: LlmToolFn = () => Promise.resolve({ content: "done", toolCalls: [] });
    const runtime = new ToolAgentRuntime({ llm, maxSteps: 1 });
    const result = await runtime.run("x".repeat(2_000_000));
    // The huge user message is still present (untouched).
    expect(result.messages[0]!.content.length).toBeGreaterThan(1_000_000);
  });
});

describe("ToolAgentRuntime resume", () => {
  it("seeds prior messages before the new instruction (resume)", async () => {
    let seen: RuntimeMessage[] = [];
    const llm: LlmToolFn = (messages) => {
      seen = messages;
      return Promise.resolve({ content: "ok", toolCalls: [] });
    };
    const prior: RuntimeMessage[] = [
      { role: "user", content: "first task" },
      { role: "assistant", content: "did the first task" },
    ];
    const runtime = new ToolAgentRuntime({ llm, maxSteps: 1, initialMessages: prior });
    const result = await runtime.run("follow-up task");
    expect(seen.slice(0, 2)).toEqual(prior);
    expect(seen[2]).toEqual({ role: "user", content: "follow-up task" });
    expect(result.messages[0]!.content).toBe("first task");
  });
});
