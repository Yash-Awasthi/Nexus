// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { ILanguageModel, ChatMessage } from "../src/interfaces/language-model.interface.js";
import type { IExecutionContext } from "../src/interfaces/execution.interface.js";
import { CodeAgentPool } from "../src/code-agent-pool.js";

// ─── Mock node:https (ResearcherAgent → WebSearchEngine → Tavily) ────────────

const mockState = vi.hoisted(() => ({ body: "{}" }));

vi.mock("https", () => {
  function makeEmitter(): {
    on: (ev: string, h: (d?: unknown) => void) => unknown;
    emit: (ev: string, d?: unknown) => boolean;
  } {
    const handlers: Record<string, Array<(d?: unknown) => void>> = {};
    return {
      on(ev: string, h: (d?: unknown) => void) {
        (handlers[ev] ??= []).push(h);
        return this;
      },
      emit(ev: string, d?: unknown) {
        (handlers[ev] ?? []).forEach((h) => h(d));
        return true;
      },
    };
  }
  return {
    request: (_opts: unknown, cb?: (res: unknown) => void) => {
      const res = makeEmitter() as unknown as {
        on: (e: string, h: (d?: unknown) => void) => unknown;
        emit: (e: string, d?: unknown) => boolean;
      };
      if (cb) cb(res);
      const req = makeEmitter() as unknown as Record<string, unknown>;
      (req as { write: () => void }).write = () => {};
      (req as { end: () => void }).end = () => {
        setImmediate(() => {
          res.emit("data", Buffer.from(mockState.body));
          res.emit("end");
        });
      };
      return req;
    },
  };
});

// ─── Fake LLM + context ──────────────────────────────────────────────────────

function makeLLM(opts: {
  objects?: Array<() => Promise<unknown>>;
  texts?: Array<() => Promise<string>>;
}): ILanguageModel {
  const objects = [...(opts.objects ?? [])];
  const texts = [...(opts.texts ?? [])];
  return {
    modelId: "test:stub",
    async generateObject(): Promise<unknown> {
      const impl = objects.shift();
      if (!impl) throw new Error("generateObject: no stub queued");
      return impl();
    },
    async generateText(): Promise<string> {
      const impl = texts.shift();
      if (!impl) return "text answer";
      return impl();
    },
    async *streamText() {
      // unused
    },
  };
}

const context: IExecutionContext = {
  taskId: "t-1",
  startTime: new Date(),
  attempt: 1,
  environment: {},
  logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
};

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pool-"));
  process.env.TAVILY_API_KEY = "";
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.TAVILY_API_KEY;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CodeAgentPool dispatch", () => {
  it("accepts the generic 'code' type and all agent task types", () => {
    const pool = new CodeAgentPool(makeLLM({}));
    for (const t of CodeAgentPool.TASK_TYPES) {
      expect(pool.canExecute(t)).toBe(true);
    }
    expect(pool.canExecute("definitely-unknown")).toBe(false);
  });

  it("returns an error for an unhandled task type", async () => {
    const pool = new CodeAgentPool(makeLLM({}));
    const out = await pool.execute({ type: "nope" }, context);
    expect(out.success).toBe(false);
    expect(out.error).toContain("No agent");
  });

  it("routes generic 'code' type to the editor agent", async () => {
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({
            changes: [],
            explanation: "nothing to do",
          }),
        ],
      }),
    );
    const out = await pool.execute({ type: "code", payload: { request: "touch nothing" } }, context);
    expect(out.success).toBe(true);
    expect(out.changesCount).toBe(0);
  });
});

