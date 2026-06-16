// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  TierGateRegistry,
  TierGateError,
  globalTierGate,
  platformGates,
  makeTierGatePreHandler,
  type Tier,
} from "../src/index.js";

// ── TierGateRegistry ──────────────────────────────────────────────────────────

describe("TierGateRegistry", () => {
  it("allows ungated features for any tier", () => {
    const r = new TierGateRegistry();
    expect(r.check("nonexistent", "free")).toBe(true);
    expect(r.check("nonexistent", "enterprise")).toBe(true);
  });

  it("registers and retrieves a gate", () => {
    const r = new TierGateRegistry();
    r.register({ feature: "x", requiredTier: "pro", description: "test" });
    expect(r.get("x")).toEqual({ feature: "x", requiredTier: "pro", description: "test" });
  });

  it("overwrites existing definition on re-register", () => {
    const r = new TierGateRegistry();
    r.register({ feature: "x", requiredTier: "pro" });
    r.register({ feature: "x", requiredTier: "enterprise" });
    expect(r.get("x")?.requiredTier).toBe("enterprise");
  });

  it("check() enforces tier ordering: free < pro < enterprise", () => {
    const r = new TierGateRegistry();
    r.register({ feature: "f", requiredTier: "pro" });
    expect(r.check("f", "free")).toBe(false);
    expect(r.check("f", "pro")).toBe(true);
    expect(r.check("f", "enterprise")).toBe(true);
  });

  it("check() returns true for free-tier features at all tiers", () => {
    const r = new TierGateRegistry();
    r.register({ feature: "open", requiredTier: "free" });
    expect(r.check("open", "free")).toBe(true);
    expect(r.check("open", "enterprise")).toBe(true);
  });

  it("assert() throws TierGateError when denied", () => {
    const r = new TierGateRegistry();
    r.register({ feature: "secret", requiredTier: "enterprise" });
    expect(() => r.assert("secret", "free")).toThrow(TierGateError);
    expect(() => r.assert("secret", "pro")).toThrow(TierGateError);
  });

  it("assert() does not throw when tier is sufficient", () => {
    const r = new TierGateRegistry();
    r.register({ feature: "secret", requiredTier: "enterprise" });
    expect(() => r.assert("secret", "enterprise")).not.toThrow();
  });

  it("assert() does not throw for ungated feature", () => {
    const r = new TierGateRegistry();
    expect(() => r.assert("missing", "free")).not.toThrow();
  });

  it("list() returns all registered gates", () => {
    const r = new TierGateRegistry();
    r.register({ feature: "a", requiredTier: "free" });
    r.register({ feature: "b", requiredTier: "pro" });
    expect(r.list()).toHaveLength(2);
  });

  it("featuresForTier('free') includes only free-tier gates", () => {
    const r = new TierGateRegistry();
    r.register({ feature: "a", requiredTier: "free" });
    r.register({ feature: "b", requiredTier: "pro" });
    r.register({ feature: "c", requiredTier: "enterprise" });

    const free = r.featuresForTier("free").map((g) => g.feature);
    expect(free).toContain("a");
    expect(free).not.toContain("b");
    expect(free).not.toContain("c");
  });

  it("featuresForTier('pro') includes free and pro gates", () => {
    const r = new TierGateRegistry();
    r.register({ feature: "a", requiredTier: "free" });
    r.register({ feature: "b", requiredTier: "pro" });
    r.register({ feature: "c", requiredTier: "enterprise" });

    const pro = r.featuresForTier("pro").map((g) => g.feature);
    expect(pro).toContain("a");
    expect(pro).toContain("b");
    expect(pro).not.toContain("c");
  });

  it("featuresForTier('enterprise') includes all gates", () => {
    const r = new TierGateRegistry();
    r.register({ feature: "a", requiredTier: "free" });
    r.register({ feature: "b", requiredTier: "pro" });
    r.register({ feature: "c", requiredTier: "enterprise" });
    expect(r.featuresForTier("enterprise")).toHaveLength(3);
  });
});

// ── TierGateError ─────────────────────────────────────────────────────────────

