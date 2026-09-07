// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ChatMessage } from "../src/interfaces/language-model.interface.js";
import { createLanguageModel } from "../src/language-model.js";

interface RecordedRequest {
  opts: { hostname?: string; path?: string; headers?: Record<string, string> };
  body: Record<string, unknown>;
}

const mockState = vi.hoisted(() => ({
  request: vi.fn(),
  requests: [] as RecordedRequest[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: undefined as undefined | ((opts: RecordedRequest["opts"]) => string | string[]),
}));

vi.mock("https", () => ({ request: mockState.request }));
vi.mock("http", () => ({ request: mockState.request }));

function installResponder(): void {
  mockState.requests = [];
  mockState.request.mockImplementation(
    (opts: RecordedRequest["opts"], cb?: (res: unknown) => void) => {
      type Handler = { on: (e: string, h: (d?: unknown) => void) => unknown };
      const handlers: Record<string, Array<(d?: unknown) => void>> = {};
      const res = {
        on(ev: string, h: (d?: unknown) => void) {
          (handlers[ev] ??= []).push(h);
          return res;
        },
        emit(ev: string, d?: unknown) {
          (handlers[ev] ?? []).forEach((h) => h(d));
          return true;
        },
      } as Handler;
      if (cb) cb(res);
      const reqHandlers: Record<string, Array<() => void>> = {};
      const req = {
        on: (ev: string, h: () => void) => {
          (reqHandlers[ev] ??= []).push(h);
          return req;
        },
        write: (payload: string) => {
          mockState.requests.push({
            opts,
            body: JSON.parse(payload) as Record<string, unknown>,
          });
        },
        end: () => {
          setImmediate(() => {
            const chunks = mockState.handler
              ? mockState.handler(opts)
              : JSON.stringify({ choices: [{ message: { content: "default" } }] });
            const list = Array.isArray(chunks) ? chunks : [chunks];
            for (const chunk of list) {
              (res as unknown as { emit: (e: string, d?: unknown) => boolean }).emit(
                "data",
                Buffer.from(chunk),
              );
            }
            (res as unknown as { emit: (e: string, d?: unknown) => boolean }).emit("end");
          });
        },
      };
      return req;
    },
  );
}

const chatBody = (content: string) =>
  JSON.stringify({ choices: [{ message: { content } }] });

const lastBody = (): Record<string, unknown> =>
  mockState.requests[mockState.requests.length - 1].body;

beforeEach(() => {
  installResponder();
  mockState.handler = () => chatBody("hello from groq");
});

describe("createLanguageModel factory", () => {
  it("builds a groq provider from an explicit key/model", () => {
    const model = createLanguageModel({ provider: "groq", groqApiKey: "k", groqModel: "llama-x" });
    expect(model.modelId).toBe("groq:llama-x");
  });

  it("falls back to the GROQ_API_KEY env default", () => {
    const model = createLanguageModel({ provider: "groq" });
    expect(model.modelId).toBe("groq:openai/gpt-oss-120b");
  });

  it("builds a free provider from a route config", () => {
    const model = createLanguageModel({
      provider: "free",
      freeConfig: { routes: ["ollama:llama3"], ollamaBase: "http://localhost:11434" },
    });
    expect(model.modelId).toBe("free:ollama:llama3");
  });

  it("falls back to groq default for an unmatched config", () => {
    const model = createLanguageModel({ provider: "free" });
    expect(model.modelId).toBe("groq:openai/gpt-oss-120b");
  });
});

describe("GroqModelProvider", () => {
  it("generates text and forwards model/messages/options", async () => {
    const model = createLanguageModel({ provider: "groq", groqApiKey: "k", groqModel: "gpt" });
    const out = await model.generateText({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: {} } }],
      maxTokens: 512,
      temperature: 0.5,
    });
    expect(out).toBe("hello from groq");
    expect(lastBody()).toMatchObject({
      model: "gpt",
      max_tokens: 512,
      temperature: 0.5,
    });
    expect((lastBody() as { tools: unknown[] }).tools).toHaveLength(1);
    expect(lastBody()).not.toHaveProperty("stream");
  });

  it("returns an empty string when the response has no content", async () => {
    mockState.handler = () => JSON.stringify({ choices: [{}] });
    const model = createLanguageModel({ provider: "groq", groqApiKey: "k" });
    expect(await model.generateText({ messages: [] })).toBe("");
  });

  it("generates structured objects and adds an extraction system prompt when absent", async () => {
    mockState.handler = () => chatBody('{"ok":true,"n":3}');
    const model = createLanguageModel({ provider: "groq", groqApiKey: "k" });
    const out = await model.generateObject<{ ok: boolean; n: number }>({
      messages: [{ role: "user", content: "go" }],
      schema: { type: "object" },
    });
    expect(out).toEqual({ ok: true, n: 3 });
    const messages = lastBody().messages as ChatMessage[];
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain("JSON Schema");
    expect(lastBody().response_format).toEqual({ type: "json_object" });
  });

  it("skips the extraction system prompt when the caller supplied one", async () => {
    mockState.handler = () => chatBody("{}");
    const model = createLanguageModel({ provider: "groq", groqApiKey: "k" });
    await model.generateObject({
      messages: [{ role: "system", content: "mine" }, { role: "user", content: "go" }],
      schema: { type: "object" },
    });
    const messages = lastBody().messages as ChatMessage[];
    expect(messages.map((m) => m.role)).toEqual(["user", "system", "user"]);
  });

  it("streams text chunks across partial SSE lines and stops at [DONE]", async () => {
    mockState.handler = () => [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: [DONE]\n\n',
    ];
    const model = createLanguageModel({ provider: "groq", groqApiKey: "k" });
    const chunks: string[] = [];
    for await (const chunk of model.streamText({ messages: [{ role: "user", content: "s" }] })) {
      chunks.push(chunk.contentChunk);
    }
    expect(chunks.join("")).toBe("Hello");
    expect(lastBody().stream).toBe(true);
  });
});

