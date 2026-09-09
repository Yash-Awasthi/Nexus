// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import type { LlmDriver, LlmRequestOptions, LlmResponse, StreamHandler } from "@nexus/llm-drivers";
import { MemoryPromptCache } from "@nexus/llm-cache";

import { CachingDriver, getLlmCacheStats, resetLlmCache } from "../../src/lib/llm-cache-driver.js";
import { getSharedKV } from "../../src/lib/shared-kv.js";
import { userContext } from "../../src/lib/user-context.js";

class FakeDriver implements LlmDriver {
  provider = "fake";
  model = "fake-model";
  calls = 0;
  streamed = 0;

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    this.calls++;
    return {
      id: `r${this.calls}`,
      content: `answer-${this.calls}`,
      model: opts.model ?? this.model,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "stop",
      durationMs: 2,
    };
  }

  async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    this.streamed++;
    await handler({ delta: "x", done: true });
    return {
      id: `s${this.streamed}`,
      content: "x",
      model: opts.model ?? this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
      durationMs: 0,
    };
  }

  countTokens(text: string): number {
    return text.length;
  }
}

/** Configurable stream behavior for the final-completion cache tests. */
class StreamFakeDriver implements LlmDriver {
  constructor(
    public provider = "fake",
    public model = "fake-model",
  ) {}
  streamed = 0;
  /** Deltas emitted per stream call (default: a clean two-delta stream). */
  deltas: string[] = ["Hel", "lo"];
  /** Thrown BEFORE emitting anything. */
  throwBeforeEmit: Error | null = null;
  /** Thrown after emitting the first delta (mid-stream abort). */
  throwAfterEmit: Error | null = null;
  /** Finish reason of the assembled response. */
  finishReason: LlmResponse["finishReason"] = "stop";
  /** Tool calls on the assembled response. */
  toolCalls: LlmResponse["toolCalls"] = undefined;

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    return this.stream(opts, () => {});
  }

  async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    this.streamed++;
    if (this.throwBeforeEmit) throw this.throwBeforeEmit;
    let content = "";
    for (const d of this.deltas) {
      content += d;
      await handler({ delta: d, done: false });
      if (this.throwAfterEmit) throw this.throwAfterEmit;
    }
    await handler({ delta: "", done: true });
    return {
      id: `s${this.streamed}`,
      content,
      model: opts.model ?? this.model,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      finishReason: this.finishReason,
      durationMs: 4,
      toolCalls: this.toolCalls,
    };
  }

  countTokens(text: string): number {
    return text.length;
  }
}

/** Collects deltas exactly like the council route's member accumulator. */
async function collectStream(
  driver: CachingDriver,
  opts: LlmRequestOptions,
): Promise<{ text: string; res: LlmResponse }> {
  let text = "";
  const res = await driver.stream(opts, (delta) => {
    if (delta.delta) text += delta.delta;
  });
  return { text, res };
}

const req = (content: string, extra: Partial<LlmRequestOptions> = {}): LlmRequestOptions => ({
  model: "fake-model",
  messages: [{ role: "user", content }],
  ...extra,
});

beforeEach(async () => {
  resetLlmCache();
  await getSharedKV().clear();
});

