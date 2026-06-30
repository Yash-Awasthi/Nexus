// SPDX-License-Identifier: Apache-2.0
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
    maxOutputTokens: 2048,
    costPerInputToken: 1e-6,
    costPerOutputToken: 2e-6,
    capabilities: {
      vision: false,
      functionCalling: true,
      streaming: true,
      promptCaching: false,
      jsonMode: true,
      systemPrompt: true,
    },
    ...overrides,
  };
}

describe("ProviderRegistry", () => {
  it("register and get", () => {
    const r = new ProviderRegistry();
    const m = makeModel("test/model");
    r.register(m);
    expect(r.get("test/model")).toBe(m);
  });

  it("has() returns correct boolean", () => {
    const r = new ProviderRegistry();
    r.register(makeModel("a/b"));
    expect(r.has("a/b")).toBe(true);
    expect(r.has("missing")).toBe(false);
  });

  it("list() returns all models", () => {
    const r = new ProviderRegistry();
    r.register(makeModel("a/1"));
    r.register(makeModel("b/2"));
    expect(r.list()).toHaveLength(2);
  });

  it("list() filters by provider", () => {
    const r = new ProviderRegistry();
    r.register(makeModel("a/1", "openai"));
    r.register(makeModel("b/1", "anthropic"));
    expect(r.list({ provider: "openai" })).toHaveLength(1);
    expect(r.list({ provider: "openai" })[0]!.provider).toBe("openai");
  });

  it("list() filters by capability", () => {
    const r = new ProviderRegistry();
    r.register(
      makeModel("a/1", "x", {
        capabilities: {
          vision: true,
          functionCalling: true,
          streaming: true,
          promptCaching: false,
          jsonMode: true,
          systemPrompt: true,
        },
      }),
    );
    r.register(
      makeModel("b/1", "x", {
        capabilities: {
          vision: false,
          functionCalling: true,
          streaming: true,
          promptCaching: false,
          jsonMode: true,
          systemPrompt: true,
        },
      }),
    );
    expect(r.list({ capability: "vision" })).toHaveLength(1);
  });

  it("list() filters by maxCostPerOutputToken", () => {
    const r = new ProviderRegistry();
    r.register(makeModel("cheap", "x", { costPerOutputToken: 0.5e-6 }));
    r.register(makeModel("expensive", "x", { costPerOutputToken: 10e-6 }));
    expect(r.list({ maxCostPerOutputToken: 1e-6 })).toHaveLength(1);
    expect(r.list({ maxCostPerOutputToken: 1e-6 })[0]!.id).toBe("cheap");
  });

  it("list() filters by minContextWindow", () => {
    const r = new ProviderRegistry();
    r.register(makeModel("small", "x", { contextWindow: 8192 }));
    r.register(makeModel("large", "x", { contextWindow: 200_000 }));
    expect(r.list({ minContextWindow: 100_000 })).toHaveLength(1);
    expect(r.list({ minContextWindow: 100_000 })[0]!.id).toBe("large");
  });

  it("estimateCost() computes input + output cost", () => {
    const r = new ProviderRegistry();
    r.register(makeModel("m", "x", { costPerInputToken: 1e-6, costPerOutputToken: 2e-6 }));
    expect(r.estimateCost("m", 1000, 500)).toBeCloseTo(1000 * 1e-6 + 500 * 2e-6);
  });

  it("estimateCost() returns 0 for unknown model", () => {
    expect(new ProviderRegistry().estimateCost("unknown", 100, 100)).toBe(0);
  });

  it("supportsCapability() returns correct value", () => {
    const r = new ProviderRegistry();
    r.register(
      makeModel("m", "x", {
        capabilities: {
          vision: true,
          functionCalling: false,
          streaming: true,
          promptCaching: false,
          jsonMode: true,
          systemPrompt: true,
        },
      }),
    );
    expect(r.supportsCapability("m", "vision")).toBe(true);
    expect(r.supportsCapability("m", "functionCalling")).toBe(false);
    expect(r.supportsCapability("missing", "vision")).toBe(false);
  });

  it("findCheapest() returns cheapest non-deprecated model", () => {
    const r = new ProviderRegistry();
    r.register(makeModel("cheap", "x", { costPerOutputToken: 0.1e-6 }));
    r.register(makeModel("mid", "x", { costPerOutputToken: 1e-6 }));
    r.register(makeModel("deprecated", "x", { costPerOutputToken: 0.01e-6, deprecated: true }));
    expect(r.findCheapest()!.id).toBe("cheap");
  });

  it("findLargestContext() returns model with biggest context window", () => {
    const r = new ProviderRegistry();
    r.register(makeModel("big", "x", { contextWindow: 2_000_000 }));
    r.register(makeModel("small", "x", { contextWindow: 8192 }));
    expect(r.findLargestContext()!.id).toBe("big");
  });

  it("providers() returns unique provider names", () => {
    const r = new ProviderRegistry();
    r.register(makeModel("a/1", "openai"));
    r.register(makeModel("a/2", "openai"));
    r.register(makeModel("b/1", "anthropic"));
    const p = r.providers();
    expect(p).toContain("openai");
    expect(p).toContain("anthropic");
    expect(p).toHaveLength(2);
  });
});

