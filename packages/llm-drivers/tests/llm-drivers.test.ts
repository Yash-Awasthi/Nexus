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
  DoubaoDriver,
  BytePlusDriver,
  HunyuanDriver,
  SparkDriver,
  AzureOpenAIDriver,
  CloudflareWorkersAIDriver,
  XinferenceDriver,
  ReplicateDriver,
  BaiduErnieDriver,
  AlibabaBailianDriver,
  DifyDriver,
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

  it("setResponses returns queued responses in order, then falls back", async () => {
    const t = new MockTransport().setResponse({ fallback: true }).setResponses([{ a: 1 }, { b: 2 }]);
    expect(await t.post("u", {}, {})).toEqual({ a: 1 });
    expect(await t.post("u", {}, {})).toEqual({ b: 2 });
    expect(await t.post("u", {}, {})).toEqual({ fallback: true }); // queue drained
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
  { name: "DoubaoDriver", Factory: DoubaoDriver, provider: "doubao", url: "volces.com" },
  { name: "BytePlusDriver", Factory: BytePlusDriver, provider: "byteplus", url: "bytepluses.com" },
  {
    name: "HunyuanDriver",
    Factory: HunyuanDriver,
    provider: "hunyuan",
    url: "hunyuan.cloud.tencent.com",
  },
  { name: "SparkDriver", Factory: SparkDriver, provider: "spark", url: "spark-api-open.xf-yun.com" },
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

// ── Azure OpenAI (deployment path + api-key header) ───────────────────────────

describe("AzureOpenAIDriver", () => {
  let t: MockTransport;
  let d: AzureOpenAIDriver;
  beforeEach(() => {
    t = new MockTransport().setResponse(OAI_RESPONSE);
    d = new AzureOpenAIDriver(
      {
        apiKey: "az-key",
        endpoint: "https://my-res.openai.azure.com",
        deployment: "gpt4o-deploy",
        apiVersion: "2024-10-21",
      },
      t,
    );
  });

  it("provider is 'azure_openai'", () => expect(d.provider).toBe("azure_openai"));

  it("routes by deployment with an api-version query", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("/openai/deployments/gpt4o-deploy/chat/completions");
    expect(t.calls[0]!.url).toContain("api-version=2024-10-21");
  });

  it("authenticates with an api-key header, not Bearer", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.headers["api-key"]).toBe("az-key");
    expect(t.calls[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("parses content + usage", async () => {
    const r = await d.complete(makeOpts());
    expect(r.content).toBe("Hi there!");
    expect(r.usage.inputTokens).toBe(5);
  });
});

// ── Cloudflare Workers AI (account id in path) ────────────────────────────────

describe("CloudflareWorkersAIDriver", () => {
  let t: MockTransport;
  let d: CloudflareWorkersAIDriver;
  beforeEach(() => {
    t = new MockTransport().setResponse(OAI_RESPONSE);
    d = new CloudflareWorkersAIDriver({ apiKey: "cf-key", accountId: "acc123" }, t);
  });

  it("provider is 'cloudflare'", () => expect(d.provider).toBe("cloudflare"));

  it("puts the account id in the path and sends Bearer", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("/accounts/acc123/ai/v1/chat/completions");
    expect(t.calls[0]!.headers["Authorization"]).toContain("Bearer cf-key");
  });
});

// ── Xinference (local, no key required) ───────────────────────────────────────

describe("XinferenceDriver", () => {
  it("provider is 'xinference'", () => {
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    expect(new XinferenceDriver({}, t).provider).toBe("xinference");
  });

  it("defaults to localhost:9997", async () => {
    const t = new MockTransport().setResponse(OAI_RESPONSE);
    await new XinferenceDriver({}, t).complete(makeOpts());
    expect(t.calls[0]!.url).toContain("localhost:9997");
  });
});

// ── Replicate (predictions, Prefer: wait) ────────────────────────────────────

describe("ReplicateDriver", () => {
  let t: MockTransport;
  let d: ReplicateDriver;
  beforeEach(() => {
    t = new MockTransport().setResponse({
      id: "pred_123",
      status: "succeeded",
      output: ["Hi", " ", "there!"],
    });
    d = new ReplicateDriver({ apiKey: "r8-key" }, t);
  });

  it("provider is 'replicate'", () => expect(d.provider).toBe("replicate"));

  it("posts to /predictions with version + input.prompt", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("/predictions");
    const body = t.calls[0]!.body as { version: string; input: { prompt: string } };
    expect(body.version).toBe("test-model");
    expect(body.input.prompt).toContain("Hello");
  });

  it("sends Bearer auth + Prefer: wait (synchronous mode)", async () => {
    await d.complete(makeOpts());
    expect(t.calls[0]!.headers["Authorization"]).toContain("Bearer r8-key");
    expect(t.calls[0]!.headers["Prefer"]).toBe("wait");
  });

  it("maps systemPrompt to input.system_prompt", async () => {
    await d.complete(makeOpts({ systemPrompt: "Be brief" }));
    const body = t.calls[0]!.body as { input: { system_prompt?: string } };
    expect(body.input.system_prompt).toBe("Be brief");
  });

  it("joins the output-chunk array into content", async () => {
    const r = await d.complete(makeOpts());
    expect(r.content).toBe("Hi there!");
  });

  it("throws on a failed prediction", async () => {
    const tf = new MockTransport().setResponse({ id: "p", status: "failed", error: "boom" });
    const df = new ReplicateDriver({ apiKey: "k" }, tf);
    await expect(df.complete(makeOpts())).rejects.toThrow(/failed/);
  });
});

// ── Baidu ERNIE (client-creds OAuth → token + chat, 2 POSTs) ──────────────────

describe("BaiduErnieDriver", () => {
  const TOKEN = { access_token: "tok-abc", expires_in: 2592000 };
  const CHAT = {
    id: "ernie-1",
    result: "Hi there!",
    usage: { prompt_tokens: 5, completion_tokens: 10 },
  };
  let t: MockTransport;
  let d: BaiduErnieDriver;
  beforeEach(() => {
    t = new MockTransport().setResponses([TOKEN, CHAT]);
    d = new BaiduErnieDriver({ clientId: "ak", clientSecret: "sk" }, t);
  });

  it("provider is 'baidu_ernie'", () => expect(d.provider).toBe("baidu_ernie"));

  it("mints a token then posts chat (2 calls, correct order)", async () => {
    const r = await d.complete(makeOpts());
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]!.url).toContain("/oauth/2.0/token");
    expect(t.calls[0]!.url).toContain("grant_type=client_credentials");
    expect(t.calls[0]!.url).toContain("client_id=ak");
    expect(t.calls[1]!.url).toContain("/wenxinworkshop/chat/");
    expect(t.calls[1]!.url).toContain("access_token=tok-abc");
    expect(r.content).toBe("Hi there!");
    expect(r.usage.totalTokens).toBe(15);
  });

  it("caches the token across calls (no re-auth on second complete)", async () => {
    await d.complete(makeOpts());
    t.setResponses([CHAT]); // only a chat response left to queue
    await d.complete(makeOpts());
    // 2 (token+chat) + 1 (chat only) = 3 total; no second token POST
    expect(t.calls).toHaveLength(3);
    expect(t.calls[2]!.url).toContain("/wenxinworkshop/chat/");
  });

  it("lifts the system prompt to a top-level field", async () => {
    await d.complete(makeOpts({ systemPrompt: "Be brief" }));
    const body = t.calls[1]!.body as { system?: string; messages: unknown[] };
    expect(body.system).toBe("Be brief");
    expect(body.messages).toHaveLength(1);
  });

  it("throws AUTH_FAILED when the OAuth response has no token", async () => {
    const tf = new MockTransport().setResponses([{ error: "invalid_client" }]);
    const df = new BaiduErnieDriver({ clientId: "ak", clientSecret: "bad" }, tf);
    await expect(df.complete(makeOpts())).rejects.toThrow(/invalid_client|OAuth/);
  });

  it("maps an in-body error_code to a typed LlmError and clears the token", async () => {
    const te = new MockTransport().setResponses([TOKEN, { error_code: 110, error_msg: "token bad" }]);
    const de = new BaiduErnieDriver({ clientId: "ak", clientSecret: "sk" }, te);
    await expect(de.complete(makeOpts())).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("sends opts.tools as ERNIE `functions`", async () => {
    await d.complete(
      makeOpts({
        tools: [
          { name: "get_weather", description: "Get weather", parameters: { type: "object" } },
        ],
      }),
    );
    const body = t.calls[1]!.body as { functions?: { name: string }[] };
    expect(body.functions).toHaveLength(1);
    expect(body.functions![0]!.name).toBe("get_weather");
  });

  it("parses a function_call reply into toolCalls (id == name, args parsed)", async () => {
    const tc = new MockTransport().setResponses([
      TOKEN,
      {
        id: "e2",
        result: "",
        function_call: { name: "get_weather", arguments: '{"city":"Paris"}' },
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      },
    ]);
    const dc = new BaiduErnieDriver({ clientId: "ak", clientSecret: "sk" }, tc);
    const r = await dc.complete(makeOpts());
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]).toMatchObject({
      id: "get_weather",
      name: "get_weather",
      arguments: { city: "Paris" },
    });
  });

  it("round-trips assistant tool-call + tool result into ERNIE function messages", async () => {
    await d.complete(
      makeOpts({
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "get_weather", name: "get_weather", arguments: { city: "Paris" } }],
          },
          { role: "tool", content: '{"tempC":18}', toolCallId: "get_weather" },
        ],
      }),
    );
    const body = t.calls[1]!.body as {
      messages: { role: string; name?: string; function_call?: { name: string } }[];
    };
    expect(body.messages[1]!.function_call?.name).toBe("get_weather");
    expect(body.messages[2]!.role).toBe("function");
    expect(body.messages[2]!.name).toBe("get_weather");
  });

  it("tolerates malformed function_call arguments (empty object)", async () => {
    const tc = new MockTransport().setResponses([
      TOKEN,
      { id: "e3", result: "", function_call: { name: "f", arguments: "{not json" } },
    ]);
    const dc = new BaiduErnieDriver({ clientId: "ak", clientSecret: "sk" }, tc);
    const r = await dc.complete(makeOpts());
    expect(r.toolCalls![0]!.arguments).toEqual({});
  });
});