describe("TierGateError", () => {
  it("carries feature, requiredTier, userTier, code", () => {
    const err = new TierGateError("ultraplinian", "pro", "free");
    expect(err.code).toBe("TIER_GATE_DENIED");
    expect(err.feature).toBe("ultraplinian");
    expect(err.requiredTier).toBe("pro");
    expect(err.userTier).toBe("free");
    expect(err instanceof Error).toBe(true);
  });

  it("message includes feature, requiredTier, userTier", () => {
    const err = new TierGateError("council", "enterprise", "pro");
    expect(err.message).toMatch(/council/);
    expect(err.message).toMatch(/enterprise/);
    expect(err.message).toMatch(/pro/);
  });
});

// ── globalTierGate ────────────────────────────────────────────────────────────

describe("globalTierGate", () => {
  it("contains every platform gate", () => {
    const listed = globalTierGate.list().map((g) => g.feature);
    for (const gate of platformGates) {
      expect(listed).toContain(gate.feature);
    }
  });

  it("blocks ultraplinian for free", () => {
    expect(globalTierGate.check("ultraplinian", "free")).toBe(false);
  });

  it("allows ultraplinian for pro", () => {
    expect(globalTierGate.check("ultraplinian", "pro")).toBe(true);
  });

  it("blocks council for pro", () => {
    expect(globalTierGate.check("council", "pro")).toBe(false);
  });

  it("allows council for enterprise", () => {
    expect(globalTierGate.check("council", "enterprise")).toBe(true);
  });

  it("blocks federated-search for pro", () => {
    expect(globalTierGate.check("federated-search", "pro")).toBe(false);
  });

  it("allows federated-search for enterprise", () => {
    expect(globalTierGate.check("federated-search", "enterprise")).toBe(true);
  });
});

// ── makeTierGatePreHandler ────────────────────────────────────────────────────

describe("makeTierGatePreHandler", () => {
  function makeReply() {
    const sent: { code: number; body: unknown }[] = [];
    return {
      sent,
      reply: {
        code(n: number) {
          return {
            send(body: unknown) {
              sent.push({ code: n, body });
            },
          };
        },
      },
    };
  }

  function makeRequest(tier?: Tier) {
    return { headers: tier ? { "x-nexus-tier": tier } : {} };
  }

  it("passes without reply when tier is sufficient", async () => {
    const handler = makeTierGatePreHandler({ feature: "ultraplinian" });
    const { sent, reply } = makeReply();
    await handler(makeRequest("pro"), reply);
    expect(sent).toHaveLength(0);
  });

  it("replies 403 with TIER_GATE_DENIED when tier is insufficient", async () => {
    const handler = makeTierGatePreHandler({ feature: "ultraplinian" });
    const { sent, reply } = makeReply();
    await handler(makeRequest("free"), reply);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.code).toBe(403);
    const body = sent[0]!.body as Record<string, unknown>;
    expect(body.code).toBe("TIER_GATE_DENIED");
    expect(body.feature).toBe("ultraplinian");
    expect(body.requiredTier).toBe("pro");
    expect(body.userTier).toBe("free");
  });

  it("defaults to 'free' when no x-nexus-tier header present", async () => {
    const handler = makeTierGatePreHandler({ feature: "ultraplinian" });
    const { sent, reply } = makeReply();
    await handler({}, reply);
    expect(sent[0]!.code).toBe(403);
  });

  it("uses custom getTier override", async () => {
    const handler = makeTierGatePreHandler({
      feature: "council",
      getTier: () => "enterprise",
    });
    const { sent, reply } = makeReply();
    await handler({}, reply);
    expect(sent).toHaveLength(0);
  });

  it("uses custom registry", async () => {
    const r = new TierGateRegistry();
    r.register({ feature: "my-feature", requiredTier: "enterprise" });
    const handler = makeTierGatePreHandler({ feature: "my-feature", registry: r });
    const { sent, reply } = makeReply();
    await handler(makeRequest("pro"), reply);
    expect(sent[0]!.code).toBe(403);
  });

  it("passes for ungated feature in empty registry", async () => {
    const r = new TierGateRegistry();
    const handler = makeTierGatePreHandler({ feature: "anything", registry: r });
    const { sent, reply } = makeReply();
    await handler(makeRequest("free"), reply);
    expect(sent).toHaveLength(0);
  });

  it("enterprise tier passes pro-gated feature", async () => {
    const handler = makeTierGatePreHandler({ feature: "ultraplinian" });
    const { sent, reply } = makeReply();
    await handler(makeRequest("enterprise"), reply);
    expect(sent).toHaveLength(0);
  });
});
