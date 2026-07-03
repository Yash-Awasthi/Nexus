// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  NullMLXBridge,
  MLXLLMProvider,
  MLXModelPersister,
  MLXError,
  NullMLXFs,
  formatChatPrompt,
  type IMLXBridge,
  type MLXModelConfig,
  type LLMMessage,
} from "../src/index.js";

const MODEL_CFG: MLXModelConfig = {
  modelPath: "mlx-community/Llama-3.2-3B-Instruct-4bit",
  contextSize: 4096,
  quantize: "4bit",
};

// ── NullMLXBridge ─────────────────────────────────────────────────────────────

describe("NullMLXBridge", () => {
  let bridge: NullMLXBridge;

  beforeEach(() => {
    bridge = new NullMLXBridge();
  });

  it("loaded is false initially", () => expect(bridge.loaded).toBe(false));
  it("modelPath is undefined initially", () => expect(bridge.modelPath).toBeUndefined());

  it("load sets loaded=true and modelPath", async () => {
    await bridge.load(MODEL_CFG);
    expect(bridge.loaded).toBe(true);
    expect(bridge.modelPath).toBe(MODEL_CFG.modelPath);
  });

  it("load records the call", async () => {
    await bridge.load(MODEL_CFG);
    expect(bridge.loadCalls).toHaveLength(1);
    expect(bridge.loadCalls[0]!.modelPath).toBe(MODEL_CFG.modelPath);
  });

  it("generate returns a result after loading", async () => {
    await bridge.load(MODEL_CFG);
    const result = await bridge.generate("Hello");
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("generate records the call", async () => {
    await bridge.load(MODEL_CFG);
    await bridge.generate("test prompt");
    expect(bridge.generateCalls[0]!.prompt).toBe("test prompt");
  });

  it("generate returns seeded response text", async () => {
    bridge.setResponse({ text: "Paris is the capital of France." });
    await bridge.load(MODEL_CFG);
    const result = await bridge.generate("What is the capital?");
    expect(result.text).toBe("Paris is the capital of France.");
  });

  it("generate throws NOT_LOADED when model not loaded", async () => {
    await expect(bridge.generate("hello")).rejects.toThrow(MLXError);
    try {
      await bridge.generate("hello");
    } catch (e) {
      expect((e as MLXError).code).toBe("NOT_LOADED");
    }
  });

  it("unload resets state", async () => {
    await bridge.load(MODEL_CFG);
    await bridge.unload();
    expect(bridge.loaded).toBe(false);
    expect(bridge.modelPath).toBeUndefined();
  });

  it("unload records call count", async () => {
    await bridge.load(MODEL_CFG);
    await bridge.unload();
    expect(bridge.unloadCalls).toHaveLength(1);
  });

  it("generate includes token counts", async () => {
    await bridge.load(MODEL_CFG);
    const result = await bridge.generate("What is 1+1?");
    expect(typeof result.promptTokens).toBe("number");
    expect(typeof result.completionTokens).toBe("number");
    expect(result.promptTokens).toBeGreaterThan(0);
  });

  it("generate includes latencyMs", async () => {
    await bridge.load(MODEL_CFG);
    const result = await bridge.generate("hello");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ── formatChatPrompt ──────────────────────────────────────────────────────────

describe("formatChatPrompt", () => {
  it("includes system message", () => {
    const msgs: LLMMessage[] = [{ role: "system", content: "You are helpful." }];
    const prompt = formatChatPrompt(msgs);
    expect(prompt).toContain("<|system|>");
    expect(prompt).toContain("You are helpful.");
  });

  it("includes user message", () => {
    const msgs: LLMMessage[] = [{ role: "user", content: "Hello!" }];
    const prompt = formatChatPrompt(msgs);
    expect(prompt).toContain("<|user|>");
    expect(prompt).toContain("Hello!");
  });

  it("includes assistant tag at end", () => {
    const msgs: LLMMessage[] = [{ role: "user", content: "Hi" }];
    const prompt = formatChatPrompt(msgs);
    expect(prompt.trim().endsWith("<|assistant|>")).toBe(true);
  });

  it("includes prior assistant turn in multi-turn", () => {
    const msgs: LLMMessage[] = [
      { role: "user", content: "What is 1+1?" },
      { role: "assistant", content: "2" },
      { role: "user", content: "And 2+2?" },
    ];
    const prompt = formatChatPrompt(msgs);
    expect(prompt).toContain("<|assistant|>\n2");
  });

  it("tool messages are included", () => {
    const msgs: LLMMessage[] = [{ role: "tool", content: "search result" }];
    const prompt = formatChatPrompt(msgs);
    expect(prompt).toContain("<|tool|>");
    expect(prompt).toContain("search result");
  });

  it("empty messages still ends with <|assistant|>", () => {
    const prompt = formatChatPrompt([]);
    expect(prompt).toContain("<|assistant|>");
  });
});

// ── MLXLLMProvider ────────────────────────────────────────────────────────────

describe("MLXLLMProvider", () => {
  let bridge: NullMLXBridge;
  let provider: MLXLLMProvider;

  beforeEach(() => {
    bridge = new NullMLXBridge();
    provider = new MLXLLMProvider(bridge, MODEL_CFG);
  });

  it("name includes model path", () => {
    expect(provider.name).toContain(MODEL_CFG.modelPath);
  });

  it("models list contains model path", () => {
    expect(provider.models).toContain(MODEL_CFG.modelPath);
  });

  it("complete auto-loads model on first call", async () => {
    await provider.complete({
      model: MODEL_CFG.modelPath,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(bridge.loaded).toBe(true);
    expect(bridge.loadCalls).toHaveLength(1);
  });

  it("complete does not reload if model already loaded", async () => {
    await bridge.load(MODEL_CFG);
    await provider.complete({
      model: MODEL_CFG.modelPath,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(bridge.loadCalls).toHaveLength(1); // loaded by us above, not again by provider
  });

  it("complete returns LLMResponse with content", async () => {
    bridge.setResponse({ text: "The answer is 42." });
    const res = await provider.complete({
      model: MODEL_CFG.modelPath,
      messages: [{ role: "user", content: "What is the answer?" }],
    });
    expect(res.content).toBe("The answer is 42.");
  });

  it("complete returns provider='mlx'", async () => {
    const res = await provider.complete({ model: MODEL_CFG.modelPath, messages: [] });
    expect(res.provider).toBe("mlx");
  });

  it("complete returns usage stats", async () => {
    const res = await provider.complete({
      model: MODEL_CFG.modelPath,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.usage?.promptTokens).toBeGreaterThan(0);
    expect(res.usage?.completionTokens).toBeGreaterThan(0);
    expect(res.usage?.totalTokens).toBe(
      (res.usage?.promptTokens ?? 0) + (res.usage?.completionTokens ?? 0),
    );
  });

  it("complete passes maxTokens to bridge", async () => {
    await provider.complete({ model: MODEL_CFG.modelPath, messages: [], maxTokens: 256 });
    expect(bridge.generateCalls[0]!.opts?.maxTokens).toBe(256);
  });

  it("complete returns latencyMs", async () => {
    const res = await provider.complete({ model: MODEL_CFG.modelPath, messages: [] });
    expect(typeof res.latencyMs).toBe("number");
  });

  it("unload delegates to bridge", async () => {
    await bridge.load(MODEL_CFG);
    await provider.unload();
    expect(bridge.loaded).toBe(false);
  });

  it("custom formatPrompt is used", async () => {
    const customFormat = (msgs: LLMMessage[]) => msgs.map((m) => m.content).join(" | ");
    const p = new MLXLLMProvider(bridge, MODEL_CFG, customFormat);
    await p.complete({ model: MODEL_CFG.modelPath, messages: [{ role: "user", content: "test" }] });
    expect(bridge.generateCalls[0]!.prompt).toBe("test");
  });
});

// ── MLXModelPersister ─────────────────────────────────────────────────────────

describe("MLXModelPersister", () => {
  let persister: MLXModelPersister;
  let fs: NullMLXFs;

  beforeEach(() => {
    persister = new MLXModelPersister();
    fs = new NullMLXFs();
  });

  it("save writes a JSON file", async () => {
    await persister.save("llama3b", MODEL_CFG, fs, "/models");
    expect(fs.files.size).toBeGreaterThan(0);
  });

  it("load returns saved config", async () => {
    await persister.save("llama3b", MODEL_CFG, fs, "/models");
    const state = await persister.load("llama3b", fs, "/models");
    expect(state?.config.modelPath).toBe(MODEL_CFG.modelPath);
  });

  it("load returns undefined for unknown key", async () => {
    const state = await persister.load("ghost", fs, "/models");
    expect(state).toBeUndefined();
  });

  it("saved state includes savedAt timestamp", async () => {
    await persister.save("m1", MODEL_CFG, fs, "/models");
    const state = await persister.load("m1", fs, "/models");
    expect(typeof state?.savedAt).toBe("number");
  });

  it("list returns saved model keys", async () => {
    await persister.save("model-a", MODEL_CFG, fs, "/models");
    await persister.save("model-b", MODEL_CFG, fs, "/models");
    const keys = await persister.list("/models", fs);
    expect(keys).toContain("model-a");
    expect(keys).toContain("model-b");
  });

  it("list returns empty array when no models saved", async () => {
    const keys = await persister.list("/empty", fs);
    expect(keys).toHaveLength(0);
  });
});

// ── MLXError ──────────────────────────────────────────────────────────────────

describe("MLXError", () => {
  it("has correct name, code, and message", () => {
    const e = new MLXError("model not found", "MODEL_NOT_FOUND");
    expect(e.name).toBe("MLXError");
    expect(e.code).toBe("MODEL_NOT_FOUND");
    expect(e instanceof Error).toBe(true);
  });
});
