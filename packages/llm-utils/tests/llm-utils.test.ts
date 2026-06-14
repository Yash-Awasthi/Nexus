// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  LlmUtilsError,
  createLanguageModel,
  nullLlmClient,
  parseJsonResponse,
  classify,
  summarize,
  extract,
  setDefaultLlmClient,
  resetDefaultLlmClient,
  _getDefaultClient,
  PROVIDER_DEFAULTS,
  validateExtractResult,
  type LlmClient,
  type LlmResponse,
  type ExtractSchema,
  type ExtractViolation,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLlmClient(content: string, model = "test-model"): LlmClient {
  return vi.fn().mockResolvedValue({ content, model } satisfies LlmResponse);
}

function makeOpenAiResponse(content: string, model = "llama-3.1-8b-instant") {
  return {
    choices: [{ message: { content } }],
    model,
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function makeFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as typeof globalThis.fetch;
}

// ── LlmUtilsError ────────────────────────────────────────────────────────────

describe("LlmUtilsError", () => {
  it("has name 'LlmUtilsError'", () => {
    const err = new LlmUtilsError("msg", "CODE");
    expect(err.name).toBe("LlmUtilsError");
  });

  it("stores code and message", () => {
    const err = new LlmUtilsError("bad thing", "MY_CODE");
    expect(err.code).toBe("MY_CODE");
    expect(err.message).toBe("bad thing");
  });

  it("stores optional context", () => {
    const err = new LlmUtilsError("msg", "CODE", { foo: 1 });
    expect(err.context).toEqual({ foo: 1 });
  });

  it("is instanceof Error", () => {
    expect(new LlmUtilsError("x", "Y")).toBeInstanceOf(Error);
  });
});

// ── nullLlmClient ─────────────────────────────────────────────────────────────

describe("nullLlmClient", () => {
  it("returns empty content", async () => {
    const res = await nullLlmClient([{ role: "user", content: "hello" }]);
    expect(res.content).toBe("");
  });

  it("returns model 'null'", async () => {
    const res = await nullLlmClient([]);
    expect(res.model).toBe("null");
  });

  it("accepts call options without error", async () => {
    await expect(nullLlmClient([], { temperature: 0.5, maxTokens: 100 })).resolves.toBeDefined();
  });
});

// ── parseJsonResponse ─────────────────────────────────────────────────────────

describe("parseJsonResponse", () => {
  it("parses plain JSON object", () => {
    expect(parseJsonResponse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses plain JSON array", () => {
    expect(parseJsonResponse<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("strips ```json … ``` fence", () => {
    const wrapped = "```json\n{\"x\": 42}\n```";
    expect(parseJsonResponse<{ x: number }>(wrapped)).toEqual({ x: 42 });
  });

  it("strips plain ``` … ``` fence", () => {
    const wrapped = "```\n{\"y\": true}\n```";
    expect(parseJsonResponse<{ y: boolean }>(wrapped)).toEqual({ y: true });
  });

  it("handles extra whitespace around fenced content", () => {
    const wrapped = "```json\n  { \"z\": \"hello\" }\n```  ";
    expect(parseJsonResponse<{ z: string }>(wrapped)).toEqual({ z: "hello" });
  });

  it("throws LlmUtilsError with JSON_PARSE_ERROR for invalid JSON", () => {
    expect(() => parseJsonResponse("not json")).toThrow(LlmUtilsError);
    expect(() => parseJsonResponse("not json")).toThrow(/JSON_PARSE_ERROR|parse/i);
  });

  it("includes raw content in error context", () => {
    try {
      parseJsonResponse("bad");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmUtilsError);
      expect((e as LlmUtilsError).context?.rawContent).toBe("bad");
    }
  });
});

// ── createLanguageModel ───────────────────────────────────────────────────────

describe("createLanguageModel", () => {
  it("returns an LlmClient function", () => {
    const client = createLanguageModel({ fetch: vi.fn() as unknown as typeof fetch });
    expect(typeof client).toBe("function");
  });

  it("calls fetch with correct URL for groq (default)", async () => {
    const fetchMock = makeFetch(makeOpenAiResponse("hello"));
    const client = createLanguageModel({ fetch: fetchMock });
    await client([{ role: "user", content: "hi" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("api.groq.com"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("calls fetch with correct URL for openai provider", async () => {
    const fetchMock = makeFetch(makeOpenAiResponse("ok"));
    const client = createLanguageModel({ provider: "openai", fetch: fetchMock });
    await client([{ role: "user", content: "hi" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("api.openai.com"),
      expect.any(Object),
    );
  });

  it("uses custom baseUrl when provided", async () => {
    const fetchMock = makeFetch(makeOpenAiResponse("x"));
    const client = createLanguageModel({
      baseUrl: "http://localhost:11434/v1/",
      fetch: fetchMock,
    });
    await client([{ role: "user", content: "hi" }]);
    // trailing slash stripped
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/v1/chat/completions",
      expect.any(Object),
    );
  });

  it("sends Authorization header with apiKey", async () => {
    const fetchMock = makeFetch(makeOpenAiResponse("x"));
    const client = createLanguageModel({ apiKey: "my-key", fetch: fetchMock });
    await client([{ role: "user", content: "hi" }]);
    const [, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)?.["Authorization"]).toBe("Bearer my-key");
  });

  it("sends model in request body", async () => {
    const fetchMock = makeFetch(makeOpenAiResponse("x"));
    const client = createLanguageModel({ model: "my-model", fetch: fetchMock });
    await client([{ role: "user", content: "hi" }]);
    const [, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("my-model");
  });

  it("returns content from choices[0].message.content", async () => {
    const fetchMock = makeFetch(makeOpenAiResponse("The answer is 42"));
    const client = createLanguageModel({ fetch: fetchMock });
    const res = await client([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("The answer is 42");
  });

  it("maps usage to inputTokens / outputTokens", async () => {
    const fetchMock = makeFetch(makeOpenAiResponse("x"));
    const client = createLanguageModel({ fetch: fetchMock });
    const res = await client([{ role: "user", content: "hi" }]);
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("sets usage to undefined when not present in response", async () => {
    const body = { choices: [{ message: { content: "x" } }], model: "m" };
    const fetchMock = makeFetch(body);
    const client = createLanguageModel({ fetch: fetchMock });
    const res = await client([{ role: "user", content: "hi" }]);
    expect(res.usage).toBeUndefined();
  });

  it("passes callOpts temperature and maxTokens in body", async () => {
    const fetchMock = makeFetch(makeOpenAiResponse("x"));
    const client = createLanguageModel({ fetch: fetchMock });
    await client([{ role: "user", content: "hi" }], { temperature: 0.9, maxTokens: 128 });
    const [, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      temperature: number;
      max_tokens: number;
    };
    expect(body.temperature).toBe(0.9);
    expect(body.max_tokens).toBe(128);
  });

  it("throws LlmUtilsError with LLM_API_ERROR for non-ok HTTP status", async () => {
    const fetchMock = makeFetch("Unauthorized", 401);
    const client = createLanguageModel({ fetch: fetchMock });
    await expect(client([{ role: "user", content: "hi" }])).rejects.toThrow(LlmUtilsError);
    await expect(client([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      code: "LLM_API_ERROR",
    });
  });

  it("throws LlmUtilsError with NETWORK_ERROR when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    const client = createLanguageModel({
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await expect(client([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });

  it("defaults content to empty string when choices[0] content is null", async () => {
    const body = {
      choices: [{ message: { content: null } }],
      model: "m",
    };
    const fetchMock = makeFetch(body);
    const client = createLanguageModel({ fetch: fetchMock });
    const res = await client([{ role: "user", content: "x" }]);
    expect(res.content).toBe("");
  });
});

// ── PROVIDER_DEFAULTS ─────────────────────────────────────────────────────────

describe("PROVIDER_DEFAULTS", () => {
  it("groq default model is llama-3.1-8b-instant", () => {
    expect(PROVIDER_DEFAULTS.groq.model).toBe("llama-3.1-8b-instant");
  });

  it("openai default model is gpt-4o-mini", () => {
    expect(PROVIDER_DEFAULTS.openai.model).toBe("gpt-4o-mini");
  });
});

// ── Default client management ─────────────────────────────────────────────────

describe("setDefaultLlmClient / resetDefaultLlmClient", () => {
  afterEach(() => {
    resetDefaultLlmClient();
  });

  it("setDefaultLlmClient replaces the default used by classify/summarize/extract", async () => {
    const stub: LlmClient = vi.fn().mockResolvedValue({
      content: '{"label":"yes","confidence":0.9}',
      model: "stub",
    });
    setDefaultLlmClient(stub);
    await classify("text", ["yes", "no"] as const);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("resetDefaultLlmClient causes _getDefaultClient to return a new client", () => {
    const before = _getDefaultClient();
    resetDefaultLlmClient();
    const after = _getDefaultClient();
    // After reset, a new instance is created
    expect(after).not.toBe(before);
  });
});

// ── classify ──────────────────────────────────────────────────────────────────

describe("classify", () => {
  it("returns label and confidence for exact match", async () => {
    const llm = makeLlmClient('{"label":"calendar","confidence":0.95}');
    const result = await classify("Book a meeting", ["calendar", "email", "search"] as const, llm);
    expect(result.label).toBe("calendar");
    expect(result.confidence).toBeCloseTo(0.95);
  });

  it("matches case-insensitively (model returns titlecase)", async () => {
    const llm = makeLlmClient('{"label":"Calendar","confidence":0.8}');
    const result = await classify("Book a meeting", ["calendar", "email"] as const, llm);
    expect(result.label).toBe("calendar");
  });

  it("clamps confidence above 1 to 1", async () => {
    const llm = makeLlmClient('{"label":"email","confidence":1.5}');
    const result = await classify("send msg", ["email", "chat"] as const, llm);
    expect(result.confidence).toBe(1);
  });

  it("clamps confidence below 0 to 0", async () => {
    const llm = makeLlmClient('{"label":"chat","confidence":-0.2}');
    const result = await classify("hey", ["email", "chat"] as const, llm);
    expect(result.confidence).toBe(0);
  });

  it("defaults confidence to 0.5 when missing from response", async () => {
    const llm = makeLlmClient('{"label":"search"}');
    const result = await classify("find it", ["search", "email"] as const, llm);
    expect(result.confidence).toBe(0.5);
  });

  it("throws INVALID_LABELS for empty labels array", async () => {
    await expect(classify("text", [])).rejects.toMatchObject({ code: "INVALID_LABELS" });
  });

  it("throws INVALID_LABEL_RESPONSE when model returns an unknown label", async () => {
    const llm = makeLlmClient('{"label":"unknown_label","confidence":0.7}');
    await expect(
      classify("text", ["a", "b", "c"] as const, llm),
    ).rejects.toMatchObject({ code: "INVALID_LABEL_RESPONSE" });
  });

  it("throws JSON_PARSE_ERROR when model returns non-JSON", async () => {
    const llm = makeLlmClient("the label is calendar");
    await expect(
      classify("text", ["calendar"] as const, llm),
    ).rejects.toMatchObject({ code: "JSON_PARSE_ERROR" });
  });

  it("passes text as user message to llm", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({
      content: '{"label":"a","confidence":0.9}',
      model: "m",
    });
    await classify("my text", ["a", "b"] as const, llm);
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("my text");
  });

  it("uses custom systemPrompt when provided", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({
      content: '{"label":"yes","confidence":1}',
      model: "m",
    });
    await classify("text", ["yes", "no"] as const, llm, {
      systemPrompt: "custom system",
    });
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    const sysMsg = messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toBe("custom system");
  });

  it("calls llm with temperature 0 for determinism", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({
      content: '{"label":"a","confidence":1}',
      model: "m",
    });
    await classify("text", ["a"] as const, llm);
    const [, callOpts] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      { temperature: number },
    ];
    expect(callOpts?.temperature).toBe(0.0);
  });
});

// ── summarize ─────────────────────────────────────────────────────────────────

describe("summarize", () => {
  it("returns trimmed summary from LLM", async () => {
    const llm = makeLlmClient("  The sky is blue.  ");
    const result = await summarize("long text...", undefined, llm);
    expect(result).toBe("The sky is blue.");
  });

  it("returns empty string immediately for blank input (no LLM call)", async () => {
    const llm: LlmClient = vi.fn();
    const result = await summarize("   ", undefined, llm);
    expect(result).toBe("");
    expect(llm).not.toHaveBeenCalled();
  });

  it("returns empty string for empty input", async () => {
    const llm: LlmClient = vi.fn();
    expect(await summarize("", undefined, llm)).toBe("");
    expect(llm).not.toHaveBeenCalled();
  });

  it("passes text as user message", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({ content: "summary", model: "m" });
    await summarize("my text", undefined, llm);
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    expect(messages.find((m) => m.role === "user")?.content).toBe("my text");
  });

  it("includes maxSentences in system prompt", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({ content: "x", model: "m" });
    await summarize("text", { maxSentences: 1 }, llm);
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    const sys = messages.find((m) => m.role === "system")?.content ?? "";
    expect(sys).toContain("1");
  });

  it("defaults to 3 sentences when maxSentences not specified", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({ content: "x", model: "m" });
    await summarize("text", {}, llm);
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    const sys = messages.find((m) => m.role === "system")?.content ?? "";
    expect(sys).toContain("3");
  });

  it("uses custom systemPrompt when provided", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({ content: "x", model: "m" });
    await summarize("text", { systemPrompt: "CUSTOM" }, llm);
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    expect(messages.find((m) => m.role === "system")?.content).toBe("CUSTOM");
  });

  it("passes maxOutputTokens to llm callOpts", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({ content: "x", model: "m" });
    await summarize("text", { maxOutputTokens: 128 }, llm);
    const [, callOpts] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      { maxTokens: number },
    ];
    expect(callOpts?.maxTokens).toBe(128);
  });

  it("uses temperature 0.2 for slight creativity", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({ content: "x", model: "m" });
    await summarize("text", {}, llm);
    const [, callOpts] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      { temperature: number },
    ];
    expect(callOpts?.temperature).toBe(0.2);
  });
});

// ── extract ───────────────────────────────────────────────────────────────────

describe("extract", () => {
  const emailSchema = {
    sender: { type: "string" as const, description: "email address of the sender" },
    subject: { type: "string" as const, description: "email subject line" },
    urgent: { type: "boolean" as const, description: "true if marked urgent" },
  } satisfies ExtractSchema;

  it("returns parsed fields from LLM JSON response", async () => {
    const llm = makeLlmClient(
      '{"sender":"alice@example.com","subject":"Hello","urgent":false}',
    );
    const result = await extract("email body text", emailSchema, llm);
    expect(result.sender).toBe("alice@example.com");
    expect(result.subject).toBe("Hello");
    expect(result.urgent).toBe(false);
  });

  it("handles markdown-fenced JSON from model", async () => {
    const llm = makeLlmClient(
      "```json\n{\"sender\":\"b@b.com\",\"subject\":\"Hi\",\"urgent\":true}\n```",
    );
    const result = await extract("text", emailSchema, llm);
    expect(result.sender).toBe("b@b.com");
  });

  it("throws EMPTY_SCHEMA for empty schema", async () => {
    await expect(extract("text", {})).rejects.toMatchObject({ code: "EMPTY_SCHEMA" });
  });

  it("throws JSON_PARSE_ERROR when model returns non-JSON", async () => {
    const llm = makeLlmClient("I found the sender is alice");
    await expect(extract("text", emailSchema, llm)).rejects.toMatchObject({
      code: "JSON_PARSE_ERROR",
    });
  });

  it("passes text as user message to llm", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({
      content: '{"name":"Yash"}',
      model: "m",
    });
    await extract("call me Yash", { name: { type: "string" } }, llm);
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    expect(messages.find((m) => m.role === "user")?.content).toBe("call me Yash");
  });

  it("includes field names and types in system prompt", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({
      content: '{"count":3}',
      model: "m",
    });
    await extract("text", { count: { type: "number", description: "item count" } }, llm);
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    const sys = messages.find((m) => m.role === "system")?.content ?? "";
    expect(sys).toContain("count");
    expect(sys).toContain("number");
    expect(sys).toContain("item count");
  });

  it("marks optional fields correctly in system prompt", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({
      content: '{"title":"X"}',
      model: "m",
    });
    const schema = {
      title: { type: "string" as const },
      subtitle: { type: "string" as const, required: false },
    } satisfies ExtractSchema;
    await extract("text", schema, llm);
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    const sys = messages.find((m) => m.role === "system")?.content ?? "";
    expect(sys).toContain("optional");
    expect(sys).toContain("required");
  });

  it("calls llm with temperature 0 for determinism", async () => {
    const llm: LlmClient = vi.fn().mockResolvedValue({ content: '{"x":1}', model: "m" });
    await extract("t", { x: { type: "number" } }, llm);
    const [, callOpts] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      { temperature: number },
    ];
    expect(callOpts?.temperature).toBe(0.0);
  });

  it("handles string[] field type in response", async () => {
    const llm = makeLlmClient('{"tags":["ai","llm","fast"]}');
    const result = await extract("tags: ai, llm, fast", {
      tags: { type: "string[]", description: "list of tags" },
    }, llm);
    expect(result.tags).toEqual(["ai", "llm", "fast"]);
  });

  it("handles number[] field type in response", async () => {
    const llm = makeLlmClient('{"scores":[8,9,10]}');
    const result = await extract("scores: 8, 9, 10", {
      scores: { type: "number[]", description: "list of scores" },
    }, llm);
    expect(result.scores).toEqual([8, 9, 10]);
  });

  it("throws SCHEMA_VALIDATION_ERROR when required field is missing", async () => {
    // model omits "urgent" which is required
    const llm = makeLlmClient('{"sender":"a@b.com","subject":"Hi"}');
    const err = await extract("text", emailSchema, llm).catch((e: unknown) => e);
    expect((err as LlmUtilsError).code).toBe("SCHEMA_VALIDATION_ERROR");
    expect((err as LlmUtilsError).message).toContain('"urgent"');
  });

  it("throws SCHEMA_VALIDATION_ERROR when field has wrong type", async () => {
    // "urgent" should be boolean but model returns string
    const llm = makeLlmClient('{"sender":"a@b.com","subject":"Hi","urgent":"yes"}');
    const err = await extract("text", emailSchema, llm).catch((e: unknown) => e);
    expect((err as LlmUtilsError).code).toBe("SCHEMA_VALIDATION_ERROR");
    expect((err as LlmUtilsError).message).toContain('"urgent"');
  });

  it("does NOT throw when optional field is absent", async () => {
    const llm = makeLlmClient('{"title":"Doc"}');
    const result = await extract("text", {
      title: { type: "string" as const },
      subtitle: { type: "string" as const, required: false },
    }, llm);
    expect(result.title).toBe("Doc");
  });

  it("collects multiple violations in one error", async () => {
    // both sender and urgent missing
    const llm = makeLlmClient('{"subject":"Hi"}');
    const err = await extract("text", emailSchema, llm).catch((e: unknown) => e);
    const violations = ((err as LlmUtilsError).context as { violations: ExtractViolation[] }).violations;
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });
});

// ── validateExtractResult (standalone) ───────────────────────────────────────

describe("validateExtractResult", () => {
  const schema = {
    name:  { type: "string"  as const },
    age:   { type: "number"  as const },
    active:{ type: "boolean" as const },
    tags:  { type: "string[]" as const },
    scores:{ type: "number[]" as const },
    notes: { type: "string"  as const, required: false },
  } satisfies ExtractSchema;

  it("passes when all required fields are present and typed correctly", () => {
    expect(() =>
      validateExtractResult(
        { name: "Yash", age: 21, active: true, tags: ["a"], scores: [1] },
        schema,
      ),
    ).not.toThrow();
  });

  it("passes when optional field is absent", () => {
    expect(() =>
      validateExtractResult(
        { name: "Yash", age: 21, active: true, tags: [], scores: [] },
        schema,
      ),
    ).not.toThrow();
  });

  it("throws SCHEMA_VALIDATION_ERROR for missing required string field", () => {
    let err: unknown;
    try { validateExtractResult({ age: 21, active: true, tags: [], scores: [] }, schema); }
    catch (e) { err = e; }
    expect((err as LlmUtilsError).code).toBe("SCHEMA_VALIDATION_ERROR");
  });

  it("throws SCHEMA_VALIDATION_ERROR for wrong type on number field", () => {
    let err: unknown;
    try { validateExtractResult({ name: "X", age: "twenty", active: true, tags: [], scores: [] }, schema); }
    catch (e) { err = e; }
    expect((err as LlmUtilsError).code).toBe("SCHEMA_VALIDATION_ERROR");
    expect((err as LlmUtilsError).message).toContain('"age"');
  });

  it("throws for wrong type on boolean field", () => {
    let err: unknown;
    try { validateExtractResult({ name: "X", age: 1, active: 1, tags: [], scores: [] }, schema); }
    catch (e) { err = e; }
    expect((err as LlmUtilsError).code).toBe("SCHEMA_VALIDATION_ERROR");
  });

  it("throws for string[] field containing non-strings", () => {
    let err: unknown;
    try { validateExtractResult({ name: "X", age: 1, active: true, tags: [1, 2], scores: [] }, schema); }
    catch (e) { err = e; }
    expect((err as LlmUtilsError).code).toBe("SCHEMA_VALIDATION_ERROR");
  });

  it("throws for number[] field containing non-numbers", () => {
    let err: unknown;
    try { validateExtractResult({ name: "X", age: 1, active: true, tags: [], scores: ["a"] }, schema); }
    catch (e) { err = e; }
    expect((err as LlmUtilsError).code).toBe("SCHEMA_VALIDATION_ERROR");
  });

  it("violation context has field, expected, got, reason", () => {
    let err: unknown;
    try { validateExtractResult({ age: 21, active: true, tags: [], scores: [] }, schema); }
    catch (e) { err = e; }
    const v = ((err as LlmUtilsError).context as { violations: ExtractViolation[] }).violations[0]!;
    expect(v.field).toBe("name");
    expect(v.reason).toBe("missing");
    expect(v.got).toBe("undefined");
  });

  it("accepts null as missing (same as undefined) for required fields", () => {
    let err: unknown;
    try { validateExtractResult({ name: null, age: 1, active: true, tags: [], scores: [] }, schema); }
    catch (e) { err = e; }
    expect((err as LlmUtilsError).code).toBe("SCHEMA_VALIDATION_ERROR");
  });

  it("passes for optional field that is null", () => {
    // null optional field treated same as absent → no violation
    expect(() =>
      validateExtractResult(
        { name: "X", age: 1, active: true, tags: [], scores: [], notes: null },
        schema,
      ),
    ).not.toThrow();
  });
});
