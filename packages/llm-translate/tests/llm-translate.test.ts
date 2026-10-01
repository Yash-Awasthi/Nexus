// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  normalize,
  denormalize,
  translate,
  normalizeStreamChunk,
  StreamTranslator,
  type CanonicalRequest,
} from "../src/index.js";

// A request exercising the hard parts: system prompt, a tool definition, an
// assistant tool call, and the tool result that follows it.
const OPENAI_REQ = {
  model: "gpt-4o",
  max_tokens: 256,
  temperature: 0.2,
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ],
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "weather in Paris?" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "18C sunny" },
  ],
};

describe("normalize (openai → canonical)", () => {
  const c = normalize(OPENAI_REQ, "openai");
  it("keeps model/limits", () => {
    expect(c.model).toBe("gpt-4o");
    expect(c.maxTokens).toBe(256);
    expect(c.temperature).toBe(0.2);
  });
  it("parses tool-call arguments into an object", () => {
    const call = c.messages[2]?.toolCalls?.[0];
    expect(call?.name).toBe("get_weather");
    expect(call?.arguments).toEqual({ city: "Paris" });
  });
  it("preserves the tool result with its call id", () => {
    const toolMsg = c.messages.find((m) => m.role === "tool");
    expect(toolMsg?.toolCallId).toBe("call_1");
    expect(toolMsg?.content).toBe("18C sunny");
  });
});

describe("openai → canonical → openai round-trip (lossless on tool calls)", () => {
  it("survives the round trip", () => {
    const back = denormalize(normalize(OPENAI_REQ, "openai"), "openai");
    // Re-normalize both and compare the canonical form (key order / arg-string
    // whitespace are free to differ; structure must not).
    expect(normalize(back, "openai")).toEqual(normalize(OPENAI_REQ, "openai"));
  });
});

describe("openai → anthropic (the gateway's lossy gap, now preserved)", () => {
  const ant = translate(OPENAI_REQ, "openai", "anthropic");
  it("lifts system to top-level", () => {
    expect(ant.system).toBe("You are helpful.");
    expect((ant.messages as unknown[]).some((m) => (m as { role: string }).role === "system")).toBe(
      false,
    );
  });
  it("emits a tool_use block for the assistant call", () => {
    const asst = (
      ant.messages as { role: string; content: { type: string; name?: string }[] }[]
    ).find((m) => m.role === "assistant");
    const use = asst?.content.find((b) => b.type === "tool_use");
    expect(use?.name).toBe("get_weather");
  });
  it("carries the tool result as a tool_result block inside a user turn", () => {
    const msgs = ant.messages as {
      role: string;
      content: { type: string; tool_use_id?: string }[];
    }[];
    const tr = msgs.flatMap((m) => m.content).find((b) => b?.type === "tool_result");
    expect(tr?.tool_use_id).toBe("call_1");
  });
  it("supplies a default max_tokens (Anthropic requires it)", () => {
    expect(typeof ant.max_tokens).toBe("number");
  });
  it("maps tools to input_schema shape", () => {
    const tool = (ant.tools as { name: string; input_schema: unknown }[])[0];
    expect(tool?.name).toBe("get_weather");
    expect(tool?.input_schema).toBeTypeOf("object");
  });
});

describe("anthropic → openai (reverse spoke) and back to canonical", () => {
  it("openai → anthropic → openai keeps tool call + result structure", () => {
    const ant = translate(OPENAI_REQ, "openai", "anthropic");
    const oai = translate(ant, "anthropic", "openai");
    const c = normalize(oai, "openai") as CanonicalRequest;
    expect(c.messages.find((m) => m.role === "tool")?.toolCallId).toBe("call_1");
    expect(c.messages.find((m) => m.role === "assistant")?.toolCalls?.[0]?.name).toBe(
      "get_weather",
    );
  });
});

describe("openai → gemini (golden shape)", () => {
  const gem = translate(OPENAI_REQ, "openai", "gemini");
  it("lifts system into systemInstruction, not a content turn", () => {
    expect(gem.systemInstruction).toEqual({ parts: [{ text: "You are helpful." }] });
    expect((gem.contents as unknown[]).length).toBe(3);
  });
  it("maps assistant → model role and emits a functionCall part", () => {
    const contents = gem.contents as {
      role: string;
      parts: { functionCall?: { name: string } }[];
    }[];
    const modelTurn = contents.find((c) => c.role === "model");
    expect(modelTurn?.parts.some((p) => p.functionCall?.name === "get_weather")).toBe(true);
  });
  it("carries the tool result as a functionResponse part in a user turn", () => {
    const contents = gem.contents as {
      role: string;
      parts: { functionResponse?: { name: string } }[];
    }[];
    const fr = contents.flatMap((c) => c.parts).find((p) => p.functionResponse);
    expect(fr?.functionResponse?.name).toBe("call_1");
  });
  it("maps tools to a functionDeclarations array", () => {
    const tools = gem.tools as { functionDeclarations: { name: string }[] }[];
    expect(tools[0]?.functionDeclarations[0]?.name).toBe("get_weather");
  });
  it("maps max_tokens/temperature into generationConfig", () => {
    expect(gem.generationConfig).toEqual({ maxOutputTokens: 256, temperature: 0.2 });
  });
});

