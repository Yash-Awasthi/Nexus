// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  WikiStore,
  StageMetrics,
  WikiUpdatePipeline,
  type WikiDocument,
  type UpdateRequest,
} from "../src/index.js";

function makeDoc(content = "Machine learning is a subset of AI.", id = "doc-1"): WikiDocument {
  return { id, content, source: "test-source" };
}

function makeRequest(doc?: WikiDocument, dryRun = false): UpdateRequest {
  return { document: doc ?? makeDoc(), dryRun };
}

// ── WikiStore ──────────────────────────────────────────────────────────────────

describe("WikiStore", () => {
  it("create and get works", () => {
    const store = new WikiStore();
    const article = store.create("AI Basics", "AI is the future.");
    expect(store.get(article.id)).toBeDefined();
    expect(store.get(article.id)!.title).toBe("AI Basics");
  });

  it("update increments version", () => {
    const store = new WikiStore();
    const article = store.create("Title", "original");
    const updated = store.update(article.id, "updated content");
    expect(updated!.version).toBe(2);
    expect(updated!.content).toBe("updated content");
  });

  it("update returns null for missing id", () => {
    const store = new WikiStore();
    expect(store.update("nonexistent", "new")).toBeNull();
  });

  it("search returns relevant articles", () => {
    const store = new WikiStore();
    store.create("Machine Learning", "neural networks deep learning");
    store.create("Cooking Recipes", "pasta tomato sauce cooking");
    const results = store.search("neural networks machine learning");
    expect(results[0]!.title).toBe("Machine Learning");
  });

  it("search returns empty for no matches", () => {
    const store = new WikiStore();
    store.create("Cooking", "pasta sauce");
    expect(store.search("quantum physics")).toHaveLength(0);
  });

  it("reindex returns term count", () => {
    const store = new WikiStore();
    store.create("AI", "artificial intelligence machine learning");
    const terms = store.reindex();
    expect(terms).toBeGreaterThan(0);
  });

  it("delete removes article", () => {
    const store = new WikiStore();
    const a = store.create("Temp", "content");
    store.delete(a.id);
    expect(store.has(a.id)).toBe(false);
  });

  it("size reflects article count", () => {
    const store = new WikiStore();
    store.create("A", "content");
    store.create("B", "content");
    expect(store.size()).toBe(2);
  });

  it("all() returns all articles", () => {
    const store = new WikiStore();
    store.create("A", "a");
    store.create("B", "b");
    expect(store.all()).toHaveLength(2);
  });

  it("clear empties store", () => {
    const store = new WikiStore();
    store.create("X", "x");
    store.clear();
    expect(store.size()).toBe(0);
  });
});

// ── StageMetrics ───────────────────────────────────────────────────────────────

describe("StageMetrics", () => {
  it("record tracks runs", () => {
    const metrics = new StageMetrics();
    metrics.record("distill", { stage: "distill", durationMs: 10, success: true });
    metrics.record("distill", { stage: "distill", durationMs: 20, success: false });
    const stats = metrics.get("distill")!;
    expect(stats.runs).toBe(2);
    expect(stats.successes).toBe(1);
    expect(stats.failures).toBe(1);
    expect(stats.totalDurationMs).toBe(30);
  });

  it("get returns undefined for unknown stage", () => {
    const metrics = new StageMetrics();
    expect(metrics.get("unknown")).toBeUndefined();
  });

  it("all() returns all stage stats", () => {
    const metrics = new StageMetrics();
    metrics.record("a", { stage: "a", durationMs: 1, success: true });
    metrics.record("b", { stage: "b", durationMs: 2, success: true });
    expect(Object.keys(metrics.all())).toHaveLength(2);
  });

  it("clear empties metrics", () => {
    const metrics = new StageMetrics();
    metrics.record("x", { stage: "x", durationMs: 1, success: true });
    metrics.clear();
    expect(metrics.get("x")).toBeUndefined();
  });
});

// ── WikiUpdatePipeline ─────────────────────────────────────────────────────────

