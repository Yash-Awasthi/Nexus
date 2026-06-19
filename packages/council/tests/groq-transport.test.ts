// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Groq SDK before importing GroqTransport so the import sees the mock.
vi.mock("groq-sdk", () => {
  const mockCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: "YES, approved. Confidence: 0.9" } }],
    model: "llama-3.3-70b-versatile",
    usage: { prompt_tokens: 80, completion_tokens: 40 },
  });
  const MockGroq = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  return { default: MockGroq };
});

import Groq from "groq-sdk";
import { GroqTransport } from "../src/groq-transport.js";

// ── GroqTransport ──────────────────────────────────────────────────────────────

describe("GroqTransport", () => {
  const FAKE_KEY = "gsk_test_1234567890abcdef";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
  });

  describe("constructor", () => {
    it("accepts an explicit apiKey", () => {
      expect(() => new GroqTransport(FAKE_KEY)).not.toThrow();
    });

    it("reads GROQ_API_KEY from env when no key passed", () => {
      process.env.GROQ_API_KEY = FAKE_KEY;
      expect(() => new GroqTransport()).not.toThrow();
    });

    it("throws when no key and no env var", () => {
      delete process.env.GROQ_API_KEY;
      expect(() => new GroqTransport()).toThrow(/GROQ_API_KEY/);
    });

    it("instantiates Groq SDK with the provided key", () => {
      new GroqTransport(FAKE_KEY);
      expect(Groq).toHaveBeenCalledWith({ apiKey: FAKE_KEY });
    });
  });

  describe("chat()", () => {
    let transport: GroqTransport;

    beforeEach(() => {
      transport = new GroqTransport(FAKE_KEY);
    });

    it("returns content from the API response", async () => {
      const result = await transport.chat([{ role: "user", content: "hello" }]);
      expect(result.content).toBe("YES, approved. Confidence: 0.9");
    });

    it("returns the model name", async () => {
      const result = await transport.chat([{ role: "user", content: "hi" }]);
      expect(result.model).toBe("llama-3.3-70b-versatile");
    });

    it("returns token usage", async () => {
      const result = await transport.chat([{ role: "user", content: "hi" }]);
      expect(result.usage.promptTokens).toBe(80);
      expect(result.usage.completionTokens).toBe(40);
    });

    it("returns a non-negative latencyMs", async () => {
      const result = await transport.chat([{ role: "user", content: "hi" }]);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("passes model option to the SDK", async () => {
      const mockGroqInstance = (Groq as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      await transport.chat([{ role: "user", content: "hi" }], { model: "gemma2-9b-it" });
      expect(mockGroqInstance.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gemma2-9b-it" }),
      );
    });

    it("passes maxTokens option to the SDK", async () => {
      const mockGroqInstance = (Groq as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      await transport.chat([{ role: "user", content: "hi" }], { maxTokens: 256 });
      expect(mockGroqInstance.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 256 }),
      );
    });

    it("handles null content in API response gracefully", async () => {
      const mockGroqInstance = (Groq as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      mockGroqInstance.chat.completions.create.mockResolvedValueOnce({
        choices: [{ message: { content: null } }],
        model: "llama-3.3-70b-versatile",
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
      const result = await transport.chat([{ role: "user", content: "hi" }]);
      expect(result.content).toBe("");
    });
  });
});
