// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  ThinkScaffold,
  WriteFileTool,
  StrReplaceTool,
  InMemoryFileSystem,
  EditorToolExecutor,
  MockModelBackend,
  CodeEditorAgent,
  type EditorModel,
  type EditorToolCall,
} from "../src/index.js";

// ── ThinkScaffold ─────────────────────────────────────────────────────────────

describe("ThinkScaffold", () => {
  it("isReasoningModel returns true for deepseek and kimi", () => {
    expect(ThinkScaffold.isReasoningModel("deepseek-coder")).toBe(true);
    expect(ThinkScaffold.isReasoningModel("kimi-k2")).toBe(true);
    expect(ThinkScaffold.isReasoningModel("gpt-5")).toBe(false);
    expect(ThinkScaffold.isReasoningModel("claude-opus-4")).toBe(false);
  });

  it("wrapPrompt adds think tags for reasoning models", () => {
    const wrapped = ThinkScaffold.wrapPrompt("Edit the file", "deepseek-coder");
    expect(wrapped).toContain("<think>");
    expect(wrapped).toContain("</think>");
    expect(wrapped).toContain("Edit the file");
  });

  it("wrapPrompt does not wrap non-reasoning models", () => {
    const wrapped = ThinkScaffold.wrapPrompt("Edit the file", "gpt-5");
    expect(wrapped).toBe("Edit the file");
  });

  it("extractThinking parses think block", () => {
    const text = "<think>\nAnalyze carefully\n</think>\n\nChange line 5.";
    const { thinking, rest } = ThinkScaffold.extractThinking(text);
    expect(thinking).toBe("Analyze carefully");
    expect(rest).toBe("Change line 5.");
  });

  it("extractThinking returns undefined when no think block", () => {
    const { thinking, rest } = ThinkScaffold.extractThinking("Just plain text.");
    expect(thinking).toBeUndefined();
    expect(rest).toBe("Just plain text.");
  });
});

// ── InMemoryFileSystem ────────────────────────────────────────────────────────

describe("InMemoryFileSystem", () => {
  it("write and read roundtrips", async () => {
    const fs = new InMemoryFileSystem();
    await fs.write("/src/app.ts", "const x = 1;");
    expect(await fs.read("/src/app.ts")).toBe("const x = 1;");
  });

  it("exists returns true/false", async () => {
    const fs = new InMemoryFileSystem();
    expect(await fs.exists("/f.ts")).toBe(false);
    await fs.write("/f.ts", "");
    expect(await fs.exists("/f.ts")).toBe(true);
  });

  it("read throws for missing file", async () => {
    const fs = new InMemoryFileSystem();
    await expect(fs.read("/missing.ts")).rejects.toThrow("File not found");
  });

  it("snapshot returns all files", async () => {
    const fs = new InMemoryFileSystem();
    await fs.write("/a.ts", "a");
    await fs.write("/b.ts", "b");
    const snap = fs.snapshot();
    expect(snap["/a.ts"]).toBe("a");
    expect(snap["/b.ts"]).toBe("b");
  });
});

// ── WriteFileTool ─────────────────────────────────────────────────────────────

describe("WriteFileTool", () => {
  it("writes file successfully", async () => {
    const fs = new InMemoryFileSystem();
    const tool = new WriteFileTool(fs);
    const result = await tool.execute({ path: "/new.ts", content: "export {};" });
    expect(result.success).toBe(true);
    expect(result.path).toBe("/new.ts");
    expect(await fs.read("/new.ts")).toBe("export {};");
  });
});

// ── StrReplaceTool ────────────────────────────────────────────────────────────

describe("StrReplaceTool", () => {
  it("replaces string in file", async () => {
    const fs = new InMemoryFileSystem();
    await fs.write("/f.ts", "const x = 1;\nconst y = 2;");
    const tool = new StrReplaceTool(fs);
    const result = await tool.execute({
      path: "/f.ts",
      oldStr: "const x = 1;",
      newStr: "const x = 42;",
    });
    expect(result.success).toBe(true);
    expect(result.replaced).toBe(true);
    expect(await fs.read("/f.ts")).toContain("const x = 42;");
  });

  it("returns error when string not found", async () => {
    const fs = new InMemoryFileSystem();
    await fs.write("/f.ts", "const x = 1;");
    const tool = new StrReplaceTool(fs);
    const result = await tool.execute({ path: "/f.ts", oldStr: "MISSING", newStr: "NEW" });
    expect(result.success).toBe(false);
    expect(result.replaced).toBe(false);
  });

  it("returns error for missing file", async () => {
    const fs = new InMemoryFileSystem();
    const tool = new StrReplaceTool(fs);
    const result = await tool.execute({ path: "/missing.ts", oldStr: "x", newStr: "y" });
    expect(result.success).toBe(false);
  });
});

// ── EditorToolExecutor ────────────────────────────────────────────────────────

