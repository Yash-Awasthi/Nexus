// SPDX-License-Identifier: Apache-2.0
import { fc } from "@fast-check/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  CouncilBridge,
  PlannerCouncilRouter,
  type ICouncilEngine,
  type ICouncilResult,
  type CouncilSignal,
  type RoutedTask,
} from "../src/council-bridge.js";
import type { IEventBus } from "../src/event-bus.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makeEngine(overrides?: Partial<ICouncilResult>): ICouncilEngine {
  const defaultResult: ICouncilResult = {
    proposalId: "prop-1",
    outcome: "approved",
    votes: [
      {
        model: "claude-3",
        provider: "anthropic",
        vote: "yes",
        reasoning: "Looks good",
        confidence: 0.9,
      },
      { model: "gpt-4o", provider: "openai", vote: "yes", reasoning: "Agree", confidence: 0.85 },
      { model: "llama-3", provider: "groq", vote: "no", reasoning: "Disagree", confidence: 0.6 },
    ],
    consensus: 0.8,
    summary: "Council approved the proposal",
    totalLatencyMs: 1200,
    costUsd: 0.004,
    ...overrides,
  };

  return {
    deliberate: vi.fn().mockResolvedValue({ ok: true, result: defaultResult }),
  };
}

function makeEventBus(): IEventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    getActiveSubscriptionCount: vi.fn().mockReturnValue(0),
    getDeduplicationCount: vi.fn().mockReturnValue(0),
    compact: vi.fn().mockReturnValue({ dedupKeysCleared: 0 }),
  } as unknown as IEventBus;
}

function makeSignal(overrides?: Partial<CouncilSignal>): CouncilSignal {
  return {
    id: "signal-1",
    title: "Test signal",
    description: "Should we proceed?",
    priority: "medium",
    ...overrides,
  };
}

// ─── CouncilBridge unit tests ─────────────────────────────────────────────────

describe("CouncilBridge", () => {
  let engine: ICouncilEngine;
  let eventBus: IEventBus;
  let bridge: CouncilBridge;

  beforeEach(() => {
    engine = makeEngine();
    eventBus = makeEventBus();
    bridge = new CouncilBridge({ engine, eventBus });
  });

  it("returns an approved verdict for a yes-majority deliberation", async () => {
    const verdict = await bridge.deliberate(makeSignal());
    expect(verdict.decision).toBe("approve");
    expect(verdict.confidence).toBeGreaterThan(0);
    expect(verdict.rationale).toBeTruthy();
  });

  it("emits nexus.council.started before calling engine", async () => {
    await bridge.deliberate(makeSignal());
    const publishMock = eventBus.publish as ReturnType<typeof vi.fn>;
    const calls = publishMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain("nexus.council.started");
  });

  it("emits nexus.council.verdict after engine returns", async () => {
    await bridge.deliberate(makeSignal());
    const publishMock = eventBus.publish as ReturnType<typeof vi.fn>;
    const calls = publishMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain("nexus.council.verdict");
  });

  it("publishes events in order: started, then verdict", async () => {
    await bridge.deliberate(makeSignal());
    const publishMock = eventBus.publish as ReturnType<typeof vi.fn>;
    const calls = publishMock.mock.calls.map((c: unknown[]) => c[0]);
    const startedIdx = calls.indexOf("nexus.council.started");
    const verdictIdx = calls.indexOf("nexus.council.verdict");
    expect(startedIdx).toBeLessThan(verdictIdx);
  });

  it("maps rejected outcome to reject decision", async () => {
    engine = makeEngine({ outcome: "rejected" });
    bridge = new CouncilBridge({ engine, eventBus });
    const verdict = await bridge.deliberate(makeSignal());
    expect(verdict.decision).toBe("reject");
  });

  it("maps deferred outcome to defer when confidence >= 0.3", async () => {
    engine = makeEngine({ outcome: "deferred", consensus: 0.5 });
    bridge = new CouncilBridge({ engine, eventBus });
    const verdict = await bridge.deliberate(makeSignal());
    expect(verdict.decision).toBe("defer");
  });

  it("maps deferred outcome to escalate when confidence < 0.3", async () => {
    engine = makeEngine({ outcome: "deferred", consensus: 0.1 });
    bridge = new CouncilBridge({ engine, eventBus });
    const verdict = await bridge.deliberate(makeSignal());
    expect(verdict.decision).toBe("escalate");
  });

  it("escalates when engine returns ok=false", async () => {
    engine = { deliberate: vi.fn().mockResolvedValue({ ok: false, error: "LLM provider down" }) };
    bridge = new CouncilBridge({ engine, eventBus });
    const verdict = await bridge.deliberate(makeSignal());
    expect(verdict.decision).toBe("escalate");
    expect(verdict.rationale).toBe("LLM provider down");
  });

  it("defers on timeout", async () => {
    engine = {
      deliberate: vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10_000))),
    };
    bridge = new CouncilBridge({ engine, eventBus, defaultTimeoutMs: 50 });
    const verdict = await bridge.deliberate(makeSignal());
    expect(verdict.decision).toBe("defer");
    expect(verdict.rationale).toContain("timed out");
  }, 2000);

  it("escalates on unexpected engine throw", async () => {
    engine = { deliberate: vi.fn().mockRejectedValue(new Error("Network failure")) };
    bridge = new CouncilBridge({ engine, eventBus });
    const verdict = await bridge.deliberate(makeSignal());
    expect(verdict.decision).toBe("escalate");
  });

  it("includes dissents from minority voters", async () => {
    const verdict = await bridge.deliberate(makeSignal());
    // llama-3 voted no in makeEngine(), so should be in dissents
    expect(verdict.dissents).toContain("llama-3");
  });

  it("sets costUsd from engine result", async () => {
    const verdict = await bridge.deliberate(makeSignal());
    expect(verdict.costUsd).toBe(0.004);
  });

  it("passes budgetUsd override to engine", async () => {
    await bridge.deliberate(makeSignal(), { budgetUsd: 0.5 });
    const deliberateMock = engine.deliberate as ReturnType<typeof vi.fn>;
    expect(deliberateMock.mock.calls[0][0].budgetUsd).toBe(0.5);
  });
});

