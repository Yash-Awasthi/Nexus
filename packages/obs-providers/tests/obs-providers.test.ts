// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  buildServerGenerationPrompt,
  classifyError,
  parseSkipTag,
  ClaudeObservationProvider,
  GeminiObservationProvider,
  OpenRouterObservationProvider,
  MockObservationProvider,
  ProviderRegistry,
  GENERATION_SYSTEM_PROMPT,
  type ObservationEvent,
  type GenerationRequest,
} from "../src/index.js";

function makeRequest(events: ObservationEvent[] = [], sessionId = "s-1"): GenerationRequest {
  return { sessionId, events };
}

function publicEvent(content: string, role: ObservationEvent["role"] = "user"): ObservationEvent {
  return { role, content };
}

function privateEvent(content: string): ObservationEvent {
  return { role: "user", content, isPrivate: true };
}

// ── buildServerGenerationPrompt ───────────────────────────────────────────────

describe("buildServerGenerationPrompt", () => {
  it("includes session id", () => {
    const prompt = buildServerGenerationPrompt([], "sess-42");
    expect(prompt).toContain("sess-42");
  });

  it("includes transcript for public events", () => {
    const events = [publicEvent("What is AI?")];
    const prompt = buildServerGenerationPrompt(events, "s");
    expect(prompt).toContain("What is AI?");
    expect(prompt).toContain("[USER]");
  });

  it("includes locale", () => {
    const prompt = buildServerGenerationPrompt([], "s", "fr-FR");
    expect(prompt).toContain("fr-FR");
  });

  it("emits skip instruction when all events private", () => {
    const events = [privateEvent("secret")];
    const prompt = buildServerGenerationPrompt(events, "s");
    expect(prompt).toContain("all_events_private");
  });

  it("filters private events from transcript", () => {
    const events = [publicEvent("public msg"), privateEvent("private msg")];
    const prompt = buildServerGenerationPrompt(events, "s");
    expect(prompt).toContain("public msg");
    expect(prompt).not.toContain("private msg");
  });
});

// ── GENERATION_SYSTEM_PROMPT ──────────────────────────────────────────────────

describe("GENERATION_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof GENERATION_SYSTEM_PROMPT).toBe("string");
    expect(GENERATION_SYSTEM_PROMPT.length).toBeGreaterThan(50);
  });

  it("mentions skip_summary", () => {
    expect(GENERATION_SYSTEM_PROMPT).toContain("skip_summary");
  });
});

// ── classifyError ─────────────────────────────────────────────────────────────

describe("classifyError", () => {
  it("classifies 401 as auth_invalid", () => {
    expect(classifyError("Error 401: Unauthorized")).toBe("auth_invalid");
  });

  it("classifies rate limit as rate_limited", () => {
    expect(classifyError("429 Rate limit exceeded")).toBe("rate_limited");
  });

  it("classifies quota as quota_exceeded", () => {
    expect(classifyError("Billing quota exceeded")).toBe("quota_exceeded");
  });

  it("classifies context length error", () => {
    expect(classifyError("Context length too long")).toBe("context_too_long");
  });

  it("classifies content filter error", () => {
    expect(classifyError("Content policy violation")).toBe("content_filtered");
  });

  it("classifies timeout", () => {
    expect(classifyError("Request timed out")).toBe("timeout");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(classifyError("Something random happened")).toBe("unknown");
  });
});

// ── parseSkipTag ──────────────────────────────────────────────────────────────