describe("FilePickerAgent", () => {
  it("finds files and reads top-match content", async () => {
    fs.writeFileSync(path.join(tmpRoot, "alpha.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(tmpRoot, "beta.ts"), "export const b = 2;\n");
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({
            files: [
              { path: "alpha.ts", reason: "contains a" },
              { path: "beta.ts", reason: "contains b" },
            ],
            summary: "two files",
          }),
        ],
      }),
    );
    const out = await pool.execute(
      { type: "code_explore", payload: { prompt: "find alpha", rootDir: tmpRoot } },
      context,
    );
    expect(out.success).toBe(true);
    expect(out.files).toHaveLength(2);
    expect((out.filesWithContent as Array<{ path: string; content: string }>)[0].path).toBe(
      "alpha.ts",
    );
    expect((out.filesWithContent as Array<{ content: string }>)[0].content).toContain("export const a");
    expect(out.summary).toBe("two files");
  });

  it("supports the file_picker alias and nested directories", async () => {
    fs.mkdirSync(path.join(tmpRoot, "sub"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "sub", "deep.ts"), "deep file");
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({ files: [{ path: "sub/deep.ts", reason: "deep" }], summary: "found" }),
        ],
      }),
    );
    const out = await pool.execute(
      {
        type: "file_picker",
        payload: { query: "deep", rootDir: tmpRoot, directories: ["sub"] },
      },
      context,
    );
    expect(out.success).toBe(true);
    expect(out.rootDir).toBe(tmpRoot);
  });

  it("survives unreadable files and LLM failures", async () => {
    const pool1 = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({
            files: [{ path: "ghost.ts", reason: "gone" }],
            summary: "s",
          }),
        ],
      }),
    );
    const ok = await pool1.execute(
      { type: "code_explore", payload: { prompt: "p", rootDir: tmpRoot } },
      context,
    );
    expect(ok.success).toBe(true);
    expect((ok.filesWithContent as Array<{ content: string }>)[0].content).toBe("(file not readable)");

    const pool2 = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => {
            throw new Error("llm exploded");
          },
        ],
      }),
    );
    const failed = await pool2.execute(
      { type: "code_explore", payload: { prompt: "p", rootDir: tmpRoot } },
      context,
    );
    expect(failed.success).toBe(false);
    expect(failed.error).toBe("llm exploded");
  });

  it("handles payloads without an explicit type at the top level", async () => {
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [async () => ({ files: [], summary: "none" })],
      }),
    );
    const out = await pool.execute(
      {
        payload: { type: "code_explore", prompt: "anything", rootDir: tmpRoot },
      },
      context,
    );
    expect(out.success).toBe(true);
  });
});

describe("CodeEditorAgent", () => {
  it("writes new files and applies str_replace edits", async () => {
    fs.writeFileSync(path.join(tmpRoot, "target.ts"), "const x = 1;\n");
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({
            changes: [
              {
                path: "new.ts",
                operation: "write_file",
                content: "export const fresh = true;\n",
              },
              {
                path: "target.ts",
                operation: "str_replace",
                oldString: "const x = 1;",
                newString: "const x = 2;",
              },
            ],
            explanation: "added + changed",
          }),
        ],
      }),
    );
    const out = await pool.execute(
      { type: "code_edit", payload: { request: "do it", rootDir: tmpRoot } },
      context,
    );
    expect(out.success).toBe(true);
    expect(out.applied).toEqual(["new.ts", "target.ts"]);
    expect(fs.readFileSync(path.join(tmpRoot, "new.ts"), "utf8")).toContain("fresh");
    expect(fs.readFileSync(path.join(tmpRoot, "target.ts"), "utf8")).toContain("const x = 2;");
  });

  it("rejects path traversal and reports non-matching oldString", async () => {
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({
            changes: [
              { path: "../escape.ts", operation: "write_file", content: "evil" },
              {
                path: "target.ts",
                operation: "str_replace",
                oldString: "does-not-exist",
                newString: "x",
              },
            ],
            explanation: "attempts",
          }),
        ],
      }),
    );
    fs.writeFileSync(path.join(tmpRoot, "target.ts"), "real content");
    const out = await pool.execute(
      { type: "edit", payload: { request: "r", rootDir: tmpRoot } },
      context,
    );
    expect(out.success).toBe(false);
    expect(out.failed.some((f: string) => f.includes("traversal rejected"))).toBe(true);
    expect(out.failed.some((f: string) => f.includes("oldString not found"))).toBe(true);
    expect(fs.existsSync(path.join(os.tmpdir(), "escape.ts"))).toBe(false);
  });

  it("reports an error when the model rejects", async () => {
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => {
            throw new Error("no edits");
          },
        ],
      }),
    );
    const out = await pool.execute(
      { type: "code_edit", payload: { request: "r", rootDir: tmpRoot } },
      context,
    );
    expect(out.success).toBe(false);
    expect(out.error).toBe("no edits");
  });

  it("reads unreadable provided files gracefully", async () => {
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({ changes: [], explanation: "ok" }),
        ],
      }),
    );
    const out = await pool.execute(
      {
        type: "code_edit",
        payload: { request: "r", rootDir: tmpRoot, filePaths: ["missing.ts"] },
      },
      context,
    );
    expect(out.success).toBe(true);
  });
});

