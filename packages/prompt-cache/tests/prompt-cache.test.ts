// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  buildCachedPrompt,
  buildOpenAIPrompt,
  buildSegments,
  estimateTokens,
  estimateCacheSavings,
  cacheKey,
} from "../src/index.js";

const BASE_CFG = {
  systemPrefix: "You are a helpful assistant with access to the Nexus platform.",
  userMessage: "What is 2+2?",
};

describe("buildCachedPrompt (Anthropic)", () => {
  it("produces system array and user message", () => {
    const p = buildCachedPrompt(BASE_CFG);
    expect(p.system.length).toBeGreaterThan(0);
    expect(p.messages[0]!.role).toBe("user");
    expect(p.messages[0]!.content).toBe("What is 2+2?");
  });

  it("attaches cache_control to systemPrefix", () => {
    const p = buildCachedPrompt(BASE_CFG);
    expect(p.system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits cache_control when enableCacheControl=false", () => {
    const p = buildCachedPrompt({ ...BASE_CFG, enableCacheControl: false });
    expect(p.system[0]!.cache_control).toBeUndefined();
  });

  it("adds context as second cacheable block", () => {
    const p = buildCachedPrompt({ ...BASE_CFG, context: "Context: doc1 content" });
    expect(p.system).toHaveLength(2);
    expect(p.system[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds instruction as non-cached block", () => {
    const p = buildCachedPrompt({ ...BASE_CFG, instruction: "Be concise." });
    const instr = p.system.find((b) => b.text === "Be concise.");
    expect(instr).toBeDefined();
    expect(instr!.cache_control).toBeUndefined();
  });

  it("context + instruction produces 3 system blocks", () => {
    const p = buildCachedPrompt({ ...BASE_CFG, context: "ctx", instruction: "instr" });
    expect(p.system).toHaveLength(3);
  });
});

describe("buildOpenAIPrompt", () => {
  it("starts with system role", () => {
    const msgs = buildOpenAIPrompt(BASE_CFG);
    expect(msgs[0]!.role).toBe("system");
  });

  it("ends with user message", () => {
    const msgs = buildOpenAIPrompt(BASE_CFG);
    expect(msgs[msgs.length - 1]!.role).toBe("user");
    expect(msgs[msgs.length - 1]!.content).toBe("What is 2+2?");
  });

  it("context is included in system content", () => {
    const msgs = buildOpenAIPrompt({ ...BASE_CFG, context: "docs here" });
    expect(msgs[0]!.content).toContain("docs here");
  });
});

describe("buildSegments", () => {
  it("system_prefix is cacheable", () => {
    const segs = buildSegments(BASE_CFG);
    expect(segs.find((s) => s.type === "system_prefix")!.cacheable).toBe(true);
  });

  it("user segment is not cacheable", () => {
    const segs = buildSegments(BASE_CFG);
    expect(segs.find((s) => s.type === "user")!.cacheable).toBe(false);
  });

  it("instruction is not cacheable", () => {
    const segs = buildSegments({ ...BASE_CFG, instruction: "be brief" });
    expect(segs.find((s) => s.type === "instruction")!.cacheable).toBe(false);
  });
});

describe("estimateTokens", () => {
  it("returns ~1 token for 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("scales with length", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("estimateCacheSavings", () => {
  it("returns 0 saved tokens for 1 call", () => {
    const r = estimateCacheSavings(BASE_CFG, 1);
    expect(r.estimatedSavedTokens).toBe(0);
    expect(r.estimatedSavedUSD).toBe(0);
  });

  it("saves cacheableTokens * (n-1) for n calls", () => {
    const cfg = { ...BASE_CFG, context: "long context ".repeat(100) };
    const r = estimateCacheSavings(cfg, 10);
    expect(r.estimatedSavedTokens).toBe(r.cacheableTokens * 9);
  });

  it("cacheableTokens < totalTokens", () => {
    const r = estimateCacheSavings({ ...BASE_CFG, instruction: "instr" }, 5);
    expect(r.cacheableTokens).toBeLessThan(r.totalTokens);
  });

  it("estimatedSavedUSD is non-negative", () => {
    const r = estimateCacheSavings(BASE_CFG, 100);
    expect(r.estimatedSavedUSD).toBeGreaterThan(0);
  });
});

describe("cacheKey", () => {
  it("returns a string starting with cache:", () => {
    expect(cacheKey("prefix")).toMatch(/^cache:/);
  });

  it("same prefix produces same key", () => {
    expect(cacheKey("prefix")).toBe(cacheKey("prefix"));
  });

  it("different prefix produces different key", () => {
    expect(cacheKey("prefix-a")).not.toBe(cacheKey("prefix-b"));
  });

  it("context changes the key", () => {
    expect(cacheKey("prefix", "ctx-a")).not.toBe(cacheKey("prefix", "ctx-b"));
  });
});