describe("parseSkipTag", () => {
  it("parses all_events_private", () => {
    expect(parseSkipTag('<skip_summary reason="all_events_private"/>')).toBe("all_events_private");
  });

  it("parses no_content", () => {
    expect(parseSkipTag('<skip_summary reason="no_content"/>')).toBe("no_content");
  });

  it("returns null for non-skip text", () => {
    expect(parseSkipTag("normal observation text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSkipTag("")).toBeNull();
  });
});

// ── MockObservationProvider ───────────────────────────────────────────────────

describe("MockObservationProvider", () => {
  it("returns mock observation by default", async () => {
    const provider = new MockObservationProvider();
    const result = await provider.generate(makeRequest([publicEvent("hello")]));
    expect(result.observation).toBeDefined();
    expect(result.provider).toBe("mock");
  });

  it("returns configured observation", async () => {
    const provider = new MockObservationProvider("mock", "m", { observation: "Custom observation" });
    const result = await provider.generate(makeRequest([publicEvent("test")]));
    expect(result.observation).toBe("Custom observation");
  });

  it("returns skip when skipReason configured", async () => {
    const provider = new MockObservationProvider("mock", "m", { skipReason: "all_events_private" });
    const result = await provider.generate(makeRequest([]));
    expect(result.observation).toBeNull();
    expect(result.skipReason).toBe("all_events_private");
    expect(result.skipXml).toContain("skip_summary");
  });

  it("returns error when throws configured", async () => {
    const provider = new MockObservationProvider("mock", "m", { throws: "quota exceeded" });
    const result = await provider.generate(makeRequest([]));
    expect(result.error).toContain("quota exceeded");
    expect(result.errorClass).toBe("quota_exceeded");
  });

  it("records calls", async () => {
    const provider = new MockObservationProvider();
    await provider.generate(makeRequest([publicEvent("a")]));
    await provider.generate(makeRequest([publicEvent("b")]));
    expect(provider.calls).toHaveLength(2);
  });

  it("setBehavior updates behavior at runtime", async () => {
    const provider = new MockObservationProvider();
    provider.setBehavior({ observation: "Updated" });
    const result = await provider.generate(makeRequest([]));
    expect(result.observation).toBe("Updated");
  });

  it("result includes durationMs", async () => {
    const provider = new MockObservationProvider();
    const result = await provider.generate(makeRequest([]));
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── ClaudeObservationProvider ─────────────────────────────────────────────────

describe("ClaudeObservationProvider", () => {
  it("generate calls the LLM function", async () => {
    let called = false;
    const provider = new ClaudeObservationProvider(async () => { called = true; return "observation"; });
    await provider.generate(makeRequest([publicEvent("hello")]));
    expect(called).toBe(true);
  });

  it("observation is returned on success", async () => {
    const provider = new ClaudeObservationProvider(async () => "User asked about AI.");
    const result = await provider.generate(makeRequest([publicEvent("What is AI?")]));
    expect(result.observation).toBe("User asked about AI.");
    expect(result.provider).toBe("claude");
  });

  it("handles skip_summary output", async () => {
    const provider = new ClaudeObservationProvider(
      async () => '<skip_summary reason="all_events_private"/>',
    );
    const result = await provider.generate(makeRequest([privateEvent("secret")]));
    expect(result.observation).toBeNull();
    expect(result.skipReason).toBe("all_events_private");
  });

  it("handles LLM error", async () => {
    const provider = new ClaudeObservationProvider(
      async () => { throw new Error("401 Unauthorized"); },
    );
    const result = await provider.generate(makeRequest([]));
    expect(result.errorClass).toBe("auth_invalid");
    expect(result.observation).toBeNull();
  });

  it("custom model is stored", () => {
    const provider = new ClaudeObservationProvider(async () => "", "claude-3-sonnet");
    expect(provider.model).toBe("claude-3-sonnet");
  });
});

// ── GeminiObservationProvider ─────────────────────────────────────────────────

describe("GeminiObservationProvider", () => {
  it("generate returns observation", async () => {
    const provider = new GeminiObservationProvider(async () => "Gemini result");
    const result = await provider.generate(makeRequest([publicEvent("test")]));
    expect(result.observation).toBe("Gemini result");
    expect(result.provider).toBe("gemini");
  });
});

// ── OpenRouterObservationProvider ─────────────────────────────────────────────

describe("OpenRouterObservationProvider", () => {
  it("generate returns observation", async () => {
    const provider = new OpenRouterObservationProvider(async () => "OR result");
    const result = await provider.generate(makeRequest([publicEvent("test")]));
    expect(result.observation).toBe("OR result");
    expect(result.provider).toBe("openrouter");
  });
});

// ── ProviderRegistry ──────────────────────────────────────────────────────────

describe("ProviderRegistry", () => {
  it("register and get", () => {
    const reg = new ProviderRegistry();
    const provider = new MockObservationProvider("p1");
    reg.register(provider);
    expect(reg.get("p1")).toBe(provider);
  });

  it("has and unregister", () => {
    const reg = new ProviderRegistry();
    reg.register(new MockObservationProvider("p1"));
    expect(reg.has("p1")).toBe(true);
    reg.unregister("p1");
    expect(reg.has("p1")).toBe(false);
  });

  it("list returns all providers", () => {
    const reg = new ProviderRegistry()
      .register(new MockObservationProvider("a"))
      .register(new MockObservationProvider("b"));
    expect(reg.list()).toHaveLength(2);
  });

  it("names returns provider names", () => {
    const reg = new ProviderRegistry()
      .register(new MockObservationProvider("claude"))
      .register(new MockObservationProvider("gemini"));
    expect(reg.names()).toContain("claude");
    expect(reg.names()).toContain("gemini");
  });

  it("generateWithFallback uses first successful provider", async () => {
    const failing = new MockObservationProvider("fail", "m", { throws: "error" });
    const working = new MockObservationProvider("work", "m", { observation: "Success!" });
    const reg = new ProviderRegistry().register(failing).register(working);
    const result = await reg.generateWithFallback(makeRequest([publicEvent("test")]));
    expect(result.observation).toBe("Success!");
  });

  it("generateWithFallback returns error when all fail", async () => {
    const reg = new ProviderRegistry()
      .register(new MockObservationProvider("a", "m", { throws: "fail" }));
    const result = await reg.generateWithFallback(makeRequest([]));
    expect(result.errorClass).toBe("provider_error");
  });

  it("generateWithFallback accepts skip result as success (no fallback needed)", async () => {
    const skipper = new MockObservationProvider("skipper", "m", { skipReason: "all_events_private" });
    const reg = new ProviderRegistry().register(skipper);
    const result = await reg.generateWithFallback(makeRequest([]));
    expect(result.skipReason).toBe("all_events_private");
  });
});