describe("openai → gemini → openai round-trip (lossless on tool calls)", () => {
  it("survives the round trip", () => {
    const gem = translate(OPENAI_REQ, "openai", "gemini");
    const back = translate(gem, "gemini", "openai");
    const c = normalize(back, "openai") as CanonicalRequest;
    expect(c.messages.find((m) => m.role === "tool")?.toolCallId).toBe("call_1");
    expect(c.messages.find((m) => m.role === "assistant")?.toolCalls?.[0]?.name).toBe(
      "get_weather",
    );
  });
});

describe("openai → vertex (golden shape — Gemini payload, URL-bound model)", () => {
  const vx = translate(OPENAI_REQ, "openai", "vertex");
  it("omits model and stream from the body (they are URL-bound on Vertex)", () => {
    expect(vx.model).toBeUndefined();
    expect(vx.stream).toBeUndefined();
  });
  it("keeps the Gemini contents/systemInstruction/tools shape", () => {
    expect(vx.systemInstruction).toEqual({ parts: [{ text: "You are helpful." }] });
    expect((vx.contents as unknown[]).length).toBe(3);
    const tools = vx.tools as { functionDeclarations: { name: string }[] }[];
    expect(tools[0]?.functionDeclarations[0]?.name).toBe("get_weather");
  });
  it("maps max_tokens/temperature into generationConfig", () => {
    expect(vx.generationConfig).toEqual({ maxOutputTokens: 256, temperature: 0.2 });
  });
  it("differs from the gemini body only by the URL-bound keys", () => {
    const gem = translate(OPENAI_REQ, "openai", "gemini");
    const { model: _m, stream: _s, ...gemBody } = gem as Record<string, unknown>;
    expect(vx).toEqual(gemBody);
  });
});

describe("openai → vertex → openai round-trip (lossless on tool calls)", () => {
  it("survives the round trip", () => {
    const vx = translate(OPENAI_REQ, "openai", "vertex");
    const back = translate(vx, "vertex", "openai");
    const c = normalize(back, "openai") as CanonicalRequest;
    expect(c.messages.find((m) => m.role === "tool")?.toolCallId).toBe("call_1");
    expect(c.messages.find((m) => m.role === "assistant")?.toolCalls?.[0]?.name).toBe(
      "get_weather",
    );
  });
});

describe("openai → responses (golden shape — input[] + instructions)", () => {
  const resp = translate(OPENAI_REQ, "openai", "responses");
  it("uses input[] not messages, and has no choices/messages keys", () => {
    expect(Array.isArray(resp.input)).toBe(true);
    expect(resp.messages).toBeUndefined();
  });
  it("lifts system to a top-level instructions string", () => {
    expect(resp.instructions).toBe("You are helpful.");
    expect((resp.input as { role?: string }[]).some((i) => i.role === "system")).toBe(false);
  });
  it("emits the assistant tool call as a standalone function_call item", () => {
    const input = resp.input as { type?: string; call_id?: string; name?: string }[];
    const call = input.find((i) => i.type === "function_call");
    expect(call?.name).toBe("get_weather");
    expect(call?.call_id).toBe("call_1");
  });
  it("emits the tool result as a function_call_output item", () => {
    const input = resp.input as { type?: string; call_id?: string; output?: string }[];
    const fco = input.find((i) => i.type === "function_call_output");
    expect(fco?.call_id).toBe("call_1");
    expect(fco?.output).toBe("18C sunny");
  });
  it("maps tools to the flat Responses shape (no nested function)", () => {
    const tool = (resp.tools as { type: string; name: string; parameters: unknown }[])[0];
    expect(tool?.type).toBe("function");
    expect(tool?.name).toBe("get_weather");
    expect(tool?.parameters).toBeTypeOf("object");
  });
  it("maps max_tokens to max_output_tokens", () => {
    expect(resp.max_output_tokens).toBe(256);
    expect(resp.temperature).toBe(0.2);
  });
});

describe("openai → responses → openai round-trip (lossless on tool calls)", () => {
  it("survives the round trip", () => {
    const resp = translate(OPENAI_REQ, "openai", "responses");
    const back = translate(resp, "responses", "openai");
    const c = normalize(back, "openai") as CanonicalRequest;
    expect(c.messages.find((m) => m.role === "tool")?.toolCallId).toBe("call_1");
    expect(c.messages.find((m) => m.role === "assistant")?.toolCalls?.[0]?.name).toBe(
      "get_weather",
    );
  });
});

