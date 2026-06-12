// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { councilAdapter } from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";

function makeCtx(env: Record<string, string> = {}): IExecutionContext {
  return {
    taskId: "task-test",
    startTime: new Date(),
    attempt: 1,
    environment: env,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return response;
}

const COUNCIL_OK = {
  ok: true,
  result: {
    proposalId: "prop-001",
    title: "Buy AAPL?",
    outcome: "approved",
    votes: [],
    consensus: 2,
    dissent: 0,
    majority: "yes",
    summary: "Approved by council",
    deliberatedAt: "2024-01-01T12:00:00Z",
    totalLatencyMs: 2000,
  },
};

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("councilAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(councilAdapter.name).toBe("nexus-adapter-council"));
    it("exposes deliberation.council capability", () => {
      expect(councilAdapter.capabilities).toContain("deliberation.council");
    });
  });

  describe("canExecute()", () => {
    it("handles council.deliberate", () =>
      expect(councilAdapter.canExecute("council.deliberate")).toBe(true));
    it("handles council.evaluate", () =>
      expect(councilAdapter.canExecute("council.evaluate")).toBe(true));
    it("rejects unknown types", () =>
      expect(councilAdapter.canExecute("groq.inference")).toBe(false));
  });

  describe("execute() — council.deliberate", () => {
    it("POSTs to /deliberate and returns CouncilResponse", async () => {
      mockFetch(200, COUNCIL_OK);
      const ctx = makeCtx({ NEXUS_COUNCIL_URL: "http://council:3000" });
      const result = await councilAdapter.execute(
        {
          taskType: "council.deliberate",
          proposal: { title: "Buy AAPL?", description: "Strong earnings beat" },
        },
        ctx,
      );
      expect(result).toMatchObject({ ok: true });
      const [url, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://council:3000/deliberate");
      expect(opts.method).toBe("POST");
    });

    it("forwards budgetUsd and timeoutMs to request body", async () => {
      mockFetch(200, COUNCIL_OK);
      const ctx = makeCtx({ NEXUS_COUNCIL_URL: "http://council:3000" });
      await councilAdapter.execute(
        {
          taskType: "council.deliberate",
          proposal: { title: "Test", description: "..." },
          budgetUsd: 0.5,
          timeoutMs: 30_000,
        },
        ctx,
      );
      const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { budgetUsd: number; timeoutMs: number };
      expect(body.budgetUsd).toBe(0.5);
      expect(body.timeoutMs).toBe(30_000);
    });

    it("throws AdapterConfigError when NEXUS_COUNCIL_URL is missing", async () => {
      await expect(
        councilAdapter.execute(
          { taskType: "council.deliberate", proposal: { title: "T", description: "D" } },
          makeCtx({}),
        ),
      ).rejects.toThrow(AdapterConfigError);
    });

    it("throws AdapterHttpError on HTTP error from council service", async () => {
      mockFetch(503, "Service Unavailable");
      await expect(
        councilAdapter.execute(
          { taskType: "council.deliberate", proposal: { title: "T", description: "D" } },
          makeCtx({ NEXUS_COUNCIL_URL: "http://council:3000" }),
        ),
      ).rejects.toThrow(AdapterHttpError);
    });
  });
});