describe("globalRegistry", () => {
  it("contains all BUILTIN_MODELS", () => {
    for (const m of BUILTIN_MODELS) {
      expect(globalRegistry.has(m.id)).toBe(true);
    }
  });

  it("includes anthropic, openai, google, groq providers", () => {
    const providers = globalRegistry.providers();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("google");
    expect(providers).toContain("groq");
  });

  it("claude-3-5-sonnet supports vision and promptCaching", () => {
    const m = globalRegistry.get("anthropic/claude-3-5-sonnet-20241022")!;
    expect(m.capabilities.vision).toBe(true);
    expect(m.capabilities.promptCaching).toBe(true);
  });

  it("gemini-1.5-pro has largest context window", () => {
    const m = globalRegistry.findLargestContext()!;
    expect(m.contextWindow).toBeGreaterThanOrEqual(2_000_000);
  });

  it("groq/llama-3.1-8b-instant is among cheapest", () => {
    const cheapest = globalRegistry.findCheapest()!;
    expect(cheapest.costPerOutputToken).toBeLessThan(1e-6);
  });

  it("estimateCost for 1M input + 100k output with sonnet", () => {
    const cost = globalRegistry.estimateCost(
      "anthropic/claude-3-5-sonnet-20241022",
      1_000_000,
      100_000,
    );
    expect(cost).toBeCloseTo(3.0 + 1.5); // $3 input + $1.5 output
  });
});

// ── models.dev importer ─────────────────────────────────────────────────────────

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
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.id)).toContain("groq/llama-3.1-8b-instant");
  });

  it("converts per-million pricing to per-token", () => {
    expect(sonnet.costPerInputToken).toBeCloseTo(3e-6, 12);
    expect(sonnet.costPerOutputToken).toBeCloseTo(15e-6, 12);
    expect(sonnet.costPerCacheReadToken).toBeCloseTo(0.3e-6, 12);
    expect(sonnet.costPerCacheWriteToken).toBeCloseTo(3.75e-6, 12);
  });

  it("maps limits, modalities, cutoff and release date", () => {
    expect(sonnet.contextWindow).toBe(200_000);
    expect(sonnet.maxOutputTokens).toBe(8192);
    expect(sonnet.inputModalities).toEqual(["text", "image"]);
    expect(sonnet.knowledgeCutoff).toBe("2024-04");
    expect(sonnet.releaseDate).toBe("2024-10-22");
  });

  it("derives capabilities from modality / tool_call / cache_read", () => {
    expect(sonnet.capabilities.vision).toBe(true);
    expect(sonnet.capabilities.functionCalling).toBe(true);
    expect(sonnet.capabilities.promptCaching).toBe(true);
    const groq = defs.find((d) => d.id === "groq/llama-3.1-8b-instant")!;
    expect(groq.capabilities.vision).toBe(false);
    expect(groq.capabilities.promptCaching).toBe(false);
    expect(groq.costPerCacheReadToken).toBeUndefined();
  });
});

describe("registerFromModelsDev", () => {
  it("adds new models and counts them", () => {
    const reg = new ProviderRegistry();
    expect(registerFromModelsDev(reg, FIXTURE)).toBe(2);
    expect(reg.estimateCost("anthropic/claude-3-5-sonnet-20241022", 1_000_000, 0)).toBeCloseTo(
      3,
      6,
    );
  });

  it("keeps curated entries by default, overwrites only when asked", () => {
    const reg = new ProviderRegistry();
    reg.register(makeModel("anthropic/claude-3-5-sonnet-20241022", "anthropic", { name: "Curated" }));
    expect(registerFromModelsDev(reg, FIXTURE)).toBe(1); // groq added, anthropic kept
    expect(reg.get("anthropic/claude-3-5-sonnet-20241022")!.name).toBe("Curated");

    registerFromModelsDev(reg, FIXTURE, { overwrite: true });
    expect(reg.get("anthropic/claude-3-5-sonnet-20241022")!.name).toBe("Claude 3.5 Sonnet");
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
