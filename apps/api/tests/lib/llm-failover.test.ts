// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import type { LlmDriver, LlmRequestOptions, LlmResponse, StreamHandler } from "@nexus/llm-drivers";

import {
  FailoverDriver,
  getFailoverDriver,
  getProviderSnapshot,
  getProviderStats,
  resetFailover,
  setFailoverProviders,
  type FailoverProviderEntry,
} from "../../src/lib/llm-failover.js";
import { resetLlmCache } from "../../src/lib/llm-cache-driver.js";
import { getSharedKV } from "../../src/lib/shared-kv.js";
import { userContext } from "../../src/lib/user-context.js";

class OkDriver implements LlmDriver {
  constructor(
    public provider: string,
    public model = `${provider}-model`,
  ) {}
  calls = 0;
  streamCalls = 0;
  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    this.calls++;
    return {
      id: `${this.provider}-${this.calls}`,
      content: `${this.provider}-answer`,
      model: opts.model ?? this.model,
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      finishReason: "stop",
      durationMs: 1,
    };
  }
  async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    this.streamCalls++;
    handler({ delta: `${this.provider}-delta`, done: true });
    return {
      id: `${this.provider}-s${this.streamCalls}`,
      content: `${this.provider}-delta`,
      model: opts.model ?? this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
      durationMs: 0,
    };
  }
  countTokens(t: string): number {
    return t.length;
  }
}

class FailingDriver extends OkDriver {
  error: Error;
  constructor(provider: string, message = "provider down") {
    super(provider);
    this.error = new Error(message);
  }
  async complete(): Promise<LlmResponse> {
    this.calls++;
    throw this.error;
  }
  async stream(): Promise<LlmResponse> {
    this.streamCalls++;
    throw this.error;
  }
}

/** Streams one delta, THEN throws — partial output must never be replayed. */
class EmitThenThrowDriver extends OkDriver {
  async stream(_opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    this.streamCalls++;
    handler({ delta: "partial", done: false });
    throw new Error("mid-stream failure");
  }
}

const req = (content: string): LlmRequestOptions => ({
  model: "test-model",
  messages: [{ role: "user", content }],
});

function entries(...drivers: LlmDriver[]): FailoverProviderEntry[] {
  return drivers.map((d) => ({ id: d.provider, driver: d }));
}

beforeEach(async () => {
  resetLlmCache();
  resetFailover();
  await getSharedKV().clear();
});

