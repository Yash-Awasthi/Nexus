// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { groqAdapter } from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";

function makeCtx(env: Record<string, string> = {}): IExecutionContext {
  return {
    taskId: "task-test",
    startTime: new Date(),
    attempt: 1,
    environment: env,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return response;
}

const GROQ_RESPONSE = {
  id: "chatcmpl-abc",
  model: "llama-3.3-70b-versatile",
  choices: [{ message: { content: "42 is the answer." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("groqAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(groqAdapter.name).toBe("nexus-adapter-groq"));
    it("exposes llm.inference capability", () => {
      expect(groqAdapter.capabilities).toContain("llm.inference");
    });
  });

  describe("canExecute()", () => {
    it("handles groq.inference", () => expect(groqAdapter.canExecute("groq.inference")).toBe(true));
    it("handles groq.chat", () => expect(groqAdapter.canExecute("groq.chat")).toBe(true));
    it("rejects unknown types", () => expect(groqAdapter.canExecute("openai.chat")).toBe(false));
  });

  describe("execute() — groq.inference", () => {
    it("POSTs to Groq chat/completions and maps the response", async () => {
      mockFetch(200, GROQ_RESPONSE);
      const ctx = makeCtx({ GROQ_API_KEY: "gsk_test" });
      const result = (await groqAdapter.execute(
        {
          taskType: "groq.inference",
          messages: [{ role: "user", content: "What is the answer?" }],
        },
        ctx,
      )) as { content: string; model: string; finishReason: string };

      expect(result.content).toBe("42 is the answer.");
      expect(result.model).toBe("llama-3.3-70b-versatile");
      expect(result.finishReason).toBe("stop");
    });

    it("uses default model when not specified", async () => {
      mockFetch(200, GROQ_RESPONSE);
      const ctx = makeCtx({ GROQ_API_KEY: "gsk_test" });
      await groqAdapter.execute(
        { taskType: "groq.chat", messages: [{ role: "user", content: "Hello" }] },
        ctx,
      );
      const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { model: string };
      expect(body.model).toBe("llama-3.3-70b-versatile");
    });

    it("uses a custom model when provided", async () => {
      mockFetch(200, { ...GROQ_RESPONSE, model: "mixtral-8x7b-32768" });
      const ctx = makeCtx({ GROQ_API_KEY: "gsk_test" });
      await groqAdapter.execute(
        {
          taskType: "groq.inference",
          model: "mixtral-8x7b-32768",
          messages: [{ role: "user", content: "Hello" }],
        },
        ctx,
      );
      const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { model: string };
      expect(body.model).toBe("mixtral-8x7b-32768");
    });

    it("throws AdapterConfigError when GROQ_API_KEY is missing", async () => {
      await expect(
        groqAdapter.execute(
          { taskType: "groq.inference", messages: [{ role: "user", content: "test" }] },
          makeCtx({}),
        ),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on non-2xx status", async () => {
      mockFetch(429, "Rate limited");
      await expect(
        groqAdapter.execute(
          { taskType: "groq.inference", messages: [{ role: "user", content: "test" }] },
          makeCtx({ GROQ_API_KEY: "gsk_test" }),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });
});
