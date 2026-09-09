// SPDX-License-Identifier: Apache-2.0
/**
 * PAT scope semantics tests (playtest round 7).
 *
 * Semantics live in lib/pat-scopes.ts (single owner): a scope names an area
 * of the product; the first dot-segment selects the area; "*"/empty/undefined
 * unlock everything (back-compat with pre-enforcement tokens); restricted
 * tokens reach only endpoints inside their areas, with segment-boundary-safe
 * prefix matching.
 */
import { describe, it, expect } from "vitest";

import { isValidPatScope, patScopesAllow } from "../../src/lib/pat-scopes.js";

describe("patScopesAllow", () => {
  it("grants everything to '*', empty, or undefined scopes (back-compat)", () => {
    expect(patScopesAllow(["*"], "/api/tokens")).toBe(true);
    expect(patScopesAllow([], "/api/tokens")).toBe(true);
    expect(patScopesAllow(undefined, "/api/tokens")).toBe(true);
  });

  it("matches the first dot-segment of a scope against its path area", () => {
    expect(patScopesAllow(["memory"], "/api/memory/entries")).toBe(true);
    expect(patScopesAllow(["memory.read"], "/api/memory/stats")).toBe(true);
    expect(patScopesAllow(["memory"], "/api/tokens")).toBe(false);
    expect(patScopesAllow(["chat", "memory"], "/api/memory/entries")).toBe(true);
  });

  it("council covers its real surfaces and segments never prefix-leak", () => {
    // /council-checkpoints is an EXPLICIT area member (real routes); the leak
    // guard is about unrelated segments — /councilor must not unlock.
    expect(patScopesAllow(["council"], "/api/council/deliberate")).toBe(true);
    expect(patScopesAllow(["council"], "/api/council-checkpoints/runs")).toBe(true);
    expect(patScopesAllow(["council"], "/api/councilor/x")).toBe(false);
  });

  it("respects segment boundaries for every area", () => {
    // /chat must not unlock /chatgpt, /tokens must not unlock /tokenized
    expect(patScopesAllow(["chat"], "/api/chat/stream")).toBe(true);
    expect(patScopesAllow(["chat"], "/api/chatgpt/stream")).toBe(false);
    expect(patScopesAllow(["tokens"], "/api/tokens/abc")).toBe(true);
    expect(patScopesAllow(["tokens"], "/api/tokenized")).toBe(false);
  });

  it("ignores query strings and case", () => {
    expect(patScopesAllow(["tokens"], "/API/TOKENS?page=2")).toBe(true);
    expect(patScopesAllow(["ab"], "/api/ab/run?model=gemini")).toBe(true);
  });
});

describe("isValidPatScope", () => {
  it("accepts known areas, '*' and dotted variants; rejects unknowns", () => {
    expect(isValidPatScope("memory")).toBe(true);
    expect(isValidPatScope("memory.read")).toBe(true);
    expect(isValidPatScope("*")).toBe(true);
    // The old UI vocabulary was never enforced — it matches no area now.
    expect(isValidPatScope("read:conversations")).toBe(false);
    expect(isValidPatScope("admin:users")).toBe(false);
    expect(isValidPatScope("nonsense")).toBe(false);
  });
});
