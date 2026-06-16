// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  MultiReviewer,
  DEFAULT_REVIEW_MODELS,
  type ReviewRequest,
  type AggregatedReview,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReviewJson(
  scores: Partial<Record<string, number>> = {},
  issues: unknown[] = [],
  summary = "Looks good",
): string {
  return JSON.stringify({
    scores: {
      correctness: scores["correctness"] ?? 8,
      readability: scores["readability"] ?? 7,
      security: scores["security"] ?? 8,
      performance: scores["performance"] ?? 7,
      overall: scores["overall"] ?? 8,
    },
    issues,
    summary,
  });
}

function mockFetch(responseBody: string, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({
      choices: [{ message: { content: responseBody } }],
    }),
  }) as unknown as typeof fetch;
}

// ── MultiReviewer ─────────────────────────────────────────────────────────────

describe("MultiReviewer", () => {
  const sampleCode = `function add(a: number, b: number): number { return a + b; }`;
  const req: ReviewRequest = { code: sampleCode, language: "typescript" };

  it("returns an AggregatedReview with correct shape", async () => {
    const fetchFn = mockFetch(makeReviewJson());
    const reviewer = new MultiReviewer({
      apiKey: "test",
      models: [DEFAULT_REVIEW_MODELS[0]!, DEFAULT_REVIEW_MODELS[1]!],
      fetchFn,
    });

    const result = await reviewer.review(req);

    expect(result.consensus).toBeDefined();
    expect(result.modelReviews).toHaveLength(2);
    expect(result.finalVerdict).toMatch(/^(approved|needs-changes|rejected)$/);
    expect(typeof result.durationMs).toBe("number");
  });

  it("approves code with high scores and no issues", async () => {
    const fetchFn = mockFetch(
      makeReviewJson({ correctness: 9, readability: 9, security: 9, performance: 9, overall: 9 }),
    );
    const reviewer = new MultiReviewer({
      apiKey: "test",
      models: [DEFAULT_REVIEW_MODELS[0]!],
      fetchFn,
    });

    const result = await reviewer.review(req);
    expect(result.finalVerdict).toBe("approved");
  });

  it("rejects code with critical issues", async () => {
    const issues = [{ severity: "critical", description: "SQL injection vulnerability on line 5" }];
    const fetchFn = mockFetch(makeReviewJson({}, issues));
    const reviewer = new MultiReviewer({
      apiKey: "test",
      models: [DEFAULT_REVIEW_MODELS[0]!],
      fetchFn,
    });

    const result = await reviewer.review(req);
    expect(result.finalVerdict).toBe("rejected");
    expect(result.criticalIssues).toHaveLength(1);
  });

  it("returns needs-changes for mediocre scores", async () => {
    const fetchFn = mockFetch(makeReviewJson({ overall: 5, correctness: 5 }));
    const reviewer = new MultiReviewer({
      apiKey: "test",
      models: [DEFAULT_REVIEW_MODELS[0]!],
      fetchFn,
    });

    const result = await reviewer.review(req);
    expect(result.finalVerdict).toBe("needs-changes");
  });

  it("detects disagreements between models", async () => {
    let callN = 0;
    const fetchFn = vi.fn().mockImplementation(async () => {
      callN++;
      const score = callN === 1 ? 9 : 3; // big spread → disagreement
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: makeReviewJson({ overall: score, correctness: score }) } },
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const reviewer = new MultiReviewer({
      apiKey: "test",
      models: [DEFAULT_REVIEW_MODELS[0]!, DEFAULT_REVIEW_MODELS[1]!],
      fetchFn,
    });

    const result = await reviewer.review(req);
    expect(result.disagreements.length).toBeGreaterThan(0);
    const dis = result.disagreements[0]!;
    expect(dis.spread).toBeGreaterThanOrEqual(3);
  });

  it("handles model failures gracefully (does not throw)", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error("Network error")) as unknown as typeof fetch;
    const reviewer = new MultiReviewer({
      apiKey: "test",
      models: [DEFAULT_REVIEW_MODELS[0]!],
      fetchFn,
      modelTimeout: 100,
    });

    await expect(reviewer.review(req)).resolves.toBeDefined();
    const result = await reviewer.review(req);
    expect(result.modelReviews[0]?.success).toBe(false);
  });

  it("handles JSON parse failure in response", async () => {
    const fetchFn = mockFetch("This is not JSON and has no structure whatsoever");
    const reviewer = new MultiReviewer({
      apiKey: "test",
      models: [DEFAULT_REVIEW_MODELS[0]!],
      fetchFn,
    });

    const result = await reviewer.review(req);
    // Should not throw, parse failure handled
    expect(result).toBeDefined();
  });

  it("aggregates issues from all models", async () => {
    const issues1 = [{ severity: "minor", description: "Missing semicolons" }];
    const issues2 = [{ severity: "major", description: "No error handling" }];

    let callN = 0;
    const fetchFn = vi.fn().mockImplementation(async () => {
      callN++;
      const issues = callN === 1 ? issues1 : issues2;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: makeReviewJson({}, issues) } }],
        }),
      };
    }) as unknown as typeof fetch;

    const reviewer = new MultiReviewer({
      apiKey: "test",
      models: [DEFAULT_REVIEW_MODELS[0]!, DEFAULT_REVIEW_MODELS[1]!],
      fetchFn,
    });

    const result = await reviewer.review(req);
    expect(result.allIssues.length).toBeGreaterThanOrEqual(2);
  });

  it("consensus score is within [0, 10]", async () => {
    const fetchFn = mockFetch(makeReviewJson({ overall: 7 }));
    const reviewer = new MultiReviewer({
      apiKey: "test",
      models: [DEFAULT_REVIEW_MODELS[0]!],
      fetchFn,
    });

    const result = await reviewer.review(req);
    for (const dim of Object.values(result.consensus)) {
      expect(dim).toBeGreaterThanOrEqual(0);
      expect(dim).toBeLessThanOrEqual(10);
    }
  });

  it("DEFAULT_REVIEW_MODELS contains expected models", () => {
    expect(DEFAULT_REVIEW_MODELS.length).toBeGreaterThan(0);
    for (const m of DEFAULT_REVIEW_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
    }
  });
});
