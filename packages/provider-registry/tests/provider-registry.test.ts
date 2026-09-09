// SPDX-License-Identifier: Apache-2.0
/**
 * ProviderRegistry tests — the live surface plus the §1.5 models.dev importer.
 *
 * The registry is provider-centric (ProviderEntry.models; findModel() walks
 * providers), while ModelDefinition is the flattened "provider/model" view the
 * importer and quick lookups use. estimateCost/findModel price in USD with
 * per-1M-token rates (null cost = free) — the same units @nexus/billing
 * consumes.
 */
import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  globalRegistry,
  BUILTIN_MODELS,
  modelsDevToDefinitions,
  registerFromModelsDev,
  fetchModelsDev,
  MODELS_DEV_API_URL,
  type ModelDefinition,
  type ModelsDevCatalogue,
} from "../src/index.js";

function makeModel(
  id: string,
  provider = "test",
  overrides: Partial<ModelDefinition> = {},
): ModelDefinition {
  return {
    id,
    provider,
    name: id,
    contextWindow: 8192,
    maxOutput: 2048,
    inputCost: 1, // USD per 1M tokens
    outputCost: 2, // USD per 1M tokens
    vision: false,
    toolUse: true,
    streaming: true,
    ...overrides,
  };
}

function makeRegistry(...models: ModelDefinition[]): ProviderRegistry {
  const r = new ProviderRegistry();
  for (const m of models) {
    const providerId = m.provider;
    const entry = r.get(providerId);
    const { provider: _p, ...model } = m;
    if (entry) {
      entry.models.push(model);
    } else {
      r.register({
        id: providerId,
        name: providerId,
        baseUrl: "",
        authType: "none",
        models: [model],
        monthlySpendLimit: null,
        currentSpend: 0,
        currentTokens: 0,
        healthScore: 100,
        lastHealthCheck: new Date().toISOString(),
        capabilities: {
          chat: true,
          embeddings: false,
          imageGeneration: false,
          audioTranscription: false,
          webSearch: false,
          codeExecution: false,
        },
      });
    }
  }
  return r;
}