describe("FreeModelProvider", () => {
  it("routes ollama requests and returns the response field", async () => {
    mockState.handler = () => JSON.stringify({ response: "ollama says hi" });
    const model = createLanguageModel({
      provider: "free",
      freeConfig: { routes: ["ollama:llama3"], ollamaBase: "http://localhost:11434" },
    });
    const out = await model.generateText({ messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("ollama says hi");
    expect(lastBody()).toMatchObject({ model: "llama3", stream: false });
  });

  it("routes openrouter requests with bearer auth", async () => {
    mockState.handler = () => chatBody("from openrouter");
    const model = createLanguageModel({
      provider: "free",
      freeConfig: { routes: ["openrouter:some/model"], keys: { openrouter: "or-key" } },
    });
    expect(await model.generateText({ messages: [] })).toBe("from openrouter");
    const req = mockState.requests[0];
    expect(req.opts.hostname).toBe("openrouter.ai");
    expect(req.opts.headers?.Authorization).toBe("Bearer or-key");
  });

  it("routes groq sub-provider when a key is configured", async () => {
    mockState.handler = () => chatBody("hello from groq");
    const model = createLanguageModel({
      provider: "free",
      freeConfig: { routes: ["groq:gpt-oss"], keys: { groq: "groq-key" } },
    });
    expect(await model.generateText({ messages: [] })).toBe("hello from groq");
  });

  it("falls through exhausted routes and throws", async () => {
    const model = createLanguageModel({
      provider: "free",
      freeConfig: {
        routes: ["openrouter:nokey", "ollama:local"],
        ollamaBase: "http://localhost:11434",
      },
    });
    await expect(model.generateText({ messages: [] })).rejects.toThrow(/all routes exhausted/);
  });

  it("streams via the groq sub-provider when the first route is groq", async () => {
    mockState.handler = () => [
      'data: {"choices":[{"delta":{"content":"A',
      'B"}}]}\n\ndata: [DONE]\n\n',
    ];
    const model = createLanguageModel({
      provider: "free",
      freeConfig: { routes: ["groq:gpt-oss"], keys: { groq: "g" } },
    });
    const chunks: string[] = [];
    for await (const chunk of model.streamText({ messages: [] })) {
      chunks.push(chunk.contentChunk);
    }
    expect(chunks.join("")).toBe("AB");
  });

  it("emits a single chunk for non-groq streaming routes", async () => {
    mockState.handler = () => JSON.stringify({ response: "local stream" });
    const model = createLanguageModel({
      provider: "free",
      freeConfig: { routes: ["ollama:qwen"], ollamaBase: "http://localhost:11434" },
    });
    const chunks: string[] = [];
    for await (const chunk of model.streamText({ messages: [] })) {
      chunks.push(chunk.contentChunk);
    }
    expect(chunks).toEqual(["local stream"]);
  });

  it("throws when all streaming routes are exhausted", async () => {
    const model = createLanguageModel({
      provider: "free",
      freeConfig: { routes: ["openrouter:missing"] },
    });
    const iter = model.streamText({ messages: [] });
    await expect(iter.next()).rejects.toThrow(/all routes exhausted for streaming/);
  });

  it("generateObject strips markdown fences around the JSON", async () => {
    mockState.handler = () => chatBody("```json\n{\"a\":1}\n```");
    const model = createLanguageModel({
      provider: "free",
      freeConfig: { routes: ["groq:gpt-oss"], keys: { groq: "g" } },
    });
    const out = await model.generateObject<{ a: number }>({
      messages: [{ role: "user", content: "q" }],
      schema: { type: "object" },
    });
    expect(out).toEqual({ a: 1 });
  });
});
