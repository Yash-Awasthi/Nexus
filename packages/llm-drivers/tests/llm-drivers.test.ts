// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  AnthropicDriver,
  GroqDriver,
  DeepSeekDriver,
  MistralDriver,
  OpenRouterDriver,
  GeminiDriver,
  OllamaDriver,
  LMStudioDriver,
  LlamaCppDriver,
  FireworksDriver,
  NvidiaNimDriver,
  CerebrasDriver,
  KimiDriver,
  CodestralDriver,
  MockTransport,
  DriverRegistry,
  LlmError,
  estimateTokens,
  type LlmRequestOptions,
  type StreamDelta,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const MSGS: LlmRequestOptions["messages"] = [{ role: "user", content: "Hello" }];

function makeOpts(overrides: Partial<LlmRequestOptions> = {}): LlmRequestOptions {
  return { model: "test-model", messages: MSGS, ...overrides };
}

// Standard OpenAI-compat response
const OAI_RESPONSE = {
  id: "chatcmpl-test",
  choices: [{ message: { content: "Hi there!" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 10 },
};

// Anthropic response
const ANTH_RESPONSE = {
  id: "msg_test",
  content: [{ text: "Hi there!" }],
  usage: { input_tokens: 5, output_tokens: 10 },
};

// Gemini response
const GEMINI_RESPONSE = {
  candidates: [{ content: { parts: [{ text: "Hi there!" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 },
};

// Ollama response
const OLLAMA_RESPONSE = {
  message: { content: "Hi there!" },
};

// ── estimateTokens ────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("estimates roughly 1 token per 4 chars", () => {
    expect(estimateTokens("hello")).toBe(2); // ceil(5/4)
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

// ── MockTransport ─────────────────────────────────────────────────────────────

describe("MockTransport", () => {
  it("records calls", async () => {
    const t = new MockTransport().setResponse({ ok: true });
    await t.post("https://api.example.com", { msg: 1 }, { Auth: "x" });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe("https://api.example.com");
  });

  it("returns configured response", async () => {
    const t = new MockTransport().setResponse({ result: 42 });
    const r = (await t.post("url", {}, {})) as { result: number };
    expect(r.result).toBe(42);
  });
});

// ── AnthropicDriver ───────────────────────────────────────────────────────────

describe("AnthropicDriver", () => {
  let t: MockTransport;
  let d: AnthropicDriver;

  beforeEach(() => {
    t = new MockTransport().setResponse(ANTH_RESPONSE);
    d = new AnthropicDriver({ apiKey: "test-key" }, t);
  });

  it("provider is 'anthropic'", () => expect(d.provider).toBe("anthropic"));

  it("sends to /v1/messages", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("/v1/messages");
  });

  it("sets x-api-key header", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.headers["x-api-key"]).toBe("test-key");
  });

  it("returns parsed content", async () => {
    const r = await d.complete(makeOpts());
    expect(r.content).toBe("Hi there!");
  });

  it("returns usage", async () => {
    const r = await d.complete(makeOpts());
    expect(r.usage.inputTokens).toBe(5);
    expect(r.usage.outputTokens).toBe(10);
    expect(r.usage.totalTokens).toBe(15);
  });

  it("returns durationMs >= 0", async () => {
    const r = await d.complete(makeOpts());
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("filters system messages and uses system field", async () => {
    await d.complete(makeOpts({ systemPrompt: "Be helpful" }));
    const body = t.calls[0]!.body as Record<string, unknown>;
    expect(body["system"]).toBe("Be helpful");
  });

  it("stream emits content then done", async () => {
    const deltas: StreamDelta[] = [];
    await d.stream(makeOpts(), (d) => {
      deltas.push(d);
    });
    expect(deltas.some((d) => d.delta === "Hi there!")).toBe(true);
    expect(deltas[deltas.length - 1]!.done).toBe(true);
  });

  it("countTokens estimates", () => {
    expect(d.countTokens("hello")).toBeGreaterThan(0);
  });
});

// ── OpenAI-compatible drivers ─────────────────────────────────────────────────

describe.each([
  { name: "GroqDriver", Factory: GroqDriver, provider: "groq", url: "api.groq.com" },
  {
    name: "DeepSeekDriver",
    Factory: DeepSeekDriver,
    provider: "deepseek",
    url: "api.deepseek.com",
  },
  { name: "MistralDriver", Factory: MistralDriver, provider: "mistral", url: "api.mistral.ai" },
  {
    name: "OpenRouterDriver",
    Factory: OpenRouterDriver,
    provider: "openrouter",
    url: "openrouter.ai",
  },
  {
    name: "FireworksDriver",
    Factory: FireworksDriver,
    provider: "fireworks",
    url: "api.fireworks.ai",
  },
  {
    name: "NvidiaNimDriver",
    Factory: NvidiaNimDriver,
    provider: "nvidia_nim",
    url: "api.nvidia.com",
  },
  { name: "CerebrasDriver", Factory: CerebrasDriver, provider: "cerebras", url: "api.cerebras.ai" },
  { name: "KimiDriver", Factory: KimiDriver, provider: "kimi", url: "api.moonshot.cn" },
  {
    name: "CodestralDriver",
    Factory: CodestralDriver,
    provider: "codestral",
    url: "codestral.mistral.ai",
  },
] as const)("$name", ({ Factory, provider, url }) => {
  let t: MockTransport;
  let d: InstanceType<typeof Factory>;

  beforeEach(() => {
    t = new MockTransport().setResponse(OAI_RESPONSE);
    // @ts-ignore — all constructors accept { apiKey }
    d = new Factory({ apiKey: "key" }, t);
  });

  it(`provider is '${provider}'`, () => expect(d.provider).toBe(provider));

  it("sends to /chat/completions", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("/chat/completions");
  });

  it(`url contains '${url}'`, async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain(url);
  });

  it("sends Bearer token", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.headers["Authorization"]).toContain("Bearer");
  });

  it("returns parsed content", async () => {
    const r = await d.complete(makeOpts());
    expect(r.content).toBe("Hi there!");
  });

  it("returns usage tokens", async () => {
    const r = await d.complete(makeOpts());
    expect(r.usage.inputTokens).toBe(5);
    expect(r.usage.outputTokens).toBe(10);
  });
});

// ── Local drivers (no API key) ────────────────────────────────────────────────

describe("OllamaDriver", () => {
  let t: MockTransport;
  let d: OllamaDriver;

  beforeEach(() => {
    t = new MockTransport().setResponse(OLLAMA_RESPONSE);
    d = new OllamaDriver({ model: "llama3.2" }, t);
  });

  it("provider is 'ollama'", () => expect(d.provider).toBe("ollama"));

  it("sends to /api/chat", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("/api/chat");
  });

  it("sends stream:false", async () => {
    await d.complete(makeOpts());
    const body = t.calls[0]!.body as Record<string, unknown>;
    expect(body["stream"]).toBe(false);
  });

  it("returns message content", async () => {
    const r = await d.complete(makeOpts());
    expect(r.content).toBe("Hi there!");
  });
});

