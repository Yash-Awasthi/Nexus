// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCodeLoop, DEFAULT_ROLES } from "../src/code-loop.js";
import councilAdapter from "../src/index.js";
import type { CodeLoopTask } from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeCtx = (environment: Record<string, string> = {}): IExecutionContext =>
  ({
    taskId: "test",
    startTime: new Date(),
    attempt: 1,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    environment,
  }) as unknown as IExecutionContext;

/** Build a mock fetch response */
const jsonOk = (body: unknown) => ({
  ok: true,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Standard Groq API response for a given content string */
const groqResp = (content: string) =>
  jsonOk({
    choices: [{ message: { content } }],
    model: "llama-3.3-70b-versatile",
    usage: { prompt_tokens: 50, completion_tokens: 100 },
  });

// Canonical reviewer responses
const REVIEW_ACCEPT = "ACCEPTED: yes\nFEEDBACK: Looks good, no issues.";
const REVIEW_REJECT = "ACCEPTED: no\nFEEDBACK: Missing error handling in line 3.";

// ---------------------------------------------------------------------------
// DEFAULT_ROLES smoke tests
// ---------------------------------------------------------------------------

describe("DEFAULT_ROLES", () => {
  it("has all five roles", () => {
    expect(Object.keys(DEFAULT_ROLES)).toEqual(
      expect.arrayContaining(["planner", "implementer", "reviewer", "debugger", "synthesizer"]),
    );
  });

  it("assigns 70b to planner, reviewer, synthesizer", () => {
    expect(DEFAULT_ROLES.planner.model).toContain("70b");
    expect(DEFAULT_ROLES.reviewer.model).toContain("70b");
    expect(DEFAULT_ROLES.synthesizer.model).toContain("70b");
  });

  it("assigns 8b to implementer and debugger (fast draft roles)", () => {
    expect(DEFAULT_ROLES.implementer.model).toContain("8b");
    expect(DEFAULT_ROLES.debugger.model).toContain("8b");
  });
});

// ---------------------------------------------------------------------------
// runCodeLoop — accepted on first iteration
// ---------------------------------------------------------------------------

describe("runCodeLoop — accepted on first iteration", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls planner → implementer → reviewer → synthesizer (4 LLM calls total)", async () => {
    // 1: planner, 2: implementer, 3: reviewer (accept), 4: synthesizer
    fetchMock
      .mockResolvedValueOnce(groqResp("1. Define fn\n2. Add validation"))
      .mockResolvedValueOnce(groqResp("function greet(name) { return `Hello, ${name}`; }"))
      .mockResolvedValueOnce(groqResp(REVIEW_ACCEPT))
      .mockResolvedValueOnce(groqResp("Implements a simple greeting function."));

    const result = await runCodeLoop(
      { taskType: "council.code_loop", spec: "Write a greet function" },
      "test-api-key",
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.ok).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.totalIterations).toBe(1);
    expect(result.finalCode).toContain("greet");
    expect(result.synthesis).toContain("greeting");
  });

  it("records plan in iteration 1 record", async () => {
    fetchMock
      .mockResolvedValueOnce(groqResp("1. Step one\n2. Step two"))
      .mockResolvedValueOnce(groqResp("const x = 1;"))
      .mockResolvedValueOnce(groqResp(REVIEW_ACCEPT))
      .mockResolvedValueOnce(groqResp("Simple assignment."));

    const result = await runCodeLoop({ taskType: "council.code_loop", spec: "Write x = 1" }, "key");

    expect(result.iterations[0].plan).toContain("Step one");
    expect(result.iterations[0].reviewAccepted).toBe(true);
  });

  it("accumulates token usage across all calls", async () => {
    fetchMock
      .mockResolvedValueOnce(groqResp("plan"))
      .mockResolvedValueOnce(groqResp("code"))
      .mockResolvedValueOnce(groqResp(REVIEW_ACCEPT))
      .mockResolvedValueOnce(groqResp("summary"));

    const result = await runCodeLoop({ taskType: "council.code_loop", spec: "x" }, "k");

    // 4 calls × (50 prompt + 100 completion) = 200 prompt, 400 completion
    expect(result.tokenUsage.promptTokens).toBe(200);
    expect(result.tokenUsage.completionTokens).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// runCodeLoop — rejected then accepted (debug cycle)
// ---------------------------------------------------------------------------

describe("runCodeLoop — debug cycle", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls debugger on rejection, then reviewer again", async () => {
    // iter1: planner, implementer, reviewer(reject)
    // iter2: debugger, reviewer(accept), synthesizer
    fetchMock
      .mockResolvedValueOnce(groqResp("plan"))
      .mockResolvedValueOnce(groqResp("buggy code"))
      .mockResolvedValueOnce(groqResp(REVIEW_REJECT))
      .mockResolvedValueOnce(groqResp("fixed code"))
      .mockResolvedValueOnce(groqResp(REVIEW_ACCEPT))
      .mockResolvedValueOnce(groqResp("summary"));

    const result = await runCodeLoop(
      { taskType: "council.code_loop", spec: "spec", maxIterations: 3 },
      "key",
    );

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(result.accepted).toBe(true);
    expect(result.totalIterations).toBe(2);
    expect(result.iterations[0].reviewAccepted).toBe(false);
    expect(result.iterations[1].reviewAccepted).toBe(true);
    expect(result.iterations[1].debugNotes).toBeDefined();
    expect(result.finalCode).toBe("fixed code");
  });

  it("returns accepted:false when maxIterations exhausted", async () => {
    // all reviewers reject; maxIterations=2 → planner + 2×(impl/debugger + reviewer) = 5 calls
    fetchMock
      .mockResolvedValueOnce(groqResp("plan")) // planner
      .mockResolvedValueOnce(groqResp("code v1")) // implementer
      .mockResolvedValueOnce(groqResp(REVIEW_REJECT)) // reviewer 1 reject
      .mockResolvedValueOnce(groqResp("code v2")) // debugger
      .mockResolvedValueOnce(groqResp(REVIEW_REJECT)); // reviewer 2 reject

    const result = await runCodeLoop(
      { taskType: "council.code_loop", spec: "spec", maxIterations: 2 },
      "key",
    );

    expect(result.accepted).toBe(false);
    expect(result.totalIterations).toBe(2);
    expect(result.synthesis).toBe(""); // no synthesizer on failure
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// runCodeLoop — Groq API error propagation
// ---------------------------------------------------------------------------

describe("runCodeLoop — Groq API errors", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.restoreAllMocks());

  it("throws when Groq API returns a non-OK HTTP response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "rate limit exceeded",
    });

    await expect(runCodeLoop({ taskType: "council.code_loop", spec: "x" }, "key")).rejects.toThrow(
      /429/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseReview fallback branch — no ACCEPTED: pattern in reviewer output
// ---------------------------------------------------------------------------

describe("runCodeLoop — parseReview fallback branch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.restoreAllMocks());

  it("accepts when reviewer returns 'LGTM' (no ACCEPTED: pattern)", async () => {
    fetchMock
      .mockResolvedValueOnce(groqResp("plan"))
      .mockResolvedValueOnce(groqResp("const x = 1;"))
      .mockResolvedValueOnce(groqResp("LGTM")) // hits the else branch → includes("LGTM") = true
      .mockResolvedValueOnce(groqResp("summary"));

    const result = await runCodeLoop({ taskType: "council.code_loop", spec: "x" }, "key");

    expect(result.accepted).toBe(true);
    expect(result.iterations[0].reviewAccepted).toBe(true);
  });

  it("rejects when reviewer returns freeform text with no accept signal", async () => {
    // No ACCEPTED: pattern and no LGTM → accepted = false → triggers debug cycle up to maxIterations
    fetchMock
      .mockResolvedValueOnce(groqResp("plan"))
      .mockResolvedValueOnce(groqResp("code v1"))
      .mockResolvedValueOnce(groqResp("needs more work")) // no ACCEPTED:, no LGTM → false
      .mockResolvedValueOnce(groqResp("code v2"))
      .mockResolvedValueOnce(groqResp("still not great")); // maxIterations=2 exhausted

    const result = await runCodeLoop(
      { taskType: "council.code_loop", spec: "x", maxIterations: 2 },
      "key",
    );

    expect(result.accepted).toBe(false);
    expect(result.iterations[0].reviewAccepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runCodeLoop — roleOverrides
// ---------------------------------------------------------------------------

describe("runCodeLoop — roleOverrides", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.restoreAllMocks());

  it("sends the overridden model name to Groq API", async () => {
    fetchMock
      .mockResolvedValueOnce(groqResp("plan"))
      .mockResolvedValueOnce(groqResp("code"))
      .mockResolvedValueOnce(groqResp(REVIEW_ACCEPT))
      .mockResolvedValueOnce(groqResp("summary"));

    await runCodeLoop(
      {
        taskType: "council.code_loop",
        spec: "x",
        roleOverrides: {
          planner: { model: "llama-3.1-8b-instant" },
        },
      },
      "key",
    );

    // First fetch call (planner) should use the overridden model
    const plannerBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { model: string };
    expect(plannerBody.model).toBe("llama-3.1-8b-instant");
  });
});

// ---------------------------------------------------------------------------
// Adapter dispatch — council.code_loop task type
// ---------------------------------------------------------------------------

describe("councilAdapter — council.code_loop dispatch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.restoreAllMocks());

  it("canExecute returns true for council.code_loop", () => {
    expect(councilAdapter.canExecute("council.code_loop")).toBe(true);
  });

  it("canExecute returns true for council.deliberate and council.evaluate", () => {
    expect(councilAdapter.canExecute("council.deliberate")).toBe(true);
    expect(councilAdapter.canExecute("council.evaluate")).toBe(true);
  });

  it("routes code_loop task to runCodeLoop using GROQ_API_KEY from context", async () => {
    fetchMock
      .mockResolvedValueOnce(groqResp("plan"))
      .mockResolvedValueOnce(groqResp("const x = 1;"))
      .mockResolvedValueOnce(groqResp(REVIEW_ACCEPT))
      .mockResolvedValueOnce(groqResp("Assigns 1 to x."));

    const task: CodeLoopTask = {
      taskType: "council.code_loop",
      spec: "const x = 1;",
    };

    const result = await councilAdapter.execute(task, makeCtx({ GROQ_API_KEY: "test-key" }));

    expect((result as { accepted: boolean }).accepted).toBe(true);
    // Verify the Authorization header was set with context key
    const authHeader = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(authHeader.Authorization).toBe("Bearer test-key");
  });

  it("throws NexusAdapterError when GROQ_API_KEY is absent", async () => {
    const task: CodeLoopTask = { taskType: "council.code_loop", spec: "write hello" };
    await expect(councilAdapter.execute(task, makeCtx({}))).rejects.toThrow(/GROQ_API_KEY/);
  });
});
