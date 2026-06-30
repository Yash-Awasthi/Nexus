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
  XaiDriver,
  TogetherDriver,
  PerplexityDriver,
  CohereDriver,
  ZhipuDriver,
  MoonshotDriver,
  ZeroOneDriver,
  BaichuanDriver,
  MiniMaxDriver,
  StepFunDriver,
  NovitaDriver,
  SiliconFlowDriver,
  HyperbolicDriver,
  ChutesDriver,
  NebiusDriver,
  VeniceDriver,
  QwenDriver,
  Ai360Driver,
  VercelAIGatewayDriver,
  LocalRouterDriver,
  BedrockDriver,
  VertexDriver,
  __sigV4ForTest,
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
  { name: "XaiDriver", Factory: XaiDriver, provider: "xai", url: "api.x.ai" },
  {
    name: "TogetherDriver",
    Factory: TogetherDriver,
    provider: "together",
    url: "api.together.xyz",
  },
  {
    name: "PerplexityDriver",
    Factory: PerplexityDriver,
    provider: "perplexity",
    url: "api.perplexity.ai",
  },
  { name: "CohereDriver", Factory: CohereDriver, provider: "cohere", url: "api.cohere.ai" },
  { name: "ZhipuDriver", Factory: ZhipuDriver, provider: "zhipu", url: "open.bigmodel.cn" },
  { name: "MoonshotDriver", Factory: MoonshotDriver, provider: "moonshot", url: "api.moonshot.ai" },
  {
    name: "ZeroOneDriver",
    Factory: ZeroOneDriver,
    provider: "zeroone",
    url: "api.lingyiwanwu.com",
  },
  {
    name: "BaichuanDriver",
    Factory: BaichuanDriver,
    provider: "baichuan",
    url: "api.baichuan-ai.com",
  },
  { name: "MiniMaxDriver", Factory: MiniMaxDriver, provider: "minimax", url: "api.minimax.chat" },
  { name: "StepFunDriver", Factory: StepFunDriver, provider: "stepfun", url: "api.stepfun.com" },
  { name: "NovitaDriver", Factory: NovitaDriver, provider: "novita", url: "api.novita.ai" },
  {
    name: "SiliconFlowDriver",
    Factory: SiliconFlowDriver,
    provider: "siliconflow",
    url: "api.siliconflow.cn",
  },
  {
    name: "HyperbolicDriver",
    Factory: HyperbolicDriver,
    provider: "hyperbolic",
    url: "api.hyperbolic.xyz",
  },
  { name: "ChutesDriver", Factory: ChutesDriver, provider: "chutes", url: "llm.chutes.ai" },
  { name: "NebiusDriver", Factory: NebiusDriver, provider: "nebius", url: "api.studio.nebius.ai" },
  { name: "VeniceDriver", Factory: VeniceDriver, provider: "venice", url: "api.venice.ai" },
  { name: "QwenDriver", Factory: QwenDriver, provider: "qwen", url: "dashscope.aliyuncs.com" },
  { name: "Ai360Driver", Factory: Ai360Driver, provider: "ai360", url: "api.360.cn" },
  {
    name: "VercelAIGatewayDriver",
    Factory: VercelAIGatewayDriver,
    provider: "vercel_ai_gateway",
    url: "ai-gateway.vercel.sh",
  },
  {
    name: "LocalRouterDriver",
    Factory: LocalRouterDriver,
    provider: "local-router",
    url: "localhost:20128",
  },
] as const)("$name", ({ Factory, provider, url }) => {
  let t: MockTransport;
  let d: InstanceType<typeof Factory>;

  beforeEach(() => {
    t = new MockTransport().setResponse(OAI_RESPONSE);
    // @ts-expect-error — all constructors accept { apiKey }
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

// ── Bedrock (SigV4) ───────────────────────────────────────────────────────────

const BEDROCK_RESPONSE = {
  output: { message: { role: "assistant", content: [{ text: "Hi there!" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
};

describe("signV4 (AWS Signature V4)", () => {
  // AWS's published "GET ListUsers" test-vector. If our signer matches this exact
  // Authorization string, the canonical-request → string-to-sign → signing-key
  // chain is all correct. Offline, deterministic — no network.
  it("matches the AWS-documented GET ListUsers signature", () => {
    const sig = __sigV4ForTest({
      method: "GET",
      host: "iam.amazonaws.com",
      path: "/",
      query: "Action=ListUsers&Version=2010-05-08",
      service: "iam",
      region: "us-east-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      payload: "",
      contentType: "application/x-www-form-urlencoded; charset=utf-8",
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(sig.amzDate).toBe("20150830T123600Z");
    expect(sig.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("includes the security token header when a session token is given", () => {
    const sig = __sigV4ForTest({
      method: "POST",
      host: "bedrock-runtime.us-east-1.amazonaws.com",
      path: "/model/x/converse",
      query: "",
      service: "bedrock",
      region: "us-east-1",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      sessionToken: "tok",
      payload: "{}",
      contentType: "application/json",
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(sig.securityToken).toBe("tok");
    expect(sig.authorization).toContain("x-amz-security-token");
  });
});

describe("BedrockDriver", () => {
  let t: MockTransport;
  let d: BedrockDriver;
  beforeEach(() => {
    t = new MockTransport().setResponse(BEDROCK_RESPONSE);
    d = new BedrockDriver(
      { accessKeyId: "AKID", secretAccessKey: "secret", region: "us-west-2" },
      t,
    );
  });

  it("provider is 'bedrock'", () => expect(d.provider).toBe("bedrock"));

  it("posts to the regional converse endpoint", async () => {
    await d.complete(makeOpts({ model: "anthropic.claude-3-5-sonnet-20240620-v1:0" }));
    expect(t.calls[0]!.url).toContain("bedrock-runtime.us-west-2.amazonaws.com");
    expect(t.calls[0]!.url).toContain("/converse");
  });

  it("signs with a SigV4 Authorization + X-Amz-Date header", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.headers["Authorization"]).toContain("AWS4-HMAC-SHA256");
    expect(t.calls[0]!.headers["X-Amz-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("maps system prompt to a Converse system block", async () => {
    await d.complete(makeOpts({ systemPrompt: "Be helpful" }));
    const body = t.calls[0]!.body as { system?: { text: string }[] };
    expect(body.system?.[0]?.text).toBe("Be helpful");
  });

  it("parses Converse output + usage", async () => {
    const r = await d.complete(makeOpts());
    expect(r.content).toBe("Hi there!");
    expect(r.usage.inputTokens).toBe(5);
    expect(r.usage.outputTokens).toBe(10);
  });
});

// ── Vertex AI (OpenAI-compatible) ─────────────────────────────────────────────

describe("VertexDriver", () => {
  let t: MockTransport;
  let d: VertexDriver;
  beforeEach(() => {
    t = new MockTransport().setResponse(OAI_RESPONSE);
    d = new VertexDriver(
      { apiKey: "gcp-access-token", project: "my-proj", region: "us-central1" },
      t,
    );
  });

  it("provider is 'vertex'", () => expect(d.provider).toBe("vertex"));

  it("builds the project/region OpenAI-compat endpoint", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("us-central1-aiplatform.googleapis.com");
    expect(t.calls[0]!.url).toContain("/projects/my-proj/locations/us-central1/endpoints/openapi");
    expect(t.calls[0]!.url).toContain("/chat/completions");
  });

  it("sends the access token as a Bearer header", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.headers["Authorization"]).toBe("Bearer gcp-access-token");
  });

  it("parses content", async () => {
    const r = await d.complete(makeOpts());
    expect(r.content).toBe("Hi there!");
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
    const body = t.calls[0]!.body as { contents: { role: string }[] };
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