describe("LMStudioDriver", () => {
  it("provider is 'lmstudio'", () => {
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    const d = new LMStudioDriver({}, t);
    expect(d.provider).toBe("lmstudio");
  });

  it("uses localhost:1234 by default", async () => {
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    const d = new LMStudioDriver({}, t);
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("localhost:1234");
  });
});

describe("LlamaCppDriver", () => {
  it("provider is 'llamacpp'", () => {
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    const d = new LlamaCppDriver({}, t);
    expect(d.provider).toBe("llamacpp");
  });

  it("uses localhost:8080 by default", async () => {
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    const d = new LlamaCppDriver({}, t);
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("localhost:8080");
  });
});

// ── GeminiDriver ──────────────────────────────────────────────────────────────

describe("GeminiDriver", () => {
  let t: MockTransport;
  let d: GeminiDriver;

  beforeEach(() => {
    t = new MockTransport().setResponse(GEMINI_RESPONSE);
    d = new GeminiDriver({ apiKey: "gemini-key" }, t);
  });

  it("provider is 'gemini'", () => expect(d.provider).toBe("gemini"));

  it("sends to generateContent endpoint", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("generateContent");
  });

  it("includes API key in URL", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("gemini-key");
  });

  it("returns candidate text", async () => {
    const r = await d.complete(makeOpts());
    expect(r.content).toBe("Hi there!");
  });

  it("returns usage from usageMetadata", async () => {
    const r = await d.complete(makeOpts());
    expect(r.usage.inputTokens).toBe(5);
    expect(r.usage.outputTokens).toBe(10);
  });

  it("maps role: assistant → model in body", async () => {
    await d.complete(makeOpts({ messages: [{ role: "assistant", content: "hey" }] }));
    const body = t.calls[0]!.body as { contents: Array<{ role: string }> };
    expect(body.contents[0]!.role).toBe("model");
  });
});

// ── LlmError ──────────────────────────────────────────────────────────────────

describe("LlmError", () => {
  it("has code, provider, statusCode", () => {
    const e = new LlmError("AUTH_FAILED", "Unauthorized", "anthropic", 401);
    expect(e.code).toBe("AUTH_FAILED");
    expect(e.provider).toBe("anthropic");
    expect(e.statusCode).toBe(401);
    expect(e).toBeInstanceOf(Error);
  });
});

// ── DriverRegistry ────────────────────────────────────────────────────────────

describe("DriverRegistry", () => {
  it("registers and retrieves drivers", () => {
    const reg = new DriverRegistry();
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    const d = new GroqDriver({ apiKey: "k" }, t);
    reg.register(d);
    expect(reg.get("groq")).toBe(d);
  });

  it("has() returns correct bool", () => {
    const reg = new DriverRegistry();
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    reg.register(new GroqDriver({ apiKey: "k" }, t));
    expect(reg.has("groq")).toBe(true);
    expect(reg.has("gemini")).toBe(false);
  });

  it("list() returns all registered providers", () => {
    const reg = new DriverRegistry();
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    reg.register(new GroqDriver({ apiKey: "k" }, t));
    reg.register(new DeepSeekDriver({ apiKey: "k" }, t));
    expect(reg.list()).toContain("groq");
    expect(reg.list()).toContain("deepseek");
  });

  it("supports alias registration", () => {
    const reg = new DriverRegistry();
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    const d = new GroqDriver({ apiKey: "k" }, t);
    reg.register(d, "fast-llm");
    expect(reg.get("fast-llm")).toBe(d);
  });

  it("supports method chaining", () => {
    const reg = new DriverRegistry();
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    expect(reg.register(new GroqDriver({ apiKey: "k" }, t))).toBe(reg);
  });
});
