// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  url: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../src/bridge-manager.js", () => ({
  getBridgeManager: () => ({ url: mocks.url }),
  BridgeManager: { post: mocks.post },
}));

import type { IExecutionContext } from "../src/interfaces/execution.interface.js";
import { LocalInferenceAdapter, LocalLanguageModel } from "../src/local-inference-adapter.js";

const ctx = {
  taskId: "li-1",
  startTime: new Date(),
  attempt: 1,
  environment: {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as IExecutionContext;

beforeEach(() => {
  mocks.url.mockReset();
  mocks.post.mockReset();
  mocks.url.mockResolvedValue("http://localhost:7703");
  delete process.env.GHOSTSTACK_OFFLINE_MODE;
});

afterEach(() => {
  delete process.env.GHOSTSTACK_OFFLINE_MODE;
});

describe("LocalInferenceAdapter", () => {
  it("handles the inference task types", () => {
    const adapter = new LocalInferenceAdapter();
    expect(adapter.canExecute("inference")).toBe(true);
    expect(adapter.canExecute("local_llm")).toBe(true);
    expect(adapter.canExecute("generate")).toBe(true);
    expect(adapter.canExecute("browser")).toBe(false);
  });

  it("posts a chat payload when messages are provided", async () => {
    mocks.post.mockResolvedValue({
      success: true,
      text: "local answer",
      model: "meta-llama/Llama-3.2-3B-Instruct",
      tokens_generated: 42,
      error: "",
    });
    const adapter = new LocalInferenceAdapter({ model: "my-model" });
    const out = await adapter.execute(
      { payload: { messages: [{ role: "user", content: "hi" }], maxNewTokens: 100 } },
      ctx,
    );
    expect(out.success).toBe(true);
    expect(out.text).toBe("local answer");
    expect(out.tokensGenerated).toBe(42);
    const [, endpoint, body] = mocks.post.mock.calls[0];
    expect(endpoint).toBe("/chat");
    expect(body).toMatchObject({ model: "my-model", max_new_tokens: 100 });
  });

  it("posts a generate payload for plain prompts and falls back to the default model", async () => {
    mocks.post.mockResolvedValue({
      success: true,
      text: "gen",
      model: "meta-llama/Llama-3.2-3B-Instruct",
      tokens_generated: 5,
      error: "",
    });
    const adapter = new LocalInferenceAdapter();
    const out = await adapter.execute({ prompt: "write a poem" }, ctx);
    expect(out.success).toBe(true);
    const [, endpoint, body] = mocks.post.mock.calls[0];
    expect(endpoint).toBe("/generate");
    expect(body.model).toBe("meta-llama/Llama-3.2-3B-Instruct");
    expect(body.prompt).toBe("write a poem");
  });

  it("reports bridge errors and throws-to-success mapping", async () => {
    mocks.post.mockResolvedValueOnce({ success: false, error: "OOM", text: "", model: "", tokens_generated: 0 });
    const adapter = new LocalInferenceAdapter();
    const failed = await adapter.execute({ payload: { prompt: "p" } }, ctx);
    expect(failed.success).toBe(false);
    expect(failed.error).toBe("OOM");

    mocks.post.mockRejectedValueOnce(new Error("connection refused"));
    const thrown = await adapter.execute({ payload: { prompt: "p" } }, ctx);
    expect(thrown.success).toBe(false);
    expect(thrown.error).toBe("connection refused");
  });
});

describe("LocalLanguageModel", () => {
  it("refuses to run in offline mode", async () => {
    process.env.GHOSTSTACK_OFFLINE_MODE = "1";
    const model = new LocalLanguageModel();
    await expect(model.generateText({ messages: [] })).rejects.toThrow(/offline mode/);
  });

  it("generates text and streams it as a single chunk", async () => {
    mocks.post.mockResolvedValue({ success: true, text: "streamed answer", error: "" });
    const model = new LocalLanguageModel({ model: "custom-model" });
    expect(model.modelId).toBe("local:custom-model");
    const text = await model.generateText({ messages: [{ role: "user", content: "q" }], maxTokens: 256 });
    expect(text).toBe("streamed answer");
    const [, , body] = mocks.post.mock.calls[0];
    expect(body).toMatchObject({ model: "custom-model", max_new_tokens: 256 });

    const chunks: string[] = [];
    for await (const chunk of model.streamText({ messages: [] })) {
      chunks.push(chunk.contentChunk);
    }
    expect(chunks).toEqual(["streamed answer"]);
  });

  it("generateObject parses JSON and throws bridge failures", async () => {
    mocks.post.mockResolvedValueOnce({ success: true, text: '```json\n{"x":1}\n```', error: "" });
    const model = new LocalLanguageModel();
    expect(
      await model.generateObject<{ x: number }>({ messages: [], schema: { type: "object" } }),
    ).toEqual({ x: 1 });

    mocks.post.mockResolvedValueOnce({ success: false, text: "", error: "bridge exploded" });
    await expect(model.generateObject({ messages: [], schema: {} })).rejects.toThrow(/bridge exploded/);
  });
});
