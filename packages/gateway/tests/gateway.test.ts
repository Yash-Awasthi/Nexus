// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  routeMessage,
  resolveModel,
  toOpenAIRequest,
  toAnthropicResponse,
  BUILTIN_ALIASES,
  type AnthropicRequest,
  type GatewayConfig,
} from "../src/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GROQ_CFG: GatewayConfig = {
  providers: { groq: { apiKey: "gsk_test" } },
};

function makeReq(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: "nexus/fast",
    messages: [{ role: "user", content: "Hello!" }],
    max_tokens: 100,
    ...overrides,
  };
}

function oaiResp(content: string, finishReason = "stop") {
  return {
    id: "chatcmpl-abc123",
    choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 5, completion_tokens: 10 },
  };
}

function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

// ── resolveModel ──────────────────────────────────────────────────────────────

describe("resolveModel", () => {
  it("resolves nexus/fast to groq + llama-3.1-8b-instant", () => {
    const t = resolveModel("nexus/fast", GROQ_CFG);
    expect(t).toEqual({ provider: "groq", model: "llama-3.1-8b-instant" });
  });

  it("resolves nexus/smart to groq + llama-3.3-70b-versatile", () => {
    const t = resolveModel("nexus/smart", GROQ_CFG);
    expect(t).toEqual({ provider: "groq", model: "llama-3.3-70b-versatile" });
  });

  it("resolves nexus/planner same as nexus/smart", () => {
    expect(resolveModel("nexus/planner", GROQ_CFG)).toEqual(
      resolveModel("nexus/smart", GROQ_CFG),
    );
  });

  it("resolves claude-3-5-sonnet alias", () => {
    const t = resolveModel("claude-3-5-sonnet-20241022", GROQ_CFG);
    expect(t.provider).toBe("groq");
    expect(t.model).toBe("llama-3.3-70b-versatile");
  });

  it("resolves claude-3-haiku to fast model", () => {
    const t = resolveModel("claude-3-haiku-20240307", GROQ_CFG);
    expect(t.model).toBe("llama-3.1-8b-instant");
  });

  it("pass-through unknown model name defaults to groq", () => {
    const t = resolveModel("llama-3.3-70b-versatile", GROQ_CFG);
    expect(t).toEqual({ provider: "groq", model: "llama-3.3-70b-versatile" });
  });

  it("overrideProvider swaps provider but keeps resolved model", () => {
    const t = resolveModel("nexus/fast", GROQ_CFG, "openai");
    expect(t.provider).toBe("openai");
    expect(t.model).toBe("llama-3.1-8b-instant");
  });

  it("overrideProvider on unknown model uses override provider", () => {
    const t = resolveModel("my-local-model", GROQ_CFG, "local");
    expect(t).toEqual({ provider: "local", model: "my-local-model" });
  });

  it("respects extraAliases from config", () => {
    const cfg: GatewayConfig = {
      ...GROQ_CFG,
      extraAliases: { "my-alias": { provider: "openai", model: "gpt-4o" } },
    };
    const t = resolveModel("my-alias", cfg);
    expect(t).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("extraAliases override builtins when same key", () => {
    const cfg: GatewayConfig = {
      ...GROQ_CFG,
      extraAliases: { "nexus/fast": { provider: "openai", model: "gpt-4o-mini" } },
    };
    const t = resolveModel("nexus/fast", cfg);
    expect(t).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });
});

// ── toOpenAIRequest ───────────────────────────────────────────────────────────

describe("toOpenAIRequest", () => {
  it("maps messages role and content correctly", () => {
    const req = makeReq();
    const oai = toOpenAIRequest(req, "llama-3.1-8b-instant");
    expect(oai.model).toBe("llama-3.1-8b-instant");
    expect(oai.messages).toEqual([{ role: "user", content: "Hello!" }]);
  });

  it("prepends system field as system message", () => {
    const req = makeReq({ system: "You are a test bot." });
    const oai = toOpenAIRequest(req, "llama");
    expect(oai.messages[0]).toEqual({ role: "system", content: "You are a test bot." });
    expect(oai.messages[1]).toEqual({ role: "user", content: "Hello!" });
  });

  it("omits max_tokens and temperature when undefined", () => {
    const req: AnthropicRequest = { model: "nexus/fast", messages: [] };
    const oai = toOpenAIRequest(req, "llama");
    expect(oai).not.toHaveProperty("max_tokens");
    expect(oai).not.toHaveProperty("temperature");
  });

  it("passes max_tokens and temperature when set", () => {
    const req = makeReq({ max_tokens: 512, temperature: 0.7 });
    const oai = toOpenAIRequest(req, "llama");
    expect(oai.max_tokens).toBe(512);
    expect(oai.temperature).toBe(0.7);
  });

  it("flattens content block array to string", () => {
    const req = makeReq({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    });
    const oai = toOpenAIRequest(req, "llama");
    expect(oai.messages[0]?.content).toBe("Hello \nworld");
  });

  it("sets stream:true when req.stream is true", () => {
    const req = makeReq({ stream: true });
    const oai = toOpenAIRequest(req, "llama");
    expect(oai.stream).toBe(true);
  });

  it("omits stream field when req.stream is falsy", () => {
    const req = makeReq({ stream: false });
    const oai = toOpenAIRequest(req, "llama");
    expect(oai).not.toHaveProperty("stream");
  });
});

// ── toAnthropicResponse ───────────────────────────────────────────────────────

describe("toAnthropicResponse", () => {
  it("wraps OAI response into Anthropic shape", () => {
    const res = toAnthropicResponse(oaiResp("Hi there"), "nexus/fast");
    expect(res.type).toBe("message");
    expect(res.role).toBe("assistant");
    expect(res.content).toEqual([{ type: "text", text: "Hi there" }]);
    expect(res.model).toBe("nexus/fast");
    expect(res.stop_reason).toBe("end_turn");
    expect(res.stop_sequence).toBeNull();
  });

  it("maps finish_reason=length to max_tokens", () => {
    const res = toAnthropicResponse(oaiResp("truncated", "length"), "m");
    expect(res.stop_reason).toBe("max_tokens");
  });

  it("maps finish_reason=content_filter to stop_sequence", () => {
    const res = toAnthropicResponse(oaiResp("filtered", "content_filter"), "m");
    expect(res.stop_reason).toBe("stop_sequence");
  });

  it("maps unknown finish_reason to null", () => {
    const res = toAnthropicResponse(oaiResp("x", "tool_calls"), "m");
    expect(res.stop_reason).toBeNull();
  });

  it("maps usage fields correctly", () => {
    const res = toAnthropicResponse(oaiResp("x"), "m");
    expect(res.usage).toEqual({ input_tokens: 5, output_tokens: 10 });
  });

  it("defaults usage to 0 when missing from upstream", () => {
    const noUsage = { id: "x", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] };
    const res = toAnthropicResponse(noUsage as never, "m");
    expect(res.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("prefixes id with msg_", () => {
    const res = toAnthropicResponse(oaiResp("hi"), "m");
    expect(res.id).toBe("msg_chatcmpl-abc123");
  });

  it("handles null content from upstream", () => {
    const nullContent = {
      id: "x",
      choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    };
    const res = toAnthropicResponse(nullContent as never, "m");
    expect(res.content).toEqual([{ type: "text", text: "" }]);
  });
});

// ── routeMessage ──────────────────────────────────────────────────────────────

describe("routeMessage — happy path", () => {
  it("returns anthropic-shaped response for nexus/fast", async () => {
    const fetch = mockFetch(oaiResp("Hello from Groq!"));
    const result = await routeMessage(makeReq(), GROQ_CFG, undefined, fetch);

    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.content[0]).toMatchObject({ type: "text", text: "Hello from Groq!" });
    expect(result.model).toBe("nexus/fast");
  });

  it("calls the correct Groq endpoint", async () => {
    const fetch = mockFetch(oaiResp("ok"));
    await routeMessage(makeReq(), GROQ_CFG, undefined, fetch);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends Authorization: Bearer header with provider api key", async () => {
    const fetch = mockFetch(oaiResp("ok"));
    await routeMessage(makeReq(), GROQ_CFG, undefined, fetch);

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)["Authorization"]).toBe("Bearer gsk_test");
  });

  it("routes to provider's custom baseUrl when set", async () => {
    const cfg: GatewayConfig = {
      providers: { groq: { apiKey: "k", baseUrl: "https://custom.groq.local/v1/completions" } },
    };
    const fetch = mockFetch(oaiResp("ok"));
    await routeMessage(makeReq(), cfg, undefined, fetch);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("https://custom.groq.local/v1/completions");
  });

  it("uses overrideProvider from header argument", async () => {
    const cfg: GatewayConfig = {
      providers: {
        groq: { apiKey: "gsk" },
        openai: { apiKey: "oai", baseUrl: "https://api.openai.com/v1/chat/completions" },
      },
    };
    const fetch = mockFetch(oaiResp("ok"));
    await routeMessage(makeReq({ model: "nexus/fast" }), cfg, "openai", fetch);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("openai.com");
  });

  it("generates a uuid id when upstream omits it", async () => {
    const noId = { choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    const fetch = mockFetch(noId);
    const result = await routeMessage(makeReq(), GROQ_CFG, undefined, fetch);
    expect(result.id).toMatch(/^msg_/);
    // uuid is 36 chars, prefixed with "msg_"
    expect(result.id.length).toBeGreaterThan(10);
  });
});

describe("routeMessage — error handling", () => {
  it("throws PROVIDER_NOT_CONFIGURED when provider key absent", async () => {
    const cfg: GatewayConfig = { providers: {} }; // no groq
    const fetch = mockFetch({});
    await expect(routeMessage(makeReq(), cfg, undefined, fetch)).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      statusCode: 502,
    });
  });

  it("throws PROVIDER_NOT_CONFIGURED for unknown overrideProvider", async () => {
    const fetch = mockFetch({});
    await expect(routeMessage(makeReq(), GROQ_CFG, "azure", fetch)).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
    });
  });

  it("throws UPSTREAM_ERROR with 502 on upstream 500", async () => {
    const fetch = mockFetch({ error: "internal" }, 500);
    await expect(routeMessage(makeReq(), GROQ_CFG, undefined, fetch)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      statusCode: 502,
    });
  });

  it("throws UPSTREAM_ERROR with 429 on upstream 429", async () => {
    const fetch = mockFetch({ error: "rate limit" }, 429);
    await expect(routeMessage(makeReq(), GROQ_CFG, undefined, fetch)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      statusCode: 429,
    });
  });

  it("UPSTREAM_ERROR carries upstream status and body", async () => {
    const fetch = mockFetch("rate limit body", 429);
    try {
      await routeMessage(makeReq(), GROQ_CFG, undefined, fetch);
      expect.fail("should have thrown");
    } catch (err) {
      const gwErr = err as { upstream: { status: number; body: string } };
      expect(gwErr.upstream.status).toBe(429);
    }
  });
});

// ── BUILTIN_ALIASES coverage ──────────────────────────────────────────────────

describe("BUILTIN_ALIASES", () => {
  it("exports a non-empty alias map", () => {
    expect(Object.keys(BUILTIN_ALIASES).length).toBeGreaterThan(5);
  });

  it("all aliases have provider and model fields", () => {
    for (const [, target] of Object.entries(BUILTIN_ALIASES)) {
      expect(target).toHaveProperty("provider");
      expect(target).toHaveProperty("model");
    }
  });
});
