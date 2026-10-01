// SPDX-License-Identifier: Apache-2.0
/**
 * §1.5 boot-path tests — loadProviderModelsIntoRegistry() reads the
 * provider_models table into the global registry with zero network.
 *
 * The @nexus/db module is mocked (mirroring conductor-route.test.ts) so no
 * real Postgres is needed; a rejected select proves the fail-open path.
 *
 * The global registry's public surface is the ProviderEntry API (get/list/
 * findModel), so assertions go through findModel + computeCost semantics
 * (per-1M-token prices) rather than the deprecated ModelDefinition methods.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const selectMock = vi.fn();

vi.mock("@nexus/db", () => ({
  db: {
    select: () => ({ from: () => selectMock() }),
  },
}));

import { loadProviderModelsIntoRegistry } from "../../src/lib/models-seed.js";
import { globalRegistry } from "@nexus/provider-registry";

const ROWS = [
  {
    id: "anthropic/claude-3-5-sonnet-20241022",
    provider: "anthropic",
    name: "Claude 3.5 Sonnet",
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    costPerInputToken: 3e-6,
    costPerOutputToken: 15e-6,
    deprecated: false,
    capabilities: { vision: true, functionCalling: true, streaming: true, promptCaching: true },
  },
  {
    id: "groq/llama-3.1-8b-instant",
    provider: "groq",
    name: "Llama 3.1 8B",
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    costPerInputToken: 5e-8,
    costPerOutputToken: 8e-8,
    deprecated: false,
    capabilities: { vision: false, functionCalling: false, streaming: true },
  },
];

describe("loadProviderModelsIntoRegistry (boot path)", () => {
  beforeEach(() => {
    selectMock.mockReset();
    globalRegistry.unregister("seeded");
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL =
        "postgresql://nexus_test:nexus_test@ep-test-abc123.us-east-2.aws.neon.tech/nexus_test?sslmode=require";
    }
  });

  it("loads rows into the global registry and reports the count", async () => {
    selectMock.mockResolvedValue(ROWS);
    const count = await loadProviderModelsIntoRegistry();
    expect(count).toBe(2);
    const sonnet = globalRegistry.findModel("anthropic/claude-3-5-sonnet-20241022");
    expect(sonnet?.model.name).toBe("Claude 3.5 Sonnet");
    expect(globalRegistry.findModel("groq/llama-3.1-8b-instant")).toBeDefined();
    // Prices ride through in per-1M-token units (3 USD/MTok input).
    expect(sonnet?.model.inputCost).toBeCloseTo(3e-6 * 1_000_000, 9);
  });

  it("returns 0 without touching the DB when DATABASE_URL is unset", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const count = await loadProviderModelsIntoRegistry();
      expect(count).toBe(0);
      expect(selectMock).not.toHaveBeenCalled();
    } finally {
      process.env.DATABASE_URL = prev;
    }
  });

  it("fails open (returns 0) when the DB query rejects", async () => {
    selectMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const count = await loadProviderModelsIntoRegistry();
    expect(count).toBe(0);
    expect(globalRegistry.findModel("anthropic/claude-3-5-sonnet-20241022")).toBeUndefined();
  });
});
