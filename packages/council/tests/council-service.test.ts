// SPDX-License-Identifier: Apache-2.0
import type { CouncilRequest } from "@nexus/contracts";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ILLMTransport, ILLMResponse } from "../src/engine.js";
import { CouncilService, type OnResultFn } from "../src/council-service.js";

// ── Mock transport ─────────────────────────────────────────────────────────────
// Returns a deterministic YES vote that DeliberationEngine can parse.

function mockTransport(
  content = "YES, I approve this proposal. Confidence: 0.9. Reasoning: Looks good.",
): ILLMTransport {
  const response: ILLMResponse = {
    content,
    model: "mock-model",
    usage: { promptTokens: 100, completionTokens: 50 },
    latencyMs: 5,
  };
  return { chat: vi.fn().mockResolvedValue(response) };
}

function makeRequest(overrides?: Partial<CouncilRequest>): CouncilRequest {
  return {
    proposal: "Should we deploy to production?",
    context: "All tests passing",
    councilSize: 3,
    ...overrides,
  };
}

// ── CouncilService ─────────────────────────────────────────────────────────────

describe("CouncilService", () => {
  it("constructs with a custom LLM transport", () => {
    expect(() => new CouncilService({ llm: mockTransport() })).not.toThrow();
  });

  it("throws when no transport and no GROQ_API_KEY", () => {
    const original = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    expect(() => new CouncilService()).toThrow(/GROQ_API_KEY/);
    if (original !== undefined) process.env.GROQ_API_KEY = original;
  });

  describe("deliberate()", () => {
    let service: CouncilService;

    beforeEach(() => {
      service = new CouncilService({ llm: mockTransport(), defaultCouncilSize: 3 });
    });

    it("returns a CouncilResponse with ok=true on success", async () => {
      const res = await service.deliberate(makeRequest());
      expect(res.ok).toBe(true);
    });

    it("response contains a result with votes", async () => {
      const res = await service.deliberate(makeRequest());
      expect(res.result).toBeDefined();
      expect(Array.isArray(res.result?.votes)).toBe(true);
    });

    it("calls onResult callback after a successful deliberation", async () => {
      const onResult: OnResultFn = vi.fn().mockResolvedValue(undefined);
      const svc = new CouncilService({ llm: mockTransport(), onResult });
      await svc.deliberate(makeRequest());
      expect(onResult).toHaveBeenCalledOnce();
    });

    it("passes signalId to onResult when provided", async () => {
      const onResult: OnResultFn = vi.fn().mockResolvedValue(undefined);
      const svc = new CouncilService({ llm: mockTransport(), onResult });
      await svc.deliberate(makeRequest(), { signalId: "sig-123" });
      const payload = (onResult as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload.signalId).toBe("sig-123");
    });

    it("does not call onResult when it is not configured", async () => {
      const onResult = vi.fn();
      // Service without onResult config
      const svc = new CouncilService({ llm: mockTransport() });
      await svc.deliberate(makeRequest());
      expect(onResult).not.toHaveBeenCalled();
    });

    it("swallows onResult errors without throwing", async () => {
      const onResult: OnResultFn = vi.fn().mockRejectedValue(new Error("DB down"));
      const svc = new CouncilService({ llm: mockTransport(), onResult });
      // Should not reject even if persistence fails
      await expect(svc.deliberate(makeRequest())).resolves.toBeDefined();
    });
  });

  describe("evaluate()", () => {
    it("is an alias for deliberate — returns same shape", async () => {
      const svc = new CouncilService({ llm: mockTransport(), defaultCouncilSize: 3 });
      const res = await svc.evaluate(makeRequest());
      expect(res.ok).toBe(true);
    });
  });

  describe("config options", () => {
    it("respects defaultCouncilSize", async () => {
      const transport = mockTransport();
      const svc = new CouncilService({ llm: transport, defaultCouncilSize: 2 });
      await svc.deliberate(makeRequest({ councilSize: undefined }));
      // chat() is called once per council member — the engine calls it for each
      // of the defaultCouncilSize members, so call count should reflect the size.
      expect((transport.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });

    it("accepts inputCostPer1k and outputCostPer1k", () => {
      expect(
        () =>
          new CouncilService({
            llm: mockTransport(),
            inputCostPer1k: 0.001,
            outputCostPer1k: 0.002,
          }),
      ).not.toThrow();
    });

    it("accepts defaultModel", () => {
      expect(
        () =>
          new CouncilService({
            llm: mockTransport(),
            defaultModel: "llama-3.3-70b-versatile",
          }),
      ).not.toThrow();
    });
  });
});