describe("EditorToolExecutor", () => {
  it("executes write_file call", async () => {
    const fs = new InMemoryFileSystem();
    const executor = new EditorToolExecutor(fs);
    const call: EditorToolCall = {
      tool: "write_file",
      params: { path: "/out.ts", content: "hello" },
    };
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.tool).toBe("write_file");
  });

  it("executes str_replace call", async () => {
    const fs = new InMemoryFileSystem();
    await fs.write("/f.ts", "old content");
    const executor = new EditorToolExecutor(fs);
    const call: EditorToolCall = {
      tool: "str_replace",
      params: { path: "/f.ts", oldStr: "old", newStr: "new" },
    };
    const result = await executor.execute(call);
    expect(result.success).toBe(true);
    expect(result.tool).toBe("str_replace");
  });

  it("executeAll runs all calls in sequence", async () => {
    const fs = new InMemoryFileSystem();
    const executor = new EditorToolExecutor(fs);
    const calls: EditorToolCall[] = [
      { tool: "write_file", params: { path: "/a.ts", content: "a" } },
      { tool: "write_file", params: { path: "/b.ts", content: "b" } },
    ];
    const results = await executor.executeAll(calls);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
  });
});

// ── MockModelBackend ──────────────────────────────────────────────────────────

describe("MockModelBackend", () => {
  it("records calls", async () => {
    const mock = new MockModelBackend({ text: "done", tokensUsed: 5 });
    const backend = mock.asBackend();
    await backend("claude-opus-4", "sys", "edit this file");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.model).toBe("claude-opus-4");
  });

  it("returns configured response", async () => {
    const mock = new MockModelBackend({ text: "custom response", tokensUsed: 42 });
    const backend = mock.asBackend();
    const response = await backend("gpt-5", "sys", "user");
    expect(response.text).toBe("custom response");
    expect(response.tokensUsed).toBe(42);
  });
});

// ── CodeEditorAgent ───────────────────────────────────────────────────────────

describe("CodeEditorAgent", () => {
  it("edit returns structured output", async () => {
    const mock = new MockModelBackend({ text: "No changes needed.", tokensUsed: 10 });
    const agent = new CodeEditorAgent({ backend: mock.asBackend() });
    const result = await agent.edit({ instruction: "Review this code." });
    expect(result.output.model).toBe("claude-opus-4");
    expect(result.output.explanation).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("parses WRITE_FILE tool calls from response", async () => {
    const mock = new MockModelBackend({
      text: "[WRITE_FILE /src/new.ts]\nexport const x = 1;\n[/WRITE_FILE]\nCreated new file.",
    });
    const fs = new InMemoryFileSystem();
    const agent = new CodeEditorAgent({ backend: mock.asBackend(), fs });
    const result = await agent.edit({ instruction: "Create file" });
    expect(result.output.toolCalls).toHaveLength(1);
    expect(result.output.toolCalls[0]!.tool).toBe("write_file");
    expect(result.toolResults[0]!.success).toBe(true);
    expect(await fs.read("/src/new.ts")).toBe("export const x = 1;");
  });

  it("parses STR_REPLACE tool calls from response", async () => {
    const fs = new InMemoryFileSystem();
    await fs.write("/src/app.ts", "const x = 1;");
    const mock = new MockModelBackend({
      text: "[STR_REPLACE /src/app.ts]const x = 1;[SEP]const x = 42;[/STR_REPLACE]Changed x.",
    });
    const agent = new CodeEditorAgent({ backend: mock.asBackend(), fs });
    const result = await agent.edit({ instruction: "Change x" });
    expect(result.output.toolCalls).toHaveLength(1);
    expect(result.output.toolCalls[0]!.tool).toBe("str_replace");
    expect(await fs.read("/src/app.ts")).toContain("const x = 42;");
  });

  it("extracts thinking from reasoning model response", async () => {
    const mock = new MockModelBackend({
      text: "<think>\nAnalyze carefully\n</think>\n\nEdited successfully.",
    });
    const agent = new CodeEditorAgent({ model: "deepseek-coder", backend: mock.asBackend() });
    const result = await agent.edit({ instruction: "Fix bug" });
    expect(result.output.thinking).toBe("Analyze carefully");
  });

  it("uses configured model", () => {
    const mock = new MockModelBackend();
    const agent = new CodeEditorAgent({ model: "gpt-5", backend: mock.asBackend() });
    expect(agent.getModel()).toBe("gpt-5");
  });

  it("spawnerPrompt returns string", () => {
    expect(CodeEditorAgent.spawnerPrompt().length).toBeGreaterThan(0);
  });

  it("filePaths and context are included in prompt", async () => {
    const mock = new MockModelBackend({ text: "ok" });
    const agent = new CodeEditorAgent({ backend: mock.asBackend() });
    await agent.edit({
      instruction: "Refactor",
      filePaths: ["src/a.ts", "src/b.ts"],
      context: "legacy code",
    });
    expect(mock.calls[0]!.prompt).toContain("src/a.ts");
    expect(mock.calls[0]!.prompt).toContain("legacy code");
  });
});