describe("openai → ollama (golden shape — /api/chat)", () => {
  const oll = translate(OPENAI_REQ, "openai", "ollama");
  it("keeps a messages[] with system as a message (not lifted)", () => {
    const msgs = oll.messages as { role: string }[];
    expect(msgs[0]?.role).toBe("system");
  });
  it("emits tool-call arguments as an object, not a JSON string", () => {
    const msgs = oll.messages as {
      tool_calls?: { function: { name: string; arguments: unknown } }[];
    }[];
    const call = msgs.flatMap((m) => m.tool_calls ?? [])[0];
    expect(call?.function.name).toBe("get_weather");
    expect(call?.function.arguments).toEqual({ city: "Paris" });
  });
  it("references the tool result by tool_name", () => {
    const msgs = oll.messages as { role: string; tool_name?: string }[];
    const toolMsg = msgs.find((m) => m.role === "tool");
    expect(toolMsg?.tool_name).toBe("call_1");
  });
  it("puts sampling params under options (num_predict/temperature)", () => {
    expect(oll.options).toEqual({ num_predict: 256, temperature: 0.2 });
    expect(oll.max_tokens).toBeUndefined();
  });
  it("maps tools to the OpenAI-nested function shape", () => {
    const tool = (oll.tools as { type: string; function: { name: string } }[])[0];
    expect(tool?.type).toBe("function");
    expect(tool?.function.name).toBe("get_weather");
  });
});

describe("openai → ollama → openai round-trip (lossless on tool calls)", () => {
  it("survives the round trip", () => {
    const oll = translate(OPENAI_REQ, "openai", "ollama");
    const back = translate(oll, "ollama", "openai");
    const c = normalize(back, "openai") as CanonicalRequest;
    expect(c.messages.find((m) => m.role === "tool")?.toolCallId).toBe("call_1");
    expect(c.messages.find((m) => m.role === "assistant")?.toolCalls?.[0]?.name).toBe(
      "get_weather",
    );
  });
});

describe("robustness", () => {
  it("malformed tool-call args become {} instead of throwing", () => {
    const c = normalize(
      {
        messages: [
          {
            role: "assistant",
            tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{bad" } }],
          },
        ],
      },
      "openai",
    );
    expect(c.messages[0]?.toolCalls?.[0]?.arguments).toEqual({});
  });
  it("empty/garbage request yields empty messages, no throw", () => {
    expect(normalize(undefined, "openai").messages).toEqual([]);
    expect(normalize("nonsense", "anthropic").messages).toEqual([]);
    expect(normalize("nonsense", "gemini").messages).toEqual([]);
    expect(normalize("nonsense", "vertex").messages).toEqual([]);
    expect(normalize("nonsense", "responses").messages).toEqual([]);
    expect(normalize("nonsense", "ollama").messages).toEqual([]);
  });
});

// ── Streaming ─────────────────────────────────────────────────────────────────────

// An OpenAI streamed response exercising the hard parts: a text delta, then a tool
// call opened across two chunks (id/name, then a partial-JSON args fragment), then a
// tool_calls finish. Mirrors what a live upstream sends.
const OPENAI_STREAM = [
  { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
  {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] },
        finish_reason: null,
      },
    ],
  },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];

describe("streaming: openai → anthropic (golden frame sequence)", () => {
  it("brackets text/tool_use blocks and maps the stop reason", () => {
    const t = new StreamTranslator("openai", "anthropic");
    const frames = OPENAI_STREAM.flatMap((c) => t.translateChunk(c));
    frames.push(...t.flush());
    expect(frames).toEqual([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]);
  });
});

describe("streaming: anthropic → openai (golden frame sequence)", () => {
  const ANTHROPIC_STREAM = [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ];
  it("emits text/tool_call deltas and maps tool_use → tool_calls", () => {
    const t = new StreamTranslator("anthropic", "openai");
    const frames = ANTHROPIC_STREAM.flatMap((c) => t.translateChunk(c));
    frames.push(...t.flush());
    expect(frames).toEqual([
      { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { arguments: '{"city":"Paris"}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
  });
});

describe("streaming: parse spokes + flush + guards", () => {
  it("parses a gemini stream chunk (whole-object tool args)", () => {
    const events = normalizeStreamChunk(
      {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" } } }],
            },
            finishReason: "STOP",
          },
        ],
      },
      "gemini",
    );
    expect(events).toEqual([
      { type: "tool_call_start", index: 0, id: "get_weather", name: "get_weather" },
      { type: "tool_call_args", index: 0, delta: '{"city":"Paris"}' },
      { type: "finish", reason: "STOP" },
    ]);
  });
  it("parses an ollama stream chunk and its done marker", () => {
    const events = normalizeStreamChunk({ message: { content: "Hi" }, done: true }, "ollama");
    expect(events).toEqual([
      { type: "text", text: "Hi" },
      { type: "finish", reason: "stop" },
    ]);
  });
  it("flush closes an unfinished anthropic stream", () => {
    const t = new StreamTranslator("openai", "anthropic");
    const frames = t.translateChunk({
      choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
    });
    frames.push(...t.flush());
    expect(frames.map((f) => (f as { type: string }).type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
  it("throws when emitting to a parse-only format", () => {
    expect(() => new StreamTranslator("openai", "gemini")).toThrow(/streaming emit not supported/);
  });
});