describe("ProviderRegistry", () => {
  it("register and get (provider entries)", () => {
    const r = makeRegistry(makeModel("a/1", "a"));
    expect(r.get("a")).toBeDefined();
    expect(r.get("nope")).toBeUndefined();
  });

  it("has() finds models registered under any provider", () => {
    const r = makeRegistry(makeModel("a/1", "anthropic"));
    expect(r.has("a/1")).toBe(true);
    expect(r.has("a/missing")).toBe(false);
  });

  it("getModel() returns the flattened model with its provider id", () => {
    const r = makeRegistry(makeModel("a/1", "anthropic"));
    const m = r.getModel("a/1")!;
    expect(m.id).toBe("a/1");
    expect(m.provider).toBe("anthropic");
    expect(r.getModel("missing")).toBeUndefined();
  });

  it("listModels() returns all models flattened", () => {
    const r = makeRegistry(makeModel("a/1", "openai"), makeModel("b/1", "anthropic"));
    expect(r.listModels()).toHaveLength(2);
  });

  it("listModels() filters by provider", () => {
    const r = makeRegistry(makeModel("a/1", "openai"), makeModel("b/1", "anthropic"));
    const out = r.listModels({ provider: "openai" });
    expect(out).toHaveLength(1);
    expect(out[0]!.provider).toBe("openai");
  });

  it("listModels() filters by capability", () => {
    const r = makeRegistry(
      makeModel("vision/1", "x", { vision: true }),
      makeModel("novision/1", "x", { vision: false }),
    );
    expect(r.listModels({ capability: "vision" }).map((m) => m.id)).toEqual(["vision/1"]);
  });

  it("listModels() filters by maxCostPerOutputToken", () => {
    const r = makeRegistry(
      makeModel("cheap", "x", { outputCost: 0.5 }),
      makeModel("expensive", "x", { outputCost: 10 }),
    );
    const out = r.listModels({ maxCostPerOutputToken: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("cheap");
  });

  it("listModels() filters by minContextWindow", () => {
    const r = makeRegistry(
      makeModel("small", "x", { contextWindow: 8192 }),
      makeModel("large", "x", { contextWindow: 200_000 }),
    );
    const out = r.listModels({ minContextWindow: 100_000 });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("large");
  });

  it("estimateCost() computes input + output cost in USD", () => {
    const r = makeRegistry(makeModel("m", "x", { inputCost: 1, outputCost: 2 }));
    // 1000 in @ $1/MTok + 500 out @ $2/MTok
    expect(r.estimateCost("m", 1000, 500)).toBeCloseTo(1000e-6 + 500 * 2e-6);
  });

  it("estimateCost() returns 0 for unknown or free models", () => {
    expect(new ProviderRegistry().estimateCost("unknown", 100, 100)).toBe(0);
    const free = makeRegistry(makeModel("free", "x", { inputCost: null, outputCost: null }));
    expect(free.estimateCost("free", 1000, 1000)).toBe(0);
  });

  it("supportsCapability() reads derived and explicit capability flags", () => {
    const r = makeRegistry(
      makeModel("m", "x", { vision: true, toolUse: false }),
      makeModel("cached", "x", { capabilities: { promptCaching: true } }),
    );
    expect(r.supportsCapability("m", "vision")).toBe(true);
    expect(r.supportsCapability("m", "functionCalling")).toBe(false);
    expect(r.supportsCapability("cached", "promptCaching")).toBe(true);
    expect(r.supportsCapability("missing", "vision")).toBe(false);
  });

  it("findCheapestModel() returns the lowest output-cost model", () => {
    const r = makeRegistry(
      makeModel("cheap", "x", { outputCost: 0.1 }),
      makeModel("mid", "x", { outputCost: 1 }),
      makeModel("expensive", "x", { outputCost: 5 }),
    );
    expect(r.findCheapestModel()!.model.id).toBe("cheap");
  });

  it("findLargestContext() returns model with biggest context window", () => {
    const r = makeRegistry(
      makeModel("big", "x", { contextWindow: 2_000_000 }),
      makeModel("small", "x", { contextWindow: 8192 }),
    );
    expect(r.findLargestContext()!.model.id).toBe("big");
  });

  it("findModel() prices and identifies the owning provider", () => {
    const r = makeRegistry(makeModel("x/m", "x", { inputCost: 3, outputCost: 15 }));
    const hit = r.findModel("x/m")!;
    expect(hit.provider.id).toBe("x");
    expect(hit.model.inputCost).toBe(3);
  });
});

describe("globalRegistry", () => {
  it("contains all BUILTIN_MODELS", () => {
    for (const m of BUILTIN_MODELS) {
      expect(globalRegistry.has(m.id)).toBe(true);
    }
  });

  it("registers the curated default providers", () => {
    const ids = globalRegistry.providerIds();
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("google-ai-studio");
    expect(ids).toContain("groq-free");
  });

  it("prices a known model in per-1M-token USD", () => {
    // gpt-4o curated at $2.5 input / $10 output per MTok
    expect(globalRegistry.estimateCost("gpt-4o", 1_000_000, 100_000)).toBeCloseTo(2.5 + 1);
  });

  it("findModel() works across the flattened catalogue", () => {
    expect(globalRegistry.findModel("claude-sonnet-4-5")).toBeDefined();
  });
});

// ── models.dev importer ─────────────────────────────────────────────────────

// Trimmed fixture mirroring the real models.dev api.json shape.
const FIXTURE: ModelsDevCatalogue = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-3-5-sonnet-20241022": {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        attachment: true,
        tool_call: true,
        knowledge: "2024-04",
        release_date: "2024-10-22",
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200_000, output: 8192 },
      },
      "claude-2-legacy": {
        name: "Claude 2",
        tool_call: false,
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 8, output: 24 },
        limit: { context: 100_000, output: 4096 },
        status: "deprecated",
      },
    },
  },
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "llama-3.1-8b-instant": {
        name: "Llama 3.1 8B",
        tool_call: false,
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0.05, output: 0.08 },
        limit: { context: 128_000, output: 8192 },
      },
    },
  },
};

