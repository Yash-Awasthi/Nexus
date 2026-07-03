// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  InMemoryBatchStore,
  TierGate,
  JsonlSerializer,
  MockHfPublisher,
  ResearchApiRouter,
  type CorpusSample,
  type BatchFilter,
} from "../src/index.js";

function makeSample(
  tag: CorpusSample["tag"] = "preferred",
  model = "gpt-4",
): Omit<CorpusSample, "id" | "createdAt"> {
  return {
    prompt: "Explain quantum entanglement",
    completion: "Quantum entanglement is...",
    tag,
    model,
  };
}

// ── InMemoryBatchStore ─────────────────────────────────────────────────────────

describe("InMemoryBatchStore", () => {
  it("addSample stores sample", () => {
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    expect(store.pendingCount()).toBe(1);
  });

  it("flush creates batch and clears pending", () => {
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    store.addSample(makeSample("rejected"));
    const batch = store.flush("test-batch");
    expect(batch.samples).toHaveLength(2);
    expect(store.pendingCount()).toBe(0);
    expect(store.size()).toBe(1);
  });

  it("flush sets correct tier", () => {
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    const batch = store.flush("batch", "enterprise");
    expect(batch.tier).toBe("enterprise");
  });

  it("getBatch returns the batch", () => {
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    const batch = store.flush("b");
    expect(store.getBatch(batch.id)).toBeDefined();
  });

  it("listBatches with tier filter", () => {
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    store.flush("free-batch", "free");
    store.addSample(makeSample());
    store.flush("pro-batch", "pro");
    expect(store.listBatches({ tier: "pro" })).toHaveLength(1);
    expect(store.listBatches({ tier: "free" })).toHaveLength(1);
  });

  it("listBatches with limit", () => {
    const store = new InMemoryBatchStore();
    for (let i = 0; i < 5; i++) {
      store.addSample(makeSample());
      store.flush(`batch-${i}`);
    }
    expect(store.listBatches({ limit: 3 })).toHaveLength(3);
  });

  it("querySamples filters by tag", () => {
    const store = new InMemoryBatchStore();
    store.addSample(makeSample("preferred"));
    store.addSample(makeSample("rejected"));
    store.addSample(makeSample("preferred"));
    store.flush("b");
    const preferred = store.querySamples({ tags: ["preferred"] });
    expect(preferred).toHaveLength(2);
    expect(preferred.every((s) => s.tag === "preferred")).toBe(true);
  });

  it("querySamples filters by model", () => {
    const store = new InMemoryBatchStore();
    store.addSample(makeSample("preferred", "claude-3"));
    store.addSample(makeSample("preferred", "gpt-4"));
    store.flush("b");
    expect(store.querySamples({ model: "claude-3" })).toHaveLength(1);
  });

  it("markFlushed sets flushedAt", () => {
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    const batch = store.flush("b");
    store.markFlushed(batch.id);
    expect(store.getBatch(batch.id)!.flushedAt).toBeDefined();
  });

  it("clear empties store and pending", () => {
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    store.flush("b");
    store.addSample(makeSample());
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.pendingCount()).toBe(0);
  });

  it("allBatches returns all", () => {
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    store.flush("a");
    store.addSample(makeSample());
    store.flush("b");
    expect(store.allBatches()).toHaveLength(2);
  });
});

// ── TierGate ──────────────────────────────────────────────────────────────────

describe("TierGate", () => {
  const gate = new TierGate();

  it("free user passes free gate", () => {
    expect(gate.check("free", "free")).toBe(true);
  });
  it("free user fails pro gate", () => {
    expect(gate.check("pro", "free")).toBe(false);
  });
  it("pro user passes pro gate", () => {
    expect(gate.check("pro", "pro")).toBe(true);
  });
  it("pro user fails enterprise gate", () => {
    expect(gate.check("enterprise", "pro")).toBe(false);
  });
  it("enterprise user passes all gates", () => {
    expect(gate.check("free", "enterprise")).toBe(true);
    expect(gate.check("pro", "enterprise")).toBe(true);
    expect(gate.check("enterprise", "enterprise")).toBe(true);
  });

  it("requireTier throws for insufficient tier", () => {
    expect(() => gate.requireTier("pro", "free")).toThrow("Tier access denied");
  });

  it("requireTier does not throw for sufficient tier", () => {
    expect(() => gate.requireTier("free", "pro")).not.toThrow();
  });
});

// ── JsonlSerializer ───────────────────────────────────────────────────────────

