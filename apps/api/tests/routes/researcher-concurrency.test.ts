// SPDX-License-Identifier: Apache-2.0
/** Two research requests in flight at once each get their own results. */
import { describe, it, expect, vi } from "vitest";

vi.mock("@nexus/researcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nexus/researcher")>()),
  ResearchSession: class {
    async research(query: string) {
      return {
        allResults: [{ url: `https://example.com/${query}`, title: query, snippet: "", score: 1 }],
        durationMs: 1,
      };
    }
  },
}));
// The agent awaits more work after its runner returns, as the real one does.
vi.mock("@nexus/agents", () => ({
  ResearcherAgent: class {
    constructor(
      private readonly cfg: {
        runner: (q: string) => Promise<{ report: string; sources: string[] }>;
      },
    ) {}
    async research(query: string) {
      const r = await this.cfg.runner(query);
      await new Promise((res) => setTimeout(res, query === "slow" ? 50 : 0));
      return { report: r.report, sources: r.sources };
    }
  },
}));

const { researchWithResults } = await import("../../src/routes/researcher.js");

describe("researchWithResults", () => {
  it("keeps each call's results to that call", async () => {
    const [slow, fast] = await Promise.all([
      researchWithResults("slow"),
      researchWithResults("fast"),
    ]);
    expect(slow.allResults[0]!.url).toBe("https://example.com/slow");
    expect(fast.allResults[0]!.url).toBe("https://example.com/fast");
  });
});