describe("modelsDevToDefinitions", () => {
  const defs = modelsDevToDefinitions(FIXTURE);
  const sonnet = defs.find((d) => d.id === "anthropic/claude-3-5-sonnet-20241022")!;

  it("namespaces id as provider/model and flattens all providers", () => {
    expect(defs.map((d) => d.id)).toContain("groq/llama-3.1-8b-instant");
    expect(defs).toHaveLength(3); // 2 anthropic + 1 groq (deprecated kept, flagged)
  });

  it("keeps per-1M-token pricing (models.dev is per-million USD)", () => {
    expect(sonnet.inputCost).toBeCloseTo(3, 9);
    expect(sonnet.outputCost).toBeCloseTo(15, 9);
  });

  it("maps limits, modalities, cutoff and release date", () => {
    expect(sonnet.contextWindow).toBe(200_000);
    expect(sonnet.maxOutput).toBe(8192);
    expect(sonnet.knowledgeCutoff).toBe("2024-04");
    expect(sonnet.releaseDate).toBe("2024-10-22");
  });

  it("derives capabilities from modalities / tool_call / cache pricing", () => {
    expect(sonnet.capabilities?.vision).toBe(true);
    expect(sonnet.capabilities?.functionCalling).toBe(true);
    expect(sonnet.capabilities?.promptCaching).toBe(true);
    const groq = defs.find((d) => d.id === "groq/llama-3.1-8b-instant")!;
    expect(groq.capabilities?.vision).toBe(false);
    expect(groq.capabilities?.promptCaching).toBe(false);
  });

  it("flags deprecated models without dropping them", () => {
    const legacy = defs.find((d) => d.id === "anthropic/claude-2-legacy")!;
    expect(legacy.capabilities?.deprecated).toBe(true);
  });
});

describe("registerFromModelsDev", () => {
  it("adds catalogue models priceable via findModel/estimateCost", () => {
    const reg = new ProviderRegistry();
    expect(registerFromModelsDev(reg, FIXTURE)).toBe(2); // deprecated skipped
    expect(reg.findModel("anthropic/claude-3-5-sonnet-20241022")).toBeDefined();
    // 1M input tokens at $3/MTok → $3
    expect(reg.estimateCost("anthropic/claude-3-5-sonnet-20241022", 1_000_000, 0)).toBeCloseTo(3);
    expect(reg.findModel("anthropic/claude-2-legacy")).toBeUndefined();
  });

  it("keeps curated entries by default, replaces only when overwrite is set", () => {
    const reg = makeRegistry(
      makeModel("anthropic/claude-3-5-sonnet-20241022", "anthropic", { name: "Curated" }),
    );
    expect(registerFromModelsDev(reg, FIXTURE)).toBe(1); // groq added, curated sonnet kept
    expect(reg.getModel("anthropic/claude-3-5-sonnet-20241022")!.name).toBe("Curated");

    registerFromModelsDev(reg, FIXTURE, { overwrite: true });
    expect(reg.getModel("anthropic/claude-3-5-sonnet-20241022")!.name).toBe("Claude 3.5 Sonnet");
  });

  it("is a no-op without a catalogue (live fetch is a Gate)", () => {
    const reg = new ProviderRegistry();
    expect(registerFromModelsDev(reg)).toBe(0);
    expect(reg.list()).toHaveLength(0);
  });
});

describe("fetchModelsDev (injected fetch — no real network)", () => {
  it("hits the catalogue URL and parses JSON", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => FIXTURE } as Response;
    }) as unknown as typeof fetch;
    const cat = await fetchModelsDev(fakeFetch);
    expect(calledUrl).toBe(MODELS_DEV_API_URL);
    expect(cat.anthropic?.models?.["claude-3-5-sonnet-20241022"]?.name).toBe("Claude 3.5 Sonnet");
  });

  it("throws on a non-ok response", async () => {
    const fakeFetch = (async () =>
      ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch;
    await expect(fetchModelsDev(fakeFetch)).rejects.toThrow("503");
  });
});
