// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  BM25Reranker,
  FunctionReranker,
  NullReranker,
  rerankPipeline,
  type RankedDocument,
} from "../src/index.js";

function doc(id: string, text: string, score = 0.5): RankedDocument {
  return { id, text, score };
}

const DOCS: RankedDocument[] = [
  doc("d1", "Authentication bug in login flow causes session timeout"),
  doc("d2", "CSS styling for the homepage button colours"),
  doc("d3", "Fix authentication token expiry and session refresh logic"),
  doc("d4", "Database migration script for user tables"),
  doc("d5", "Auth middleware rewrite for OAuth2 token validation"),
];

// ── BM25Reranker ──────────────────────────────────────────────────────────────

describe("BM25Reranker", () => {
  const reranker = new BM25Reranker();

  it("returns empty result for empty documents", async () => {
    const r = await reranker.rerank("auth", []);
    expect(r.documents).toHaveLength(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns same count of documents", async () => {
    const r = await reranker.rerank("authentication", DOCS);
    expect(r.documents).toHaveLength(DOCS.length);
  });

  it("ranks authentication-related docs higher for auth query", async () => {
    const r = await reranker.rerank("authentication token", DOCS);
    const topIds = r.documents.slice(0, 3).map((d) => d.id);
    // auth-related docs (d1, d3, d5) should dominate top 3
    const authDocs = topIds.filter((id) => ["d1", "d3", "d5"].includes(id));
    expect(authDocs.length).toBeGreaterThanOrEqual(2);
  });

  it("scores are normalized to [0, 1]", async () => {
    const r = await reranker.rerank("auth", DOCS);
    for (const d of r.documents) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(1);
    }
  });

  it("topK limits results", async () => {
    const r = await reranker.rerank("auth", DOCS, { topK: 2 });
    expect(r.documents).toHaveLength(2);
  });

  it("scoreThreshold filters low-relevance docs", async () => {
    const r = await reranker.rerank("authentication", DOCS, { scoreThreshold: 0.5 });
    expect(r.documents.every((d) => d.score >= 0.5)).toBe(true);
  });

  it("result is sorted descending by score", async () => {
    const r = await reranker.rerank("database migration", DOCS);
    for (let i = 1; i < r.documents.length; i++) {
      expect(r.documents[i - 1]!.score).toBeGreaterThanOrEqual(r.documents[i]!.score);
    }
  });

  it("sets rerankedAt close to now", async () => {
    const before = Date.now();
    const r = await reranker.rerank("x", DOCS);
    expect(r.rerankedAt).toBeGreaterThanOrEqual(before);
  });

  it("single document returns score 1.0", async () => {
    const r = await reranker.rerank("auth", [doc("d1", "auth login")]);
    expect(r.documents[0]!.score).toBe(1);
  });
});

// ── FunctionReranker ──────────────────────────────────────────────────────────

describe("FunctionReranker", () => {
  it("applies custom scoring function", async () => {
    const fn = (_q: string, text: string) => text.length;
    const reranker = new FunctionReranker(fn);
    const r = await reranker.rerank("q", DOCS);
    // Should be sorted by text length descending
    for (let i = 1; i < r.documents.length; i++) {
      expect(r.documents[i - 1]!.score).toBeGreaterThanOrEqual(r.documents[i]!.score);
    }
  });

  it("passes query to scoring function", async () => {
    const received: string[] = [];
    const fn = (q: string, _text: string) => { received.push(q); return 1; };
    await new FunctionReranker(fn).rerank("test-query", [doc("d1", "hello")]);
    expect(received[0]).toBe("test-query");
  });

  it("filters by scoreThreshold", async () => {
    const fn = (_q: string, text: string) => (text.includes("auth") ? 0.9 : 0.1);
    const r = await new FunctionReranker(fn).rerank("auth", DOCS, { scoreThreshold: 0.5 });
    expect(r.documents.every((d) => d.score >= 0.5)).toBe(true);
  });

  it("respects topK", async () => {
    const r = await new FunctionReranker(() => 1).rerank("q", DOCS, { topK: 3 });
    expect(r.documents).toHaveLength(3);
  });
});

// ── NullReranker ──────────────────────────────────────────────────────────────

describe("NullReranker", () => {
  it("preserves original order", async () => {
    const r = await new NullReranker().rerank("q", DOCS);
    expect(r.documents.map((d) => d.id)).toEqual(DOCS.map((d) => d.id));
  });

  it("respects topK", async () => {
    const r = await new NullReranker().rerank("q", DOCS, { topK: 2 });
    expect(r.documents).toHaveLength(2);
    expect(r.documents[0]!.id).toBe("d1");
  });

  it("durationMs is 0", async () => {
    const r = await new NullReranker().rerank("q", DOCS);
    expect(r.durationMs).toBe(0);
  });
});

// ── rerankPipeline ────────────────────────────────────────────────────────────

describe("rerankPipeline", () => {
  const textStore = new Map([
    ["a", "authentication token refresh bug"],
    ["b", "homepage button colours"],
    ["c", "OAuth2 session token validation"],
  ]);

  it("builds documents from ids and rereanks", async () => {
    const initial = [{ id: "b", score: 0.9 }, { id: "a", score: 0.7 }, { id: "c", score: 0.5 }];
    const r = await rerankPipeline(
      "authentication token",
      initial,
      (id) => textStore.get(id) ?? "",
      new BM25Reranker(),
    );
    // auth-related a and c should rank above b
    expect(r.documents.slice(0, 2).map((d) => d.id)).not.toContain("b");
  });

  it("passes through topK", async () => {
    const initial = [{ id: "a", score: 1 }, { id: "b", score: 0.5 }];
    const r = await rerankPipeline("q", initial, (id) => textStore.get(id) ?? "", new NullReranker(), { topK: 1 });
    expect(r.documents).toHaveLength(1);
  });
});
