// SPDX-License-Identifier: Apache-2.0
/**
 * Model-discovery tests — per-model capabilities + live probe (mission
 * pillar 4). Covers: catalog entries carry capability fields, the Ollama
 * probe overrides catalog truth, unknown providers degrade gracefully, and a
 * dead daemon never fails discovery.
 */

import { describe, it, expect } from "vitest";

import { discoverModels, probeOllamaModels } from "../../src/lib/model-discovery.js";

function fakeFetch(models: string[], ok = true): typeof fetch {
  return (async () => {
    const body = JSON.stringify({ models: models.map((name) => ({ name })) });
    return {
      ok,
      json: async () => JSON.parse(body),
    } as unknown as Response;
  }) as typeof fetch;
}

describe("probeOllamaModels", () => {
  it("lists installed models from the daemon", async () => {
    const names = await probeOllamaModels(
      "http://localhost:11434",
      fakeFetch(["qwen2.5:7b", "nomic-embed-text:latest"]),
    );
    expect(names).toContain("qwen2.5");
    expect(names).toContain("nomic-embed-text");
  });

  it("degrades to [] when the daemon is down or no URL is set", async () => {
    expect(await probeOllamaModels(undefined)).toEqual([]);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probeOllamaModels("http://localhost:1", down)).toEqual([]);
  });
});

describe("discoverModels", () => {
  it("returns catalog models with full capability fields", async () => {
    const res = await discoverModels({ fetchFn: fakeFetch([]) });
    const openai = res.providers.find((p) => p.id === "openai");
    expect(openai).toBeDefined();
    const gpt4o = openai!.models.find((m) => m.id === "gpt-4o");
    expect(gpt4o).toMatchObject({
      contextWindow: 128_000,
      vision: true,
      toolUse: true,
      reasoningTier: "reasoning",
      source: "catalog",
    });
    expect(typeof gpt4o!.inputCostPer1M).toBe("number");
  });

  it("probe truth wins for ollama models; uninstalled catalog ids are dropped", async () => {
    const res = await discoverModels({
      ollamaBaseUrl: "http://localhost:11434",
      fetchFn: fakeFetch(["qwen2.5:7b", "nomic-embed-text:latest"]),
    });
    const ollama = res.providers.find((p) => p.id === "ollama");
    const ids = ollama!.models.map((m) => m.id);
    expect(ids).toContain("qwen2.5:7b");
    expect(ids).toContain("nomic-embed-text");
    // Not installed — dropped when the probe answered.
    expect(ids).not.toContain("llama3.2:3b");
    expect(ollama!.models.find((m) => m.id === "qwen2.5:7b")!.source).toBe("probe");
  });

  it("keeps catalog ollama entries when the daemon is unreachable", async () => {
    const res = await discoverModels({ ollamaBaseUrl: "http://localhost:1" });
    const ollama = res.providers.find((p) => p.id === "ollama");
    expect(ollama!.models.length).toBeGreaterThan(0);
    expect(ollama!.models.every((m) => m.source === "catalog")).toBe(true);
  });

  it("surfaces declared providers honestly — even with an empty model list", async () => {
    const res = await discoverModels({
      declaredProviders: ["custom-gateway"],
      fetchFn: fakeFetch([]),
    });
    expect(res.providers.some((p) => p.id === "custom-gateway")).toBe(true);
    // No catalog entries and no probe → an empty list beats a lying one.
    expect(res.providers.find((p) => p.id === "custom-gateway")!.models).toEqual([]);
  });

  it("groups and sorts providers and models deterministically", async () => {
    const res = await discoverModels({ fetchFn: fakeFetch([]) });
    const ids = res.providers.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
    for (const p of res.providers) {
      const mids = p.models.map((m) => m.id);
      expect(mids).toEqual([...mids].sort());
    }
  });
});
