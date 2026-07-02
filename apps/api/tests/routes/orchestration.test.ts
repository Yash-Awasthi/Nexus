// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the orchestration compare/select guard (§6.2). The full HTTP
 * routes need a live DB; the security-relevant logic — a winner must be one of
 * the run's own candidates — is a pure exported helper.
 */
import { describe, it, expect } from "vitest";

import { isKnownCandidate } from "../../src/routes/orchestration.js";

const candidates = [
  { spec: { id: "anthropic/claude#0", model: "claude" }, diff: "d1", ok: true },
  { spec: { id: "openai/gpt#1", model: "gpt" }, diff: "d2", ok: true },
];

describe("isKnownCandidate", () => {
  it("accepts an id that belongs to the run", () => {
    expect(isKnownCandidate(candidates, "openai/gpt#1")).toBe(true);
  });

  it("rejects a free-form / unknown id", () => {
    expect(isKnownCandidate(candidates, "evil/injected")).toBe(false);
    expect(isKnownCandidate(candidates, "")).toBe(false);
  });

  it("rejects when there are no candidates", () => {
    expect(isKnownCandidate([], "anthropic/claude#0")).toBe(false);
  });

  it("tolerates malformed candidate rows without a spec", () => {
    expect(isKnownCandidate([{ diff: "x" }], "anything")).toBe(false);
  });
});
