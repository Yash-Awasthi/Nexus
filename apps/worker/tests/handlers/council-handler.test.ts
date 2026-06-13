// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDeliberate = vi.fn();

vi.mock("@nexus/council", () => ({
  CouncilService: vi.fn().mockImplementation(() => ({
    deliberate: mockDeliberate,
  })),
}));

// council-handler.ts imports @nexus/db which throws at module-init if
// DATABASE_URL is absent — mock the db and schema to prevent that.
vi.mock("@nexus/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: "verdict-1" }]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  },
}));

vi.mock("@nexus/db/schema", () => ({
  verdicts: { id: "id" },
  councilTranscripts: {},
}));

import { handleCouncilJob, type CouncilJobPayload } from "../../src/handlers/council-handler.js";

describe("handleCouncilJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeliberate.mockResolvedValue({
      outcome: "approved",
      consensus: 0.9,
      summary: "Council approved the proposal.",
    });
  });

  it("passes the proposal to CouncilService.deliberate", async () => {
    const payload: CouncilJobPayload = {
      proposal: "Deploy new Lambda function to production",
    };

    await handleCouncilJob(payload);

    expect(mockDeliberate).toHaveBeenCalledOnce();
    const [request] = mockDeliberate.mock.calls[0] as [{ proposal: string }];
    expect(request.proposal).toBe(payload.proposal);
  });

  it("uses default timeoutMs of 60,000 when not specified", async () => {
    const payload: CouncilJobPayload = {
      proposal: "Scale down production cluster",
    };

    await handleCouncilJob(payload);

    const [request] = mockDeliberate.mock.calls[0] as [{ timeoutMs: number }];
    expect(request.timeoutMs).toBe(60_000);
  });

  it("forwards custom timeoutMs when provided", async () => {
    const payload: CouncilJobPayload = {
      proposal: "Emergency rollback",
      timeoutMs: 5_000,
    };

    await handleCouncilJob(payload);

    const [request] = mockDeliberate.mock.calls[0] as [{ timeoutMs: number }];
    expect(request.timeoutMs).toBe(5_000);
  });

  it("forwards budgetUsd when provided", async () => {
    const payload: CouncilJobPayload = {
      proposal: "Provision new instance",
      budgetUsd: 1.5,
    };

    await handleCouncilJob(payload);

    const [request] = mockDeliberate.mock.calls[0] as [{ budgetUsd?: number }];
    expect(request.budgetUsd).toBe(1.5);
  });

  it("passes signalId as context to deliberate", async () => {
    const payload: CouncilJobPayload = {
      proposal: "Approve financial report",
      signalId: "sig-abc123",
    };

    await handleCouncilJob(payload);

    const [, context] = mockDeliberate.mock.calls[0] as [unknown, { signalId?: string }];
    expect(context?.signalId).toBe("sig-abc123");
  });

  it("returns the deliberation result", async () => {
    const mockResult = { outcome: "rejected", consensus: 0.2, summary: "Too risky." };
    mockDeliberate.mockResolvedValue(mockResult);

    const result = await handleCouncilJob({ proposal: "Delete all data" });
    expect(result).toEqual(mockResult);
  });
});