describe("AlibabaBailianDriver (DashScope compatible-mode)", () => {
  let t: MockTransport;
  let d: AlibabaBailianDriver;
  beforeEach(() => {
    t = new MockTransport().setResponse(OAI_RESPONSE);
    d = new AlibabaBailianDriver({ apiKey: "sk-x" }, t);
  });

  it("provider is 'alibaba_bailian', model defaults to qwen-plus", () => {
    expect(d.provider).toBe("alibaba_bailian");
    expect(d.model).toBe("qwen-plus");
  });

  it("posts to the compatible-mode chat/completions endpoint with Bearer auth", async () => {
    const r = await d.complete(makeOpts());
    expect(t.calls[0]!.url).toBe(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(t.calls[0]!.headers.Authorization).toBe("Bearer sk-x");
    expect(r.content).toBe("Hi there!");
    expect(r.usage.totalTokens).toBe(15);
  });

  it("honours a custom baseUrl (mainland region)", async () => {
    const dm = new AlibabaBailianDriver(
      { apiKey: "sk-x", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      t,
    );
    await dm.complete(makeOpts());
    expect(t.calls[0]!.url).toContain("dashscope.aliyuncs.com");
  });
});

describe("DifyDriver (app-scoped chat-messages)", () => {
  const DIFY_OK = {
    answer: "Hi there!",
    message_id: "dify-1",
    conversation_id: "conv-1",
    metadata: { usage: { prompt_tokens: 5, completion_tokens: 10 } },
  };
  let t: MockTransport;
  let d: DifyDriver;
  beforeEach(() => {
    t = new MockTransport().setResponse(DIFY_OK);
    d = new DifyDriver({ apiKey: "app-key" }, t);
  });

  it("provider is 'dify'", () => expect(d.provider).toBe("dify"));

  it("posts the last user turn as query in blocking mode with Bearer auth", async () => {
    const r = await d.complete(makeOpts());
    expect(t.calls[0]!.url).toBe("https://api.dify.ai/v1/chat-messages");
    expect(t.calls[0]!.headers.Authorization).toBe("Bearer app-key");
    const body = t.calls[0]!.body as { query: string; response_mode: string; user: string };
    expect(body.query).toBe("Hello");
    expect(body.response_mode).toBe("blocking");
    expect(body.user).toBe("nexus");
    expect(r.content).toBe("Hi there!");
    expect(r.usage.totalTokens).toBe(15);
  });

  it("folds system prompt + prior turns into the query as context", async () => {
    await d.complete(
      makeOpts({
        systemPrompt: "Be brief",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      }),
    );
    const body = t.calls[0]!.body as { query: string };
    expect(body.query).toContain("Be brief");
    expect(body.query).toContain("user: first");
    expect(body.query).toContain("assistant: ok");
    expect(body.query.endsWith("second")).toBe(true);
  });

  it("maps a Dify error envelope to a typed LlmError", async () => {
    const te = new MockTransport().setResponse({
      code: "invalid_api_key",
      message: "bad key",
      status: 401,
    });
    const de = new DifyDriver({ apiKey: "bad" }, te);
    await expect(de.complete(makeOpts())).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("honours a self-hosted baseUrl + custom user", async () => {
    const ds = new DifyDriver(
      { apiKey: "k", baseUrl: "https://dify.internal/v1", user: "u-42" },
      t,
    );
    await ds.complete(makeOpts());
    expect(t.calls[0]!.url).toBe("https://dify.internal/v1/chat-messages");
    const body = t.calls[0]!.body as { user: string };
    expect(body.user).toBe("u-42");
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
