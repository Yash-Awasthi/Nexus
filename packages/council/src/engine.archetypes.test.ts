// SPDX-License-Identifier: Apache-2.0
/**
 * Stage D1 — the engine deliberates with the member list it is given, and each
 * member votes on its own model and temperature.
 *
 * Before D1 the engine called summonArchetypes itself and passed
 * config.defaultModel for every vote, so a custom archetype could never speak
 * and the per-member model and temperature the UI collected were ignored.
 */
import { describe, it, expect } from "vitest";

import type { Archetype } from "./archetypes.js";
import { DeliberationEngine, type ILLMMessage, type ILLMResponse } from "./engine.js";

interface Call {
  system: string;
  model: string | undefined;
  temperature: number | undefined;
}

function recordingTransport(calls: Call[]) {
  return {
    async chat(
      messages: ILLMMessage[],
      options?: { model?: string; temperature?: number },
    ): Promise<ILLMResponse> {
      calls.push({
        system: messages.find((m) => m.role === "system")?.content ?? "",
        model: options?.model,
        temperature: options?.temperature,
      });
      return {
        content: "Analysis.\nVote: YES\nConfidence: 0.9",
        model: options?.model ?? "unset",
        usage: { promptTokens: 10, completionTokens: 10 },
        latencyMs: 1,
      };
    },
  };
}

const REQUEST = {
  proposal: { title: "Ship the thing", description: "Should we ship it?" },
} as const;

describe("DeliberationEngine member resolution", () => {
  it("votes with the supplied archetypes instead of the built-in summons", async () => {
    const calls: Call[] = [];
    const engine = new DeliberationEngine({ llm: recordingTransport(calls) });
    const custom: Archetype = {
      id: "custom-1",
      name: "The Auditor",
      thinkingStyle: "Ledger-first",
      asks: "Where is the receipt?",
      blindSpot: "Distrusts narrative",
      systemPrompt: "You are The Auditor. Ask for receipts.",
    };

    const res = await engine.deliberate({ ...REQUEST, councilSize: 1 }, { archetypes: [custom] });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toBe("You are The Auditor. Ask for receipts.");
  });

  it("passes each member's own model and temperature to the transport", async () => {
    const calls: Call[] = [];
    const engine = new DeliberationEngine({
      llm: recordingTransport(calls),
      defaultModel: "council/default",
    });
    const members: Archetype[] = [
      {
        id: "a",
        name: "A",
        thinkingStyle: "",
        asks: "",
        blindSpot: "",
        systemPrompt: "A",
        model: "claude-sonnet-4-6",
        temperature: 0.1,
      },
      {
        id: "b",
        name: "B",
        thinkingStyle: "",
        asks: "",
        blindSpot: "",
        systemPrompt: "B",
      },
    ];

    await engine.deliberate({ ...REQUEST, councilSize: 2 }, { archetypes: members });

    const byPrompt = new Map(calls.map((c) => [c.system, c]));
    expect(byPrompt.get("A")?.model).toBe("claude-sonnet-4-6");
    expect(byPrompt.get("A")?.temperature).toBe(0.1);
    // A member with no model of its own still falls back to the council default.
    expect(byPrompt.get("B")?.model).toBe("council/default");
    expect(byPrompt.get("B")?.temperature).toBe(0.7);
  });

  it("falls back to the built-in summons when no members are supplied", async () => {
    const calls: Call[] = [];
    const engine = new DeliberationEngine({
      llm: recordingTransport(calls),
      defaultModel: "council/default",
    });

    await engine.deliberate({ ...REQUEST, councilSize: 3 });

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.model === "council/default")).toBe(true);
    expect(calls.some((c) => c.system.includes("You are The"))).toBe(true);
  });
});
