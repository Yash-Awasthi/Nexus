// SPDX-License-Identifier: Apache-2.0
/**
 * Graph extraction is two model calls per document or chunk, so NEXUS_EXTRACT_MODEL can name a
 * cheap model for it. Hermetic: the drivers are stubs behind a mocked api-bridge.
 */
import type { LlmDriver, LlmRequestOptions } from "@nexus/llm-drivers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pinned = vi.fn();
const fallback = vi.fn();
vi.mock("../../src/routes/api-bridge.js", () => ({
  getPinnedDriver: (...args: unknown[]) => pinned(...args),
  getDefaultDriver: () => fallback(),
}));

const { extractionClient } = await import("../../src/lib/knowledge-graph-store.js");

function stub(model: string): LlmDriver & { calls: LlmRequestOptions[] } {
  const calls: LlmRequestOptions[] = [];
  return {
    provider: "stub",
    model,
    calls,
    complete: async (opts) => {
      calls.push(opts);
      return {
        id: "stub",
        content: "[]",
        model: opts.model,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "stop",
        durationMs: 0,
      };
    },
    stream: async () => {
      throw new Error("not used");
    },
    countTokens: (t) => t.length,
  };
}

const ask = async (client: Awaited<ReturnType<typeof extractionClient>>) =>
  client?.([{ role: "user", content: "Alice works at Acme." }]);

describe("extractionClient", () => {
  const saved = process.env.NEXUS_EXTRACT_MODEL;
  beforeEach(() => {
    pinned.mockReset();
    fallback.mockReset();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXUS_EXTRACT_MODEL;
    else process.env.NEXUS_EXTRACT_MODEL = saved;
  });

  it("uses the default chain on its own model when no extraction model is named", async () => {
    delete process.env.NEXUS_EXTRACT_MODEL;
    const driver = stub("expensive-model");
    fallback.mockReturnValue(driver);

    await ask(await extractionClient());

    expect(pinned).not.toHaveBeenCalled();
    expect(driver.calls[0]?.model).toBe("expensive-model");
  });

  it("sends extraction to the named provider and model", async () => {
    process.env.NEXUS_EXTRACT_MODEL = "tokenharbor/mimo-v2.6-flash:free";
    const driver = stub("chain-default");
    pinned.mockReturnValue(driver);

    await ask(await extractionClient());

    expect(pinned).toHaveBeenCalledWith("tokenharbor");
    expect(driver.calls[0]?.model).toBe("mimo-v2.6-flash:free");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to the default chain when the caller has no key for that provider", async () => {
    process.env.NEXUS_EXTRACT_MODEL = "tokenharbor/mimo-v2.6-flash:free";
    pinned.mockReturnValue(undefined);
    const driver = stub("expensive-model");
    fallback.mockReturnValue(driver);

    await ask(await extractionClient());

    expect(driver.calls[0]?.model).toBe("expensive-model");
  });

  it("is null when nothing is configured", async () => {
    delete process.env.NEXUS_EXTRACT_MODEL;
    fallback.mockReturnValue(undefined);
    expect(await extractionClient()).toBeNull();
  });
});