describe("llm-cache-driver", () => {
  it("caches the first response and serves the second from cache (zeroed usage)", async () => {
    const inner = new FakeDriver();
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    const first = await userContext.run({ userId: "u1" }, () => driver.complete(req("hello")));
    expect(inner.calls).toBe(1);
    expect(first.content).toBe("answer-1");
    expect(first.usage?.inputTokens).toBe(10);

    const second = await userContext.run({ userId: "u1" }, () => driver.complete(req("hello")));
    expect(inner.calls).toBe(1); // no second provider call
    expect(second.content).toBe("answer-1");
    expect(second.cached).toBe(true);
    expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(second.durationMs).toBe(0);
  });

  it("misses when the prompt differs (mutated prompt → fresh call)", async () => {
    const inner = new FakeDriver();
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    await userContext.run({ userId: "u1" }, () => driver.complete(req("hello")));
    const second = await userContext.run({ userId: "u1" }, () => driver.complete(req("hello?")));
    expect(inner.calls).toBe(2);
    expect(second.cached).toBeUndefined();
    expect(second.content).toBe("answer-2");
  });

  it("expires entries after the TTL", async () => {
    let now = 1_000_000;
    const inner = new FakeDriver();
    const driver = new CachingDriver(inner, 1_000, new MemoryPromptCache({ now: () => now }));

    await userContext.run({ userId: "u1" }, () => driver.complete(req("hello")));
    expect(inner.calls).toBe(1);

    now = 1_000_500; // inside TTL
    await userContext.run({ userId: "u1" }, () => driver.complete(req("hello")));
    expect(inner.calls).toBe(1);

    now = 2_000_000; // past TTL
    await userContext.run({ userId: "u1" }, () => driver.complete(req("hello")));
    expect(inner.calls).toBe(2);
  });

  it("isolates cached responses per user — u2 never sees u1's entry", async () => {
    const inner = new FakeDriver();
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    await userContext.run({ userId: "u1" }, () => driver.complete(req("shared-prompt")));
    expect(inner.calls).toBe(1);

    const u2res = await userContext.run({ userId: "u2" }, () =>
      driver.complete(req("shared-prompt")),
    );
    expect(inner.calls).toBe(2); // u2 missed — u1's entry was not served
    expect(u2res.cached).toBeUndefined();

    // u1 still hits its own entry.
    const u1again = await userContext.run({ userId: "u1" }, () =>
      driver.complete(req("shared-prompt")),
    );
    expect(inner.calls).toBe(2);
    expect(u1again.cached).toBe(true);
  });

  it("never caches tool calls, tool-role messages, or temperature > 0", async () => {
    const inner = new FakeDriver();
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    await userContext.run({ userId: "u1" }, () =>
      driver.complete(
        req("t", {
          tools: [{ name: "f", description: "d", parameters: { type: "object", properties: {} } }],
        }),
      ),
    );
    await userContext.run({ userId: "u1" }, () =>
      driver.complete(
        req("t", {
          tools: [{ name: "f", description: "d", parameters: { type: "object", properties: {} } }],
        }),
      ),
    );
    await userContext.run({ userId: "u1" }, () =>
      driver.complete({ model: "fake-model", messages: [{ role: "tool", content: "result" }] }),
    );
    await userContext.run({ userId: "u1" }, () => driver.complete(req("t", { temperature: 0.7 })));
    expect(inner.calls).toBe(4);
  });

  // ── Final-completion stream cache (council/thread path) ────────────────────

  it("stream: clean full stream is cached and replayed byte-identically without reopening a stream", async () => {
    const inner = new StreamFakeDriver();
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    const first = await userContext.run({ userId: "u1" }, () =>
      collectStream(driver, req("hello")),
    );
    expect(inner.streamed).toBe(1);
    expect(first.text).toBe("Hello"); // fully assembled from the deltas
    expect(first.res.cached).toBeUndefined();
    expect(first.res.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });

    const second = await userContext.run({ userId: "u1" }, () =>
      collectStream(driver, req("hello")),
    );
    expect(inner.streamed).toBe(1); // no second provider stream
    expect(second.text).toBe("Hello"); // byte-identical replay
    expect(second.res.cached).toBe(true);
    expect(second.res.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(second.res.durationMs).toBe(0);
  });

  it("stream: mutated prompt misses (fresh provider stream)", async () => {
    const inner = new StreamFakeDriver();
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    await userContext.run({ userId: "u1" }, () => collectStream(driver, req("hello")));
    const second = await userContext.run({ userId: "u1" }, () =>
      collectStream(driver, req("hello?")),
    );
    expect(inner.streamed).toBe(2);
    expect(second.res.cached).toBeUndefined();
    expect(second.text).toBe("Hello");
  });

  it("stream: an errored stream is never cached", async () => {
    const inner = new StreamFakeDriver();
    inner.throwBeforeEmit = new Error("provider down");
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    await expect(
      userContext.run({ userId: "u1" }, () => collectStream(driver, req("hello"))),
    ).rejects.toThrow("provider down");
    // Identical retry must hit the provider again — nothing was stored.
    await expect(
      userContext.run({ userId: "u1" }, () => collectStream(driver, req("hello"))),
    ).rejects.toThrow("provider down");
    expect(inner.streamed).toBe(2);
  });

  it("stream: a mid-stream abort (handler throws) is never cached", async () => {
    const inner = new StreamFakeDriver();
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    let text = "";
    await expect(
      userContext.run({ userId: "u1" }, () =>
        driver.stream(req("hello"), (delta) => {
          if (delta.delta) text += delta.delta;
          if (text === "Hel") throw new Error("client aborted");
        }),
      ),
    ).rejects.toThrow("client aborted");
    // Retry re-streams from the provider — the partial was never stored.
    const retry = await userContext.run({ userId: "u1" }, () =>
      collectStream(driver, req("hello")),
    );
    expect(inner.streamed).toBe(2);
    expect(retry.text).toBe("Hello");
    expect(retry.res.cached).toBeUndefined();
  });

  it("stream: tool-call finish is never stored", async () => {
    const inner = new StreamFakeDriver();
    inner.finishReason = "tool_calls";
    inner.toolCalls = [{ id: "tc1", name: "f", arguments: { q: 1 } }];
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    await userContext.run({ userId: "u1" }, () => collectStream(driver, req("hello")));
    await userContext.run({ userId: "u1" }, () => collectStream(driver, req("hello")));
    expect(inner.streamed).toBe(2); // nothing was stored
  });

  it("stream: temperature > 0 bypasses the cache (gate fires, counter observable)", async () => {
    const inner = new StreamFakeDriver();
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    await userContext.run({ userId: "u1" }, () =>
      collectStream(driver, req("hello", { temperature: 0.7 })),
    );
    await userContext.run({ userId: "u1" }, () =>
      collectStream(driver, req("hello", { temperature: 0.7 })),
    );
    expect(inner.streamed).toBe(2); // sampled output is never cached/replayed

    const stats = await getLlmCacheStats();
    expect(stats.streamHits).toBe(0);
    expect(stats.streamSkips).toBe(2);
  });

  it("stream: cache key includes provider + model + caller (isolation)", async () => {
    const innerA = new StreamFakeDriver("fake-a", "a-model");
    const innerB = new StreamFakeDriver("fake-b", "b-model");
    const dA = new CachingDriver(innerA, 60_000, new MemoryPromptCache());
    const dB = new CachingDriver(innerB, 60_000, new MemoryPromptCache());

    // Same prompt on a different provider → separate entries (never cross-served).
    await userContext.run({ userId: "u1" }, () => collectStream(dA, req("shared")));
    await userContext.run({ userId: "u1" }, () => collectStream(dB, req("shared")));
    expect(innerA.streamed).toBe(1);
    expect(innerB.streamed).toBe(1);

    // Same provider+prompt under a different caller → miss (u2 never sees u1's
    // deliberation), and u1 still hits its own entry.
    const u2 = await userContext.run({ userId: "u2" }, () => collectStream(dA, req("shared")));
    expect(innerA.streamed).toBe(2);
    expect(u2.res.cached).toBeUndefined();

    const u1again = await userContext.run({ userId: "u1" }, () => collectStream(dA, req("shared")));
    expect(innerA.streamed).toBe(2);
    expect(u1again.res.cached).toBe(true);
    expect(u1again.text).toBe("Hello");
  });

  it("stream: cross-instance hit via the shared KV (L2) and streamServedBy marker", async () => {
    const inner = new StreamFakeDriver();
    const d1 = new CachingDriver(inner, 60_000);
    await userContext.run({ userId: "u1" }, () => collectStream(d1, req("persist-stream")));
    expect(inner.streamed).toBe(1);

    // Fresh driver + fresh L1 — the L2 KV entry still serves the replay.
    const inner2 = new StreamFakeDriver();
    const d2 = new CachingDriver(inner2, 60_000);
    const hit = await userContext.run({ userId: "u1" }, () =>
      collectStream(d2, req("persist-stream")),
    );
    expect(inner2.streamed).toBe(0);
    expect(hit.res.cached).toBe(true);
    expect(hit.text).toBe("Hello");

    const stats = await getLlmCacheStats();
    expect(stats.streamHits).toBe(1);
    expect(stats.streamMisses).toBe(1);
    expect(stats.streamServedBy).toBe("fake"); // stored entry's provider
  });

  it("stream: stats ride getLlmCacheStats (hits/misses/skips + servedBy)", async () => {
    const inner = new StreamFakeDriver();
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    await userContext.run({ userId: "u1" }, () => collectStream(driver, req("a")));
    await userContext.run({ userId: "u1" }, () => collectStream(driver, req("a")));
    await userContext.run({ userId: "u1" }, () => collectStream(driver, req("b")));
    await userContext.run({ userId: "u1" }, () =>
      collectStream(driver, req("c", { temperature: 0.9 })),
    );

    const stats = await getLlmCacheStats();
    expect(stats.streamHits).toBe(1);
    expect(stats.streamMisses).toBe(2);
    expect(stats.streamSkips).toBe(1);
    expect(stats.streamServedBy).toBe("fake");
    // complete() counters are untouched by stream traffic.
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.skips).toBe(0);
  });

  it("never stores non-stop or tool-call finishes", async () => {
    const inner = new FakeDriver();
    const origComplete = inner.complete.bind(inner);
    inner.complete = async (opts) => {
      const res = await origComplete(opts);
      return {
        ...res,
        finishReason: "tool_calls",
        toolCalls: [{ id: "tc1", name: "f", arguments: "{}" }],
      };
    };
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    await userContext.run({ userId: "u1" }, () => driver.complete(req("hello")));
    await userContext.run({ userId: "u1" }, () => driver.complete(req("hello")));
    expect(inner.calls).toBe(2); // nothing was stored
  });

  it("fails open when the cache store throws", async () => {
    const inner = new FakeDriver();
    const brokenCache = {
      get: async () => {
        throw new Error("kv down");
      },
      set: async () => {
        throw new Error("kv down");
      },
      delete: async () => {},
      clear: async () => {},
      stats: async () => ({ hits: 0, misses: 0, size: 0 }),
    };
    const driver = new CachingDriver(inner, 60_000, brokenCache);

    const res = await userContext.run({ userId: "u1" }, () => driver.complete(req("hello")));
    expect(res.content).toBe("answer-1");
    expect(inner.calls).toBe(1);
  });

  it("survives across driver instances via the shared KV (L2)", async () => {
    const inner = new FakeDriver();
    const d1 = new CachingDriver(inner, 60_000);
    await userContext.run({ userId: "u1" }, () => d1.complete(req("persist-me")));
    expect(inner.calls).toBe(1);

    // Fresh driver + fresh L1 memory cache (resetLlmCache) — the L2 KV entry
    // still serves the hit.
    const inner2 = new FakeDriver();
    const d2 = new CachingDriver(inner2, 60_000);
    const res = await userContext.run({ userId: "u1" }, () => d2.complete(req("persist-me")));
    expect(inner2.calls).toBe(0);
    expect(res.cached).toBe(true);
  });

  it("reports hit/miss/skip stats", async () => {
    const inner = new FakeDriver();
    const driver = new CachingDriver(inner, 60_000, new MemoryPromptCache());

    await userContext.run({ userId: "u1" }, () => driver.complete(req("a")));
    await userContext.run({ userId: "u1" }, () => driver.complete(req("a")));
    await userContext.run({ userId: "u1" }, () => driver.complete(req("a", { temperature: 0.7 })));

    const stats = await getLlmCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.skips).toBe(1);
    expect(stats.enabled).toBe(true);
  });
});