describe("JsonlSerializer", () => {
  const s = new JsonlSerializer();

  function fakeSample(id: string): CorpusSample {
    return { id, prompt: "p", completion: "c", tag: "preferred", createdAt: "2026-01-01" };
  }

  it("serialize produces newline-delimited JSON", () => {
    const result = s.serialize([fakeSample("s-1"), fakeSample("s-2")]);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe("s-1");
  });

  it("deserialize parses JSONL back to samples", () => {
    const samples = [fakeSample("s-1"), fakeSample("s-2")];
    const jsonl = s.serialize(samples);
    const parsed = s.deserialize(jsonl);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.id).toBe("s-1");
  });

  it("deserialize ignores blank lines", () => {
    const jsonl = '{"id":"a","prompt":"p","completion":"c","tag":"preferred","createdAt":""}\n\n';
    expect(s.deserialize(jsonl)).toHaveLength(1);
  });

  it("round-trips correctly", () => {
    const original = [fakeSample("x"), fakeSample("y")];
    const roundTripped = s.deserialize(s.serialize(original));
    expect(roundTripped).toEqual(original);
  });
});

// ── MockHfPublisher ────────────────────────────────────────────────────────────

describe("MockHfPublisher", () => {
  it("push succeeds by default", async () => {
    const publisher = new MockHfPublisher();
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    const batch = store.flush("test");
    const result = await publisher.push(batch, "org/dataset");
    expect(result.success).toBe(true);
    expect(result.sampleCount).toBe(1);
    expect(result.url).toContain("huggingface.co");
  });

  it("push records to pushLog", async () => {
    const publisher = new MockHfPublisher();
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    const batch = store.flush("b");
    await publisher.push(batch, "org/dataset");
    expect(publisher.pushLog).toHaveLength(1);
    expect(publisher.pushLog[0]!.repoId).toBe("org/dataset");
  });

  it("push fails when throws set", async () => {
    const publisher = new MockHfPublisher();
    publisher.setThrows("HF API down");
    const store = new InMemoryBatchStore();
    store.addSample(makeSample());
    const batch = store.flush("b");
    const result = await publisher.push(batch, "org/dataset");
    expect(result.success).toBe(false);
    expect(result.error).toContain("HF API down");
  });
});

// ── ResearchApiRouter ──────────────────────────────────────────────────────────

describe("ResearchApiRouter", () => {
  function makeRouter(publisher?: MockHfPublisher) {
    const store = new InMemoryBatchStore();
    const pub = publisher ?? new MockHfPublisher();
    const router = new ResearchApiRouter({ store, publisher: pub });
    return { store, publisher: pub, router };
  }

  it("listBatches returns batches for free user", () => {
    const { store, router } = makeRouter();
    store.addSample(makeSample());
    store.flush("b");
    const response = router.listBatches({ userTier: "free" });
    expect(response.status).toBe(200);
    expect(response.data!.batches).toHaveLength(1);
    expect(response.data!.total).toBe(1);
  });

  it("readBatch returns 404 for unknown id", () => {
    const { router } = makeRouter();
    const r = router.readBatch({ userTier: "free", params: { id: "bad-id" } });
    expect(r.status).toBe(404);
  });

  it("readBatch returns batch for valid id", () => {
    const { store, router } = makeRouter();
    store.addSample(makeSample());
    const batch = store.flush("b");
    const r = router.readBatch({ userTier: "free", params: { id: batch.id } });
    expect(r.status).toBe(200);
    expect(r.data!.id).toBe(batch.id);
  });

  it("querySamples returns 403 for free user", () => {
    const { router } = makeRouter();
    const r = router.querySamples({ userTier: "free" });
    expect(r.status).toBe(403);
  });

  it("querySamples returns samples for pro user", () => {
    const { store, router } = makeRouter();
    store.addSample(makeSample("preferred"));
    store.flush("b");
    const r = router.querySamples({
      userTier: "pro",
      body: { tags: ["preferred"] } as BatchFilter,
    });
    expect(r.status).toBe(200);
    expect(r.data!.samples).toHaveLength(1);
  });

  it("flushAndPush returns 403 for pro user", async () => {
    const { router } = makeRouter();
    const r = await router.flushAndPush({ userTier: "pro" });
    expect(r.status).toBe(403);
  });

  it("flushAndPush pushes batch for enterprise user", async () => {
    const { store, router, publisher } = makeRouter();
    store.addSample(makeSample());
    const r = await router.flushAndPush({ userTier: "enterprise", body: { name: "my-batch" } });
    expect(r.status).toBe(200);
    expect(r.data!.success).toBe(true);
    expect(publisher.pushLog).toHaveLength(1);
  });

  it("downloadJsonl returns 403 for free user", () => {
    const { router } = makeRouter();
    const r = router.downloadJsonl({ userTier: "free", params: { id: "b-1" } });
    expect(r.status).toBe(403);
  });

  it("downloadJsonl returns JSONL for pro user", () => {
    const { store, router } = makeRouter();
    store.addSample(makeSample());
    const batch = store.flush("b");
    const r = router.downloadJsonl({ userTier: "pro", params: { id: batch.id } });
    expect(r.status).toBe(200);
    expect(typeof r.data).toBe("string");
    const parsed = JSON.parse(r.data!.split("\n")[0]!);
    expect(parsed.prompt).toBeDefined();
  });

  it("readBatch returns 400 when no id provided", () => {
    const { router } = makeRouter();
    const r = router.readBatch({ userTier: "free" });
    expect(r.status).toBe(400);
  });
});
