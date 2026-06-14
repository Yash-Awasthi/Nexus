// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryTokenBudget,
  KVTokenBudget,
  BudgetedLLMProvider,
  BudgetError,
  BudgetExceededError,
  type TokenBudget,
  type LLMRequest,
  type LLMResponse,
  type LLMProvider,
  type KVStoreLike,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _time = 1_000_000;
function makeNow() {
  _time = 1_000_000;
  return () => _time;
}
function advanceTime(ms: number) {
  _time += ms;
}

function makeKVStore(): KVStoreLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new Map<string, { value: any; expiresAt?: number }>();

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value as T;
    },
    async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
      const expiresAt = ttlMs && ttlMs > 0 ? Date.now() + ttlMs : undefined;
      store.set(key, { value, expiresAt });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

function makeResponse(tokens: number, overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    id: "resp-1",
    model: "gpt-4o",
    content: "response text",
    usage: { promptTokens: Math.floor(tokens * 0.4), completionTokens: Math.ceil(tokens * 0.6), totalTokens: tokens },
    provider: "openai",
    latencyMs: 100,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

function makeProvider(tokenCost: number, name = "test-provider"): LLMProvider {
  return {
    name,
    models: ["gpt-4o"],
    async complete(_req) {
      return makeResponse(tokenCost);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BudgetExceededError
// ─────────────────────────────────────────────────────────────────────────────

describe("BudgetExceededError", () => {
  it("has correct name and code", () => {
    const err = new BudgetExceededError("user-1", 900, 1000, 2_000_000);
    expect(err.name).toBe("BudgetExceededError");
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(err.identity).toBe("user-1");
    expect(err.consumed).toBe(900);
    expect(err.limit).toBe(1000);
    expect(err instanceof BudgetError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("message includes identity and token counts", () => {
    const err = new BudgetExceededError("u1", 500, 1000, 2_000_000);
    expect(err.message).toContain("u1");
    expect(err.message).toContain("500/1000");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemoryTokenBudget
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryTokenBudget", () => {
  let budget: MemoryTokenBudget;
  let now: () => number;
  const config = { limit: 1000, windowMs: 60_000 };

  beforeEach(() => {
    now = makeNow();
    budget = new MemoryTokenBudget(config, { now });
  });

  // status for unknown identity
  it("returns zeros for unknown identity", async () => {
    const s = await budget.status("new-user");
    expect(s.consumed).toBe(0);
    expect(s.remaining).toBe(1000);
    expect(s.limit).toBe(1000);
    expect(s.windowMs).toBe(60_000);
  });

  // consume
  it("consume deducts tokens and returns updated status", async () => {
    const s = await budget.consume({ identity: "u1", tokens: 300 });
    expect(s.consumed).toBe(300);
    expect(s.remaining).toBe(700);
  });

  it("multiple consumes accumulate within window", async () => {
    await budget.consume({ identity: "u1", tokens: 300 });
    await budget.consume({ identity: "u1", tokens: 400 });
    const s = await budget.status("u1");
    expect(s.consumed).toBe(700);
    expect(s.remaining).toBe(300);
  });

  it("consume at exactly the limit succeeds", async () => {
    await expect(
      budget.consume({ identity: "u1", tokens: 1000 }),
    ).resolves.toBeDefined();
    const s = await budget.status("u1");
    expect(s.remaining).toBe(0);
  });

  it("consume over limit throws BudgetExceededError", async () => {
    await budget.consume({ identity: "u1", tokens: 800 });
    await expect(
      budget.consume({ identity: "u1", tokens: 300 }),
    ).rejects.toThrow(BudgetExceededError);
  });

  it("BudgetExceededError carries correct fields", async () => {
    await budget.consume({ identity: "u1", tokens: 900 });
    try {
      await budget.consume({ identity: "u1", tokens: 200 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const e = err as BudgetExceededError;
      expect(e.identity).toBe("u1");
      expect(e.consumed).toBe(900);
      expect(e.limit).toBe(1000);
    }
  });

  // Sliding window
  it("tokens outside the window are pruned", async () => {
    await budget.consume({ identity: "u1", tokens: 800 });
    advanceTime(61_000); // past the 60s window
    // Old events pruned — fresh window
    const s = await budget.consume({ identity: "u1", tokens: 800 });
    expect(s.consumed).toBe(800);
    expect(s.remaining).toBe(200);
  });

  it("partial window rollover — old events prune, new ones stay", async () => {
    await budget.consume({ identity: "u1", tokens: 600 });
    advanceTime(30_000);
    await budget.consume({ identity: "u1", tokens: 300 });
    advanceTime(31_000); // first batch (at t=0) now expired (>60s ago), second batch (at t=30s) still within window
    const s = await budget.status("u1");
    expect(s.consumed).toBe(300);
  });

  // Multiple identities isolated
  it("different identities have independent budgets", async () => {
    await budget.consume({ identity: "alice", tokens: 900 });
    const s = await budget.consume({ identity: "bob", tokens: 900 });
    expect(s.consumed).toBe(900);
    expect(s.remaining).toBe(100);
  });

  // reset
  it("reset clears all usage for identity", async () => {
    await budget.consume({ identity: "u1", tokens: 800 });
    await budget.reset("u1");
    const s = await budget.status("u1");
    expect(s.consumed).toBe(0);
    expect(s.remaining).toBe(1000);
  });

  it("reset is no-op for unknown identity", async () => {
    await expect(budget.reset("ghost")).resolves.toBeUndefined();
  });

  // resetAt
  it("resetAt is when the oldest event expires", async () => {
    const ts = now();
    await budget.consume({ identity: "u1", tokens: 100 });
    const s = await budget.status("u1");
    expect(s.resetAt).toBe(ts + config.windowMs);
  });

  // TokenBudget interface compliance
  it("implements TokenBudget interface", () => {
    const b: TokenBudget = budget;
    expect(typeof b.consume).toBe("function");
    expect(typeof b.status).toBe("function");
    expect(typeof b.reset).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KVTokenBudget
// ─────────────────────────────────────────────────────────────────────────────

describe("KVTokenBudget", () => {
  let kv: KVStoreLike;
  let budget: KVTokenBudget;
  const config = { limit: 1000, windowMs: 60_000 };

  beforeEach(() => {
    kv = makeKVStore();
    budget = new KVTokenBudget(kv, config);
  });

  it("returns zeros for unknown identity", async () => {
    const s = await budget.status("new");
    expect(s.consumed).toBe(0);
    expect(s.remaining).toBe(1000);
  });

  it("consume stores and returns status", async () => {
    const s = await budget.consume({ identity: "u1", tokens: 400 });
    expect(s.consumed).toBe(400);
    expect(s.remaining).toBe(600);
  });

  it("multiple consumes accumulate", async () => {
    await budget.consume({ identity: "u1", tokens: 300 });
    await budget.consume({ identity: "u1", tokens: 200 });
    const s = await budget.status("u1");
    expect(s.consumed).toBe(500);
  });

  it("throws BudgetExceededError when over limit", async () => {
    await budget.consume({ identity: "u1", tokens: 900 });
    await expect(
      budget.consume({ identity: "u1", tokens: 200 }),
    ).rejects.toThrow(BudgetExceededError);
  });

  it("reset deletes KV entry", async () => {
    await budget.consume({ identity: "u1", tokens: 500 });
    await budget.reset("u1");
    const s = await budget.status("u1");
    expect(s.consumed).toBe(0);
  });

  it("different identities are isolated", async () => {
    await budget.consume({ identity: "alice", tokens: 999 });
    const s = await budget.consume({ identity: "bob", tokens: 999 });
    expect(s.consumed).toBe(999);
  });

  it("uses custom key prefix", async () => {
    const prefixedBudget = new KVTokenBudget(kv, config, { keyPrefix: "ns" });
    await prefixedBudget.consume({ identity: "u1", tokens: 100 });
    // Raw KV key should be ns:budget:u1
    const raw = await kv.get("ns:budget:u1");
    expect(raw).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BudgetedLLMProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("BudgetedLLMProvider", () => {
  let now: () => number;
  let memBudget: MemoryTokenBudget;
  let provider: BudgetedLLMProvider;

  beforeEach(() => {
    now = makeNow();
    memBudget = new MemoryTokenBudget({ limit: 1000, windowMs: 60_000 }, { now });
    provider = new BudgetedLLMProvider(makeProvider(100), memBudget);
  });

  // Name / models
  it("wraps provider name", () => {
    expect(provider.name).toBe("budgeted(test-provider)");
  });

  it("exposes inner models", () => {
    expect(provider.models).toEqual(["gpt-4o"]);
  });

  // Basic usage
  it("completes and deducts tokens", async () => {
    await provider.complete(makeRequest());
    const s = await memBudget.status("default");
    expect(s.consumed).toBe(100);
  });

  it("allows multiple calls within budget", async () => {
    for (let i = 0; i < 9; i++) {
      await provider.complete(makeRequest());
    }
    const s = await memBudget.status("default");
    expect(s.consumed).toBe(900);
  });

  it("throws BudgetExceededError when budget is fully exhausted", async () => {
    // Pre-consume all budget
    await memBudget.consume({ identity: "default", tokens: 1000 });
    await expect(provider.complete(makeRequest())).rejects.toThrow(BudgetExceededError);
  });

  // Identity extraction
  it("uses metadata.identity for per-user budgeting", async () => {
    await provider.complete(makeRequest({ metadata: { identity: "alice" } }));
    await provider.complete(makeRequest({ metadata: { identity: "bob" } }));
    const alice = await memBudget.status("alice");
    const bob = await memBudget.status("bob");
    expect(alice.consumed).toBe(100);
    expect(bob.consumed).toBe(100);
  });

  it("falls back to 'default' identity when none specified", async () => {
    await provider.complete(makeRequest());
    const s = await memBudget.status("default");
    expect(s.consumed).toBe(100);
  });

  it("custom identityFn overrides default", async () => {
    const p = new BudgetedLLMProvider(makeProvider(50), memBudget, {
      identityFn: () => "fixed-identity",
    });
    await p.complete(makeRequest());
    const s = await memBudget.status("fixed-identity");
    expect(s.consumed).toBe(50);
  });

  // Token count mode
  it("tokenCountMode: prompt counts only prompt tokens", async () => {
    const inner = makeProvider(100); // 40 prompt, 60 completion, 100 total
    const p = new BudgetedLLMProvider(inner, memBudget, { tokenCountMode: "prompt" });
    await p.complete(makeRequest());
    const s = await memBudget.status("default");
    expect(s.consumed).toBe(40);
  });

  it("tokenCountMode: completion counts only completion tokens", async () => {
    const inner = makeProvider(100); // 40 prompt, 60 completion, 100 total
    const p = new BudgetedLLMProvider(inner, memBudget, { tokenCountMode: "completion" });
    await p.complete(makeRequest());
    const s = await memBudget.status("default");
    expect(s.consumed).toBe(60);
  });

  it("tokenCountMode: total (default) counts all tokens", async () => {
    await provider.complete(makeRequest());
    const s = await memBudget.status("default");
    expect(s.consumed).toBe(100);
  });

  // tokenBudget accessor
  it("exposes tokenBudget", () => {
    expect(provider.tokenBudget).toBe(memBudget);
  });

  // Pre-flight check: exhausted budget blocks call entirely
  it("pre-flight blocks call when remaining is 0", async () => {
    const calls: number[] = [];
    const trackingInner: LLMProvider = {
      name: "tracking",
      models: ["gpt-4o"],
      async complete(_req) {
        calls.push(1);
        return makeResponse(100);
      },
    };
    await memBudget.consume({ identity: "default", tokens: 1000 });
    const p = new BudgetedLLMProvider(trackingInner, memBudget);
    await expect(p.complete(makeRequest())).rejects.toThrow(BudgetExceededError);
    expect(calls).toHaveLength(0); // never called inner
  });

  // Implements LLMProvider
  it("implements LLMProvider interface", () => {
    const p: LLMProvider = provider;
    expect(typeof p.complete).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BudgetError
// ─────────────────────────────────────────────────────────────────────────────

describe("BudgetError", () => {
  it("has correct name and code", () => {
    const err = new BudgetError("something went wrong", "GENERIC", { x: 1 });
    expect(err.name).toBe("BudgetError");
    expect(err.code).toBe("GENERIC");
    expect(err.context?.x).toBe(1);
    expect(err instanceof Error).toBe(true);
  });
});
