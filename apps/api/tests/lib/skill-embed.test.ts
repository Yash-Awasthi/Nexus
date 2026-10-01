// SPDX-License-Identifier: Apache-2.0
/**
 * Semantic skill-selection tests — local Ollama embeddings.
 *
 * Covers: cosine similarity math, the embed call (bounded, honest null on
 * failure — never throws), and the skill text used for embedding.
 */

import { describe, it, expect } from "vitest";

import {
  cosineSimilarity,
  embedTexts,
  semanticScores,
  skillEmbedText,
  type EmbedSkill,
} from "../../src/lib/skill-embed.js";

/** Fake fetch that returns one-hot vectors keyed by input index. */
function oneHotFetch(texts: string[][]): typeof fetch {
  return (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    // Same text → same vector as the task (index 0); anything else orthogonal.
    const embeddings = body.input.map((t, i) =>
      i === 0 || t === body.input[0] ? [1, 0, 0] : i % 2 === 0 ? [0, 1, 0] : [0, 0, 1],
    );
    void texts;
    return new Response(JSON.stringify({ embeddings }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors, 0 for orthogonal, 0 on mismatch", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("is scale-invariant", () => {
    expect(cosineSimilarity([1, 1], [2, 2])).toBeCloseTo(1);
  });
});

describe("skillEmbedText", () => {
  it("combines name, description, and code head", () => {
    const text = skillEmbedText({
      id: "x",
      name: "CSV Reader",
      description: "Parse CSV",
      code: "import csv\n" + "x".repeat(2000),
    });
    expect(text).toContain("CSV Reader");
    expect(text).toContain("Parse CSV");
    expect(text).toContain("import csv");
    expect(text.length).toBeLessThan(1000); // code head bounded
  });
});

describe("embedTexts", () => {
  it("returns null (never throws) when the daemon is down", async () => {
    const boom = (() => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await embedTexts(["a"], { baseUrl: "http://localhost:1", fetchFn: boom })).toBeNull();
  });

  it("returns null when no base URL is configured", async () => {
    const old = process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_BASE_URL;
    expect(await embedTexts(["a"])).toBeNull();
    if (old !== undefined) process.env.OLLAMA_BASE_URL = old;
  });

  it("returns vectors for a batch", async () => {
    const res = await embedTexts(["csv", "json"], {
      baseUrl: "http://fake",
      fetchFn: oneHotFetch([]),
    });
    expect(res).toEqual([
      [1, 0, 0],
      [0, 0, 1],
    ]);
  });

  it("returns null when the daemon answers with a mismatched batch", async () => {
    const short = (async () =>
      new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 })) as typeof fetch;
    expect(await embedTexts(["a", "b"], { baseUrl: "http://fake", fetchFn: short })).toBeNull();
  });
});

describe("semanticScores", () => {
  const skills: EmbedSkill[] = [
    { id: "csv", name: "csv", description: "", code: "" },
    { id: "uuid", name: "uuid generator", description: "", code: "" },
  ];

  it("scores the identical-text skill 1 and an unrelated one 0", async () => {
    const scores = await semanticScores(skills, "csv", {
      baseUrl: "http://fake",
      fetchFn: oneHotFetch([]),
    });
    expect(scores?.get("csv")).toBeCloseTo(1);
    expect(scores?.get("uuid")).toBe(0);
  });

  it("returns null (never throws) when embedding fails", async () => {
    const boom = (() => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await semanticScores(skills, "csv", { baseUrl: "http://x", fetchFn: boom })).toBeNull();
  });
});
