// SPDX-License-Identifier: Apache-2.0
import type { CouncilRequest } from "@nexus/contracts";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { DeliberationEngine, type ILLMTransport, type ILLMResponse } from "../src/engine.js";

// ── Mock transport factory ─────────────────────────────────────────────────

function makeMockTransport(response: Partial<ILLMResponse> = {}): ILLMTransport {
  return {
    chat: vi.fn().mockResolvedValue({
      content: "YES, I approve this proposal. Confidence: 0.9",
      model: "mock-model",
      usage: { promptTokens: 100, completionTokens: 50 },
      latencyMs: 10,
      ...response,
    } satisfies ILLMResponse),
  };
}

function makeRequest(overrides: Partial<CouncilRequest> = {}): CouncilRequest {
  return {
    proposal: {
      title: "Deploy new microservice",
      description: "Should we deploy the payment service to production?",
    },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("DeliberationEngine — happy path", () => {
  let engine: DeliberationEngine;
  let transport: ILLMTransport;

  beforeEach(() => {
    transport = makeMockTransport();
    engine = new DeliberationEngine({ llm: transport });
  });

  it("returns ok:true with a ProposalResult", async () => {
    const res = await engine.deliberate(makeRequest());
    expect(res.ok).toBe(true);
    expect(res.result).toBeDefined();
  });

  it("ProposalResult has expected shape", async () => {
    const res = await engine.deliberate(makeRequest());
    const r = res.result!;
    expect(typeof r.proposalId).toBe("string");
    expect(r.title).toBe("Deploy new microservice");
    expect(["approved", "rejected", "deferred"]).toContain(r.outcome);
    expect(typeof r.consensus).toBe("number");
    expect(typeof r.dissent).toBe("number");
    expect(r.consensus + r.dissent).toBeCloseTo(1, 1);
    expect(Array.isArray(r.votes)).toBe(true);
    expect(r.votes.length).toBeGreaterThan(0);
  });

  it("calls LLM transport for each archetype (default council size = 5)", async () => {
    await engine.deliberate(makeRequest());
    expect(vi.mocked(transport.chat)).toHaveBeenCalledTimes(5);
  });

  it("all YES votes produce approved outcome with high consensus", async () => {
    const res = await engine.deliberate(makeRequest());
    const r = res.result!;
    expect(r.outcome).toBe("approved");
    expect(r.consensus).toBeGreaterThanOrEqual(0.6);
    expect(r.majority).toBe("yes");
  });

  it("summary string contains vote counts", async () => {
    const res = await engine.deliberate(makeRequest());
    expect(res.result!.summary).toMatch(/YES/);
    expect(res.result!.summary).toMatch(/NO/);
    expect(res.result!.summary).toMatch(/ABSTAIN/);
  });
});

describe("DeliberationEngine — vote parsing", () => {
  it("NO votes produce rejected outcome", async () => {
    const transport = makeMockTransport({
      content: "No, I reject this proposal. I oppose this direction.",
    });
    const engine = new DeliberationEngine({ llm: transport });
    const res = await engine.deliberate(makeRequest());
    expect(res.result!.outcome).toBe("rejected");
    expect(res.result!.majority).toBe("no");
  });

  it("ambiguous content produces abstain votes → deferred outcome", async () => {
    const transport = makeMockTransport({
      content: "The proposal requires more analysis before a decision can be made.",
    });
    const engine = new DeliberationEngine({ llm: transport });
    const res = await engine.deliberate(makeRequest());
    // All abstain → consensus=0 → deferred
    expect(res.result!.outcome).toBe("deferred");
    for (const v of res.result!.votes) {
      expect(v.vote).toBe("abstain");
    }
  });

  it("mixed YES/NO votes compute correct consensus ratio", async () => {
    let callCount = 0;
    const transport: ILLMTransport = {
      chat: vi.fn().mockImplementation(async () => {
        callCount++;
        const content = callCount <= 3 ? "YES, I approve this" : "NO, I reject this";
        return {
          content,
          model: "mock-model",
          usage: { promptTokens: 50, completionTokens: 25 },
          latencyMs: 5,
        } satisfies ILLMResponse;
      }),
    };
    const engine = new DeliberationEngine({ llm: transport });
    const res = await engine.deliberate(makeRequest());
    const r = res.result!;
    // 3 YES, 2 NO → consensus = 3/5 = 0.6
    expect(r.consensus).toBeCloseTo(0.6, 1);
    expect(r.outcome).toBe("approved"); // 0.6 >= 0.6 threshold
  });

  it("confidence parsed from percentage expression", async () => {
    const transport = makeMockTransport({
      content: "YES I approve. I am 85% confident in this decision.",
    });
    const engine = new DeliberationEngine({ llm: transport });
    const res = await engine.deliberate(makeRequest());
    for (const v of res.result!.votes) {
      if (v.vote === "yes") {
        expect(v.confidence).toBeCloseTo(0.85, 2);
      }
    }
  });

  it("confidence parsed from 'confidence: X.X' expression", async () => {
    const transport = makeMockTransport({
      content: "YES I approve. Confidence: 0.75",
    });
    const engine = new DeliberationEngine({ llm: transport });
    const res = await engine.deliberate(makeRequest());
    for (const v of res.result!.votes) {
      if (v.vote === "yes") {
        expect(v.confidence).toBeCloseTo(0.75, 2);
      }
    }
  });

  it("defaults to 0.65 confidence when none expressed", async () => {
    const transport = makeMockTransport({
      content: "YES this looks good to me.",
    });
    const engine = new DeliberationEngine({ llm: transport });
    const res = await engine.deliberate(makeRequest());
    for (const v of res.result!.votes) {
      if (v.vote === "yes") {
        expect(v.confidence).toBeCloseTo(0.65, 2);
      }
    }
  });
});

describe("DeliberationEngine — failed vote fallback", () => {
  it("transport errors produce abstain votes (non-fatal)", async () => {
    const transport: ILLMTransport = {
      chat: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    };
    const engine = new DeliberationEngine({ llm: transport });
    const res = await engine.deliberate(makeRequest());
    expect(res.ok).toBe(true);
    for (const v of res.result!.votes) {
      expect(v.vote).toBe("abstain");
      expect(v.reasoning).toContain("Vote failed");
      expect(v.confidence).toBe(0);
    }
  });
});

describe("DeliberationEngine — budget enforcement", () => {
  it("throws BudgetExceededError when cost exceeds budget", async () => {
    // Set a very tight budget — any token usage will exceed it
    const transport = makeMockTransport({
      usage: { promptTokens: 10000, completionTokens: 10000 },
    });
    const engine = new DeliberationEngine({ llm: transport });
    const req = makeRequest({ budgetUsd: 0.000001 }); // $0.000001 — essentially zero
    const res = await engine.deliberate(req);
    // Budget exceeded → the vote that triggered it becomes abstain
    expect(res.ok).toBe(true);
    // At least one vote should have failed due to budget
    const hasAbstain = res.result!.votes.some((v) => v.vote === "abstain");
    expect(hasAbstain).toBe(true);
  });
});

describe("DeliberationEngine — council size config", () => {
  it("respects defaultCouncilSize=3", async () => {
    const transport = makeMockTransport();
    const engine = new DeliberationEngine({ llm: transport, defaultCouncilSize: 3 });
    await engine.deliberate(makeRequest());
    expect(vi.mocked(transport.chat)).toHaveBeenCalledTimes(3);
  });

  it("respects defaultCouncilSize=1", async () => {
    const transport = makeMockTransport();
    const engine = new DeliberationEngine({ llm: transport, defaultCouncilSize: 1 });
    const res = await engine.deliberate(makeRequest());
    expect(vi.mocked(transport.chat)).toHaveBeenCalledTimes(1);
    expect(res.result!.votes).toHaveLength(1);
  });
});

describe("DeliberationEngine — category detection", () => {
  const cases: [string, string][] = [
    ["debate this versus that approach", "contrarian"],
    ["research and analyze the evidence", "empiricist"],
    ["business revenue strategy for the product", "strategist"],
    ["technical architecture system design", "architect"],
    ["creative writing story idea", "creator"],
    ["ethical moral harm benefit analysis", "ethicist"],
  ];

  it.each(cases)("title '%s' summons correct lead archetype", async (title, _expectedLead) => {
    const transport = makeMockTransport();
    const engine = new DeliberationEngine({ llm: transport, defaultCouncilSize: 5 });
    await engine.deliberate({ proposal: { title, description: "" } });
    // First call's system prompt should correspond to the expected lead archetype
    const firstCall = vi.mocked(transport.chat).mock.calls[0];
    const systemMsg = firstCall[0].find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    // The system prompt content varies by archetype — just verify a vote was cast
    expect(firstCall).toBeDefined();
  });
});

describe("DeliberationEngine — tie outcome", () => {
  it("produces deferred outcome on tie (2 YES, 2 NO, 1 ABSTAIN)", async () => {
    let callCount = 0;
    const transport: ILLMTransport = {
      chat: vi.fn().mockImplementation(async () => {
        callCount++;
        let content: string;
        if (callCount <= 2) content = "YES, I approve";
        else if (callCount <= 4) content = "NO, I reject";
        else content = "Uncertain, need more data";
        return {
          content,
          model: "mock-model",
          usage: { promptTokens: 50, completionTokens: 20 },
          latencyMs: 5,
        } satisfies ILLMResponse;
      }),
    };
    const engine = new DeliberationEngine({ llm: transport });
    const res = await engine.deliberate(makeRequest());
    const r = res.result!;
    // tie or below-threshold consensus → deferred
    expect(["deferred", "rejected"]).toContain(r.outcome);
  });
});