// ─── PlannerCouncilRouter unit tests ─────────────────────────────────────────

describe("PlannerCouncilRouter", () => {
  let engine: ICouncilEngine;
  let eventBus: IEventBus;
  let bridge: CouncilBridge;
  let router: PlannerCouncilRouter;

  beforeEach(() => {
    engine = makeEngine();
    eventBus = makeEventBus();
    bridge = new CouncilBridge({ engine, eventBus });
    router = new PlannerCouncilRouter({ bridge, autoApproveThresholdUsd: 0.05 });
  });

  function makeTask(overrides?: Partial<RoutedTask>): RoutedTask {
    return {
      taskId: "task-1",
      type: "email.send",
      payload: { to: "team@example.com" },
      governanceMetadata: { dangerous: false, costEstimate: 0.01, resourceScope: "gmail" },
      ...overrides,
    };
  }

  it("auto-approves safe tasks without calling the engine", async () => {
    const verdict = await router.route(makeTask());
    expect(verdict.decision).toBe("approve");
    expect(verdict.rationale).toContain("Auto-approved");
    const deliberateMock = engine.deliberate as ReturnType<typeof vi.fn>;
    expect(deliberateMock).not.toHaveBeenCalled();
  });

  it("routes dangerous tasks to council", async () => {
    const task = makeTask({ governanceMetadata: { dangerous: true } });
    await router.route(task);
    const deliberateMock = engine.deliberate as ReturnType<typeof vi.fn>;
    expect(deliberateMock).toHaveBeenCalledOnce();
  });

  it("routes high-cost tasks to council", async () => {
    const task = makeTask({ governanceMetadata: { dangerous: false, costEstimate: 0.99 } });
    await router.route(task);
    const deliberateMock = engine.deliberate as ReturnType<typeof vi.fn>;
    expect(deliberateMock).toHaveBeenCalledOnce();
  });

  it("routes critical-priority signals to council regardless of cost", async () => {
    const task = makeTask({ governanceMetadata: { dangerous: false, costEstimate: 0.001 } });
    await router.route(task, {
      priority: "critical",
      id: "sig-1",
      title: "Critical event",
      description: "!",
    });
    const deliberateMock = engine.deliberate as ReturnType<typeof vi.fn>;
    expect(deliberateMock).toHaveBeenCalledOnce();
  });

  it("auto-approved verdict has confidence=1 and costUsd=0", async () => {
    const verdict = await router.route(makeTask());
    expect(verdict.confidence).toBe(1.0);
    expect(verdict.costUsd).toBe(0);
  });
});

// ─── Property-based: verdict is always one of the 4 valid decisions ──────────

describe("CouncilBridge — property-based", () => {
  const outcomeArb = fc.constantFrom("approved", "rejected", "deferred") as fc.Arbitrary<
    "approved" | "rejected" | "deferred"
  >;
  const confidenceArb = fc.float({ min: 0, max: 1 });

  it("always returns a valid decision", async () => {
    await fc.assert(
      fc.asyncProperty(outcomeArb, confidenceArb, async (outcome, consensus) => {
        const engine = makeEngine({ outcome, consensus });
        const eventBus = makeEventBus();
        const bridge = new CouncilBridge({ engine, eventBus });
        const verdict = await bridge.deliberate(makeSignal());
        expect(["approve", "reject", "defer", "escalate"]).toContain(verdict.decision);
      }),
      { numRuns: 30 },
    );
  });

  it("always emits exactly 2 events per deliberation (started + verdict)", async () => {
    await fc.assert(
      fc.asyncProperty(outcomeArb, async (outcome) => {
        const engine = makeEngine({ outcome });
        const eventBus = makeEventBus();
        const bridge = new CouncilBridge({ engine, eventBus });
        await bridge.deliberate(makeSignal());
        const publishMock = eventBus.publish as ReturnType<typeof vi.fn>;
        expect(publishMock.mock.calls.length).toBe(2);
        publishMock.mockClear();
      }),
      { numRuns: 30 },
    );
  });
});
