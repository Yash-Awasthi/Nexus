// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { normalize, denormalize, translate, type CanonicalRequest } from "../src/index.js";

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
  });
});