describe("CodeReviewerAgent", () => {
  it("reviews provided files and reports issue counts", async () => {
    fs.writeFileSync(path.join(tmpRoot, "buggy.ts"), "function f() { return null.x; }\n");
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({
            approved: false,
            issues: [
              { severity: "critical", file: "buggy.ts", line: "null deref", suggestion: "guard" },
              { severity: "low", file: "buggy.ts", line: "style", suggestion: "rename" },
            ],
            summary: "needs work",
          }),
        ],
      }),
    );
    const out = await pool.execute(
      { type: "code_review", payload: { rootDir: tmpRoot, filePaths: ["buggy.ts"] } },
      context,
    );
    expect(out.success).toBe(true);
    expect(out.approved).toBe(false);
    expect(out.issueCount).toBe(2);
    expect(out.criticalCount).toBe(1);
  });

  it("reviews a diff payload and handles model failure", async () => {
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({
            approved: true,
            issues: [],
            summary: "clean",
          }),
        ],
      }),
    );
    const ok = await pool.execute(
      { type: "review", payload: { diff: "+code", request: "check" } },
      context,
    );
    expect(ok.approved).toBe(true);

    const pool2 = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => {
            throw new Error("reviewer down");
          },
        ],
      }),
    );
    const failed = await pool2.execute({ type: "code_review", payload: {} }, context);
    expect(failed.success).toBe(false);
    expect(failed.error).toBe("reviewer down");
  });
});

describe("ResearcherAgent", () => {
  it("performs agentic research when a Tavily key is present", async () => {
    process.env.TAVILY_API_KEY = "k-test";
    mockState.body = JSON.stringify({
      results: [{ title: "R1", url: "https://r1.example", content: "c1" }],
    });
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({
            skipSearch: false,
            webSearch: true,
            academicSearch: false,
            discussionSearch: false,
            standaloneQuery: "query me",
          }),
          async () => ({ queries: ["q1"] }),
        ],
        texts: [async () => "a research answer"],
      }),
    );
    const out = await pool.execute(
      { type: "research", payload: { query: "question", mode: "speed" } },
      context,
    );
    expect(out.success).toBe(true);
    expect(out.answer).toBe("a research answer");
    expect(out.findingsCount).toBe(1);
  });

  it("falls back gracefully when search is unavailable", async () => {
    // no TAVILY_API_KEY → engine returns the unavailable message, still success
    const pool = new CodeAgentPool(
      makeLLM({
        objects: [
          async () => ({
            skipSearch: false,
            webSearch: true,
            academicSearch: false,
            discussionSearch: false,
            standaloneQuery: "query me",
          }),
        ],
      }),
    );
    const out = await pool.execute(
      { type: "web_research", payload: { query: "q" } },
      context,
    );
    expect(out.success).toBe(true);
    expect(out.answer).toContain("TAVILY_API_KEY not configured");
  });
});

describe("ThinkerAgent", () => {
  it("generates a reasoned answer with bounded history", async () => {
    const history: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i}`,
    }));
    const pool = new CodeAgentPool(makeLLM({}));
    const out = await pool.execute(
      { type: "reason", payload: { prompt: "think hard", context: "ctx", history } },
      context,
    );
    expect(out.success).toBe(true);
    expect(out.answer).toBe("text answer");
  });

  it("supports the think alias and reports model failure", async () => {
    const pool = new CodeAgentPool(
      makeLLM({
        texts: [
          async () => {
            throw new Error("thinker down");
          },
        ],
      }),
    );
    const out = await pool.execute({ type: "think", payload: { prompt: "p" } }, context);
    expect(out.success).toBe(false);
    expect(out.error).toBe("thinker down");
  });
});
