// SPDX-License-Identifier: Apache-2.0
/** A caller whose only connection is a custom endpoint still gets a council, on that endpoint. */
import type { LlmDriver, LlmRequestOptions } from "@nexus/llm-drivers";
import { describe, expect, it, vi } from "vitest";

const asked: string[] = [];
const custom = {
  provider: "tokenharbor",
  model: "qwen-free",
  complete: async (opts: LlmRequestOptions) => {
    asked.push(String(opts.model));
    return {
      id: "c",
      content: "Vote: YES\nConfidence: 0.8\nReasoning: fine.",
      model: "qwen-free",
      usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
      finishReason: "stop",
      durationMs: 1,
    };
  },
} as unknown as LlmDriver;

let connections: { id: string; driver: LlmDriver }[] = [{ id: "tokenharbor", driver: custom }];
vi.mock("../../src/lib/provider-keys.js", async (importOriginal) => {
  const { DriverRegistry } = await import("@nexus/llm-drivers");
  return {
    ...(await importOriginal<typeof import("../../src/lib/provider-keys.js")>()),
    // No key for any council alias provider.
    buildUserDriverRegistry: async (_u: string | undefined, providers: Iterable<string>) => ({
      registry: new DriverRegistry(),
      missing: [...providers],
    }),
    listUserDrivers: async () => connections,
  };
});

const { deliberateForUser } = await import("../../src/routes/council.js");

const request = {
  proposal: { title: "Should we approve this hire?", description: "A writer for the bakery site." },
  councilSize: 3,
  timeoutMs: 20_000,
} as Parameters<typeof deliberateForUser>[1];

describe("deliberateForUser with only a custom endpoint", () => {
  it("runs the council on the caller's own connection", async () => {
    const res = await deliberateForUser("user-1", request);
    expect(res.ok, res.error).toBe(true);
    expect(res.result?.outcome).toBe("approved");
    expect(asked.length).toBeGreaterThanOrEqual(3);
  });

  it("still asks for a key when the caller has no connection at all", async () => {
    connections = [];
    await expect(deliberateForUser("user-1", request)).rejects.toThrow(/No API key configured/);
  });
});
