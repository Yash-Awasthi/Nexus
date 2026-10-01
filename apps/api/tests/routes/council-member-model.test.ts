// SPDX-License-Identifier: Apache-2.0
/**
 * Stage D1 — a council member's own model reaches the driver, and cannot be
 * used to route around BYOK.
 *
 * Before D1 the transport ignored the model it was handed and always resolved
 * this.modelAlias, so per-member models were dropped on the floor.
 */
import type { DriverRegistry } from "@nexus/llm-drivers";
import { describe, it, expect } from "vitest";

import { LlmDriversTransport, resolveMemberModel } from "../../src/routes/council.js";

interface Completion {
  model: string;
  messages: { role: string; content: string }[];
}

/** A registry holding exactly the providers named, each recording its calls. */
function registryWith(providers: string[], calls: Record<string, Completion[]>): DriverRegistry {
  const drivers = new Map(
    providers.map((p) => {
      calls[p] = [];
      return [
        p,
        {
          complete: async (req: Completion) => {
            calls[p]?.push(req);
            return {
              content: "Vote: YES",
              model: req.model,
              usage: { inputTokens: 1, outputTokens: 1 },
              durationMs: 1,
            };
          },
        },
      ];
    }),
  );
  return { get: (p: string) => drivers.get(p) } as unknown as DriverRegistry;
}

describe("resolveMemberModel", () => {
  it("resolves a council alias to its provider and model", () => {
    expect(resolveMemberModel("nexus/haiku")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("accepts an explicit provider/model pair", () => {
    expect(resolveMemberModel("openrouter/some-vendor-model")).toEqual({
      provider: "openrouter",
      model: "some-vendor-model",
    });
  });

  it("infers the provider from a bare model id", () => {
    expect(resolveMemberModel("claude-sonnet-4-6")?.provider).toBe("anthropic");
    expect(resolveMemberModel("gpt-4o")?.provider).toBe("openai");
    // "gemini", not "google" — the driver registry keys on the alias table's
    // provider names, and COUNCIL_DRIVER_ALIASES calls it gemini.
    expect(resolveMemberModel("gemini-3.6-flash")?.provider).toBe("gemini");
  });

  it("returns null for a model it cannot place", () => {
    expect(resolveMemberModel("something-unheard-of")).toBeNull();
  });
});

describe("LlmDriversTransport per-member model", () => {
  it("sends the member's model to that model's provider", async () => {
    const calls: Record<string, Completion[]> = {};
    const transport = new LlmDriversTransport(
      registryWith(["groq", "anthropic"], calls),
      "nexus/smart",
    );

    await transport.chat([{ role: "user", content: "hi" }], { model: "claude-sonnet-4-6" });

    expect(calls["anthropic"]?.[0]?.model).toBe("claude-sonnet-4-6");
    expect(calls["groq"]).toHaveLength(0);
  });

  it("falls back to the council default when the caller holds no key for that provider", async () => {
    const calls: Record<string, Completion[]> = {};
    const transport = new LlmDriversTransport(registryWith(["groq"], calls), "nexus/smart");

    await transport.chat([{ role: "user", content: "hi" }], { model: "claude-sonnet-4-6" });

    // Degrades rather than failing the vote — and never reaches a provider the
    // caller has not configured.
    expect(calls["groq"]?.[0]?.model).toBe("openai/gpt-oss-120b");
  });
});