describe("llm-failover", () => {
  it("serves from the first provider on success — servedBy recorded, no second call", async () => {
    const a = new OkDriver("a");
    const b = new OkDriver("b");
    const d = new FailoverDriver(entries(a, b));

    const res = await userContext.run({ userId: "u1" }, () => d.complete(req("q-success")));
    expect(res.servedBy).toBe("a");
    expect(res.content).toBe("a-answer");
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
  });

  it("fails over to the next provider on error — servedBy and stats reflect it", async () => {
    const a = new FailingDriver("a", "AUTH_FAILED");
    const b = new OkDriver("b");
    setFailoverProviders(entries(a, b)); // mirror the app path (getDefaultDriver)
    const d = new FailoverDriver(entries(a, b));

    const res = await userContext.run({ userId: "u1" }, () => d.complete(req("q-failover")));
    expect(res.servedBy).toBe("b");
    expect(res.content).toBe("b-answer");
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);

    const stats = getProviderStats();
    expect(stats.providers.find((p) => p.id === "a")).toMatchObject({ attempts: 1, failures: 1 });
    expect(stats.providers.find((p) => p.id === "a")?.lastError).toContain("AUTH_FAILED");
    expect(stats.providers.find((p) => p.id === "b")).toMatchObject({ attempts: 1, failures: 0 });
    expect(stats.lastServedBy).toBe("b");
    expect(stats.order).toEqual(["a", "b"]);
  });

  it("throws the last provider error when every provider fails", async () => {
    const a = new FailingDriver("a", "err-a");
    const b = new FailingDriver("b", "err-b");
    const d = new FailoverDriver(entries(a, b));

    await expect(
      userContext.run({ userId: "u1" }, () => d.complete(req("q-all-down"))),
    ).rejects.toThrow("err-b");
    const stats = getProviderStats();
    expect(stats.providers.every((p) => p.failures === 1)).toBe(true);
  });

  it("cache composition: a cached hit short-circuits without contacting its provider", async () => {
    const a = new OkDriver("a");
    const b = new OkDriver("b");
    const d = new FailoverDriver(entries(a, b));

    // Prime A's cache while A is healthy.
    const first = await userContext.run({ userId: "u1" }, () => d.complete(req("q-cached-a")));
    expect(first.servedBy).toBe("a");

    // A goes down — the same prompt is still served from A's cache (bounded by
    // TTL, never stale past LLM_CACHE_TTL_MS), without contacting A or B.
    const aNowDown = new FailingDriver("a");
    const d2 = new FailoverDriver(entries(aNowDown, b));
    const hit = await userContext.run({ userId: "u1" }, () => d2.complete(req("q-cached-a")));
    expect(hit.cached).toBe(true);
    expect(hit.servedBy).toBe("a"); // the provider identity that owns the key
    expect(aNowDown.calls).toBe(0);
    expect(b.calls).toBe(0);
  });

  it("cache isolation across providers: a miss on A lands under B and re-hits as B", async () => {
    const a = new FailingDriver("a");
    const b = new OkDriver("b");
    const d = new FailoverDriver(entries(a, b));

    const miss = await userContext.run({ userId: "u1" }, () => d.complete(req("q-cross-provider")));
    expect(miss.servedBy).toBe("b");
    expect(miss.cached).toBeUndefined();

    // Same prompt again — B's own cache entry (B never crossed into A's key).
    const hit = await userContext.run({ userId: "u1" }, () => d.complete(req("q-cross-provider")));
    expect(hit.cached).toBe(true);
    expect(hit.servedBy).toBe("b");
    expect(b.calls).toBe(1);
  });

  it("stream fails over only when nothing was emitted yet", async () => {
    // Case 1: throws before emitting → next provider serves.
    const a = new FailingDriver("a");
    const b = new OkDriver("b");
    const d1 = new FailoverDriver(entries(a, b));
    const deltas: string[] = [];
    const res = await d1.stream(req("q-stream"), (dlt) => deltas.push(dlt.delta));
    expect(res.servedBy).toBe("b");
    expect(deltas).toEqual(["b-delta"]);

    // Case 2: emits then throws → error propagates, no replay on a fresh provider.
    const c = new EmitThenThrowDriver("c");
    const b2 = new OkDriver("b2");
    const d2 = new FailoverDriver(entries(c, b2));
    const deltas2: string[] = [];
    await expect(d2.stream(req("q-stream2"), (dlt) => deltas2.push(dlt.delta))).rejects.toThrow(
      "mid-stream failure",
    );
    expect(deltas2).toEqual(["partial"]);
    expect(b2.streamCalls).toBe(0); // never replayed
  });

  it("discovery snapshot is sourced from the live registry entries (capability gating)", () => {
    const a = new OkDriver("a");
    const streamless = new OkDriver("b") as LlmDriver;
    (streamless as { stream?: unknown }).stream = undefined;
    setFailoverProviders(entries(a, streamless));

    const snap = getProviderSnapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]).toEqual({ id: "a", provider: "a", model: "a-model", streaming: true });
    expect(snap[1]).toEqual({ id: "b", provider: "b", model: "b-model", streaming: false });
  });

  it("setFailoverProviders rebuilds the driver and the discovery list", () => {
    const a = new OkDriver("a");
    setFailoverProviders(entries(a));
    expect(getProviderSnapshot().map((p) => p.id)).toEqual(["a"]);

    const b = new OkDriver("b");
    setFailoverProviders(entries(b));
    expect(getProviderSnapshot().map((p) => p.id)).toEqual(["b"]);
    expect(getFailoverDriver()).toBeDefined();
  });
});