describe("WikiUpdatePipeline", () => {
  it("creates new article when no candidates found", async () => {
    const store = new WikiStore();
    const pipeline = new WikiUpdatePipeline({ store, autoCreate: true });
    const result = await pipeline.run(makeRequest());
    expect(result.created).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.articleId).not.toBeNull();
    expect(store.size()).toBe(1);
  });

  it("updates existing article when candidate found", async () => {
    const store = new WikiStore();
    store.create("Machine Learning", "machine learning algorithms neural");
    const pipeline = new WikiUpdatePipeline({ store, autoCreate: true });
    const result = await pipeline.run(
      makeRequest(makeDoc("machine learning deep neural networks")),
    );
    expect(result.updated).toBe(true);
    expect(result.created).toBe(false);
  });

  it("dry run does not commit changes", async () => {
    const store = new WikiStore();
    const pipeline = new WikiUpdatePipeline({ store, autoCreate: true });
    const result = await pipeline.run(makeRequest(makeDoc(), true));
    expect(result.dryRun).toBe(true);
    expect(store.size()).toBe(0); // no article created
  });

  it("runs all expected stages", async () => {
    const store = new WikiStore();
    const pipeline = new WikiUpdatePipeline({ store });
    const result = await pipeline.run(makeRequest());
    const stageNames = result.stages.map((s) => s.stage);
    expect(stageNames).toContain("distill");
    expect(stageNames).toContain("search");
    expect(stageNames).toContain("select");
    expect(stageNames).toContain("reconcile");
    expect(stageNames).toContain("nl-update");
    expect(stageNames).toContain("commit");
    expect(stageNames).toContain("reindex");
  });

  it("all stages succeed on normal run", async () => {
    const store = new WikiStore();
    const pipeline = new WikiUpdatePipeline({ store });
    const result = await pipeline.run(makeRequest());
    expect(result.stages.every((s) => s.success)).toBe(true);
  });

  it("uses custom distillFn", async () => {
    const store = new WikiStore();
    let distillCalled = false;
    const pipeline = new WikiUpdatePipeline({
      store,
      distillFn: async (content) => {
        distillCalled = true;
        return content.slice(0, 50);
      },
    });
    await pipeline.run(makeRequest());
    expect(distillCalled).toBe(true);
  });

  it("uses custom nlUpdateFn", async () => {
    const store = new WikiStore();
    let nlCalled = false;
    const pipeline = new WikiUpdatePipeline({
      store,
      nlUpdateFn: async (existing, newContent) => {
        nlCalled = true;
        return `UPDATED: ${newContent}`;
      },
    });
    await pipeline.run(makeRequest());
    expect(nlCalled).toBe(true);
    const articles = store.all();
    expect(articles[0]!.content).toContain("UPDATED:");
  });

  it("autoCreate=false does not create articles when no candidate", async () => {
    const store = new WikiStore();
    const pipeline = new WikiUpdatePipeline({ store, autoCreate: false });
    const result = await pipeline.run(makeRequest());
    expect(result.created).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("records metrics for each stage", async () => {
    const store = new WikiStore();
    const metrics = new StageMetrics();
    const pipeline = new WikiUpdatePipeline({ store, metrics });
    await pipeline.run(makeRequest());
    const allStats = metrics.all();
    expect(Object.keys(allStats).length).toBeGreaterThan(0);
    expect(allStats["distill"]!.runs).toBe(1);
  });

  it("getStore returns the wiki store", () => {
    const store = new WikiStore();
    const pipeline = new WikiUpdatePipeline({ store });
    expect(pipeline.getStore()).toBe(store);
  });

  it("getMetrics returns the stage metrics", () => {
    const store = new WikiStore();
    const pipeline = new WikiUpdatePipeline({ store });
    expect(pipeline.getMetrics()).toBeDefined();
  });

  it("durationMs is non-negative", async () => {
    const store = new WikiStore();
    const pipeline = new WikiUpdatePipeline({ store });
    const result = await pipeline.run(makeRequest());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
