// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  FederatedConnectorRegistry,
  NullSearchConnector,
  type SearchResult,
  type SearchableConnector,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResult(id: string, title: string, source = "test", score = 0.5): SearchResult {
  return { id, title, excerpt: `Excerpt for ${title}`, source, score };
}

// ── NullSearchConnector ───────────────────────────────────────────────────────

describe("NullSearchConnector", () => {
  it("returns configured results for any query", async () => {
    const results = [makeResult("1", "Doc A"), makeResult("2", "Doc B")];
    const conn = new NullSearchConnector({ id: "null", results });
    const found = await conn.search("anything");
    expect(found).toHaveLength(2);
  });

  it("respects limit option", async () => {
    const results = [makeResult("1", "A"), makeResult("2", "B"), makeResult("3", "C")];
    const conn = new NullSearchConnector({ id: "null", results });
    expect(await conn.search("q", { limit: 2 })).toHaveLength(2);
  });

  it("stamps source = connector.id on results", async () => {
    const conn = new NullSearchConnector({
      id: "github",
      results: [makeResult("1", "PR #1", "original")],
    });
    const found = await conn.search("q");
    expect(found[0]!.source).toBe("github");
  });

  it("throws when errorMessage is configured", async () => {
    const conn = new NullSearchConnector({ id: "bad", errorMessage: "network error" });
    await expect(conn.search("q")).rejects.toThrow("network error");
  });

  it("returns empty array when no results configured", async () => {
    const conn = new NullSearchConnector({ id: "empty" });
    expect(await conn.search("q")).toEqual([]);
  });
});

// ── FederatedConnectorRegistry — basics ───────────────────────────────────────

describe("FederatedConnectorRegistry", () => {
  it("registers and lists connector ids", () => {
    const r = new FederatedConnectorRegistry();
    r.register(new NullSearchConnector({ id: "github" }));
    r.register(new NullSearchConnector({ id: "slack" }));
    expect(r.listIds()).toContain("github");
    expect(r.listIds()).toContain("slack");
    expect(r.listIds()).toHaveLength(2);
  });

  it("has() returns correct boolean", () => {
    const r = new FederatedConnectorRegistry();
    r.register(new NullSearchConnector({ id: "gh" }));
    expect(r.has("gh")).toBe(true);
    expect(r.has("missing")).toBe(false);
  });

  it("unregister() removes a connector", () => {
    const r = new FederatedConnectorRegistry();
    r.register(new NullSearchConnector({ id: "x" }));
    const removed = r.unregister("x");
    expect(removed).toBe(true);
    expect(r.has("x")).toBe(false);
  });

  it("unregister() returns false when connector not found", () => {
    const r = new FederatedConnectorRegistry();
    expect(r.unregister("nope")).toBe(false);
  });
});

// ── FederatedConnectorRegistry.search() ───────────────────────────────────────

describe("FederatedConnectorRegistry.search()", () => {
  it("returns empty results when no connectors registered", async () => {
    const r = new FederatedConnectorRegistry();
    const res = await r.search({ query: "test" });
    expect(res.results).toHaveLength(0);
    expect(res.sources).toHaveLength(0);
    expect(res.errors).toHaveLength(0);
    expect(res.totalBeforeDedup).toBe(0);
  });

  it("aggregates results from multiple connectors", async () => {
    const r = new FederatedConnectorRegistry();
    r.register(
      new NullSearchConnector({
        id: "github",
        results: [makeResult("gh-1", "GitHub Issue", "github", 0.9)],
      }),
    );
    r.register(
      new NullSearchConnector({
        id: "slack",
        results: [makeResult("sl-1", "Slack Thread", "slack", 0.7)],
      }),
    );

    const res = await r.search({ query: "test" });
    expect(res.results).toHaveLength(2);
    expect(res.sources).toContain("github");
    expect(res.sources).toContain("slack");
    expect(res.totalBeforeDedup).toBe(2);
  });

  it("sorts results by score descending", async () => {
    const r = new FederatedConnectorRegistry();
    r.register(
      new NullSearchConnector({
        id: "a",
        results: [makeResult("1", "Low", "a", 0.2), makeResult("2", "High", "a", 0.9)],
      }),
    );
    const res = await r.search({ query: "q" });
    expect(res.results[0]!.score).toBeGreaterThanOrEqual(res.results[1]!.score!);
  });

  it("deduplicates by id (default)", async () => {
    const r = new FederatedConnectorRegistry();
    // Both connectors return a result with the same id
    r.register(new NullSearchConnector({ id: "a", results: [makeResult("dup", "Doc")] }));
    r.register(new NullSearchConnector({ id: "b", results: [makeResult("dup", "Doc")] }));
    const res = await r.search({ query: "q" });
    expect(res.results).toHaveLength(1);
    expect(res.totalBeforeDedup).toBe(2);
  });

  it("deduplicates by title (case-insensitive)", async () => {
    const r = new FederatedConnectorRegistry();
    r.register(new NullSearchConnector({ id: "a", results: [makeResult("1", "Same Title")] }));
    r.register(new NullSearchConnector({ id: "b", results: [makeResult("2", "same title")] }));
    const res = await r.search({ query: "q", dedupBy: "title" });
    expect(res.results).toHaveLength(1);
  });

  it("deduplicates by url", async () => {
    const r = new FederatedConnectorRegistry();
    r.register(
      new NullSearchConnector({
        id: "a",
        results: [{ ...makeResult("1", "Doc"), url: "https://example.com/doc" }],
      }),
    );
    r.register(
      new NullSearchConnector({
        id: "b",
        results: [{ ...makeResult("2", "Doc Copy"), url: "https://example.com/doc" }],
      }),
    );
    const res = await r.search({ query: "q", dedupBy: "url" });
    expect(res.results).toHaveLength(1);
  });

  it("captures connector errors without throwing", async () => {
    const r = new FederatedConnectorRegistry();
    r.register(new NullSearchConnector({ id: "good", results: [makeResult("1", "OK")] }));
    r.register(new NullSearchConnector({ id: "bad", errorMessage: "connection refused" }));
    const res = await r.search({ query: "q" });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.source).toBe("bad");
    expect(res.errors[0]!.error).toMatch(/connection refused/);
    expect(res.results).toHaveLength(1);
  });

  it("respects limit option", async () => {
    const manyResults = Array.from({ length: 20 }, (_, i) =>
      makeResult(`r${i}`, `Result ${i}`, "src", i * 0.05),
    );
    const r = new FederatedConnectorRegistry();
    r.register(new NullSearchConnector({ id: "src", results: manyResults }));
    const res = await r.search({ query: "q", limit: 5 });
    expect(res.results).toHaveLength(5);
  });

  it("times out slow connectors and records error", async () => {
    const r = new FederatedConnectorRegistry();
    r.register(
      new NullSearchConnector({ id: "slow", delayMs: 200, results: [makeResult("1", "Late")] }),
    );
    const res = await r.search({ query: "q", timeoutMs: 50 });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.error).toMatch(/timed out/i);
    expect(res.results).toHaveLength(0);
  }, 2000);

  it("stamps source id on results", async () => {
    const r = new FederatedConnectorRegistry();
    r.register(new NullSearchConnector({ id: "github", results: [makeResult("1", "PR")] }));
    const res = await r.search({ query: "q" });
    expect(res.results[0]!.source).toBe("github");
  });

  it("includes durationMs in result", async () => {
    const r = new FederatedConnectorRegistry();
    r.register(new NullSearchConnector({ id: "fast" }));
    const res = await r.search({ query: "q" });
    expect(typeof res.durationMs).toBe("number");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});
