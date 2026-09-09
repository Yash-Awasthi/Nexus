// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { EscalationBreaker, type BreakerInput, type UsageSample } from "./index";

const T0 = 1_700_000_000_000;

function input(runId: string, overrides: Partial<BreakerInput> = {}): BreakerInput {
  return { runId, sample: null, progressing: false, ...overrides };
}

function sample(output = 0, overrides: Partial<UsageSample> = {}): UsageSample {
  return { input: 0, output, cacheRead: 0, cacheCreation: 0, ts: T0, ...overrides };
}

describe("EscalationBreaker — repeated-tool loop arm", () => {
  it("steers after the repeated-tool limit of identical calls", () => {
    const b = new EscalationBreaker(() => ({}));
    const runId = "r1";
    for (let i = 0; i < 7; i++) b.recordToolUse(runId, "bash", { command: "ls" });
    // 7 identical calls: count is 7 < limit 8 → still healthy.
    let d = b.tick([input(runId)], T0)[0]!;
    expect(d.state.level).toBe("healthy");
    expect(d.action).toBe("none");
    // 8th identical call trips the loop arm → steering.
    b.recordToolUse(runId, "bash", { command: "ls" });
    d = b.tick([input(runId)], T0 + 1_000)[0]!;
    expect(d.state.level).toBe("steering");
    expect(d.action).toBe("steer");
    expect(d.state.reason).toMatch(/looping/);
  });

  it("treats a distinct tool call as progress and resets the loop counter", () => {
    const b = new EscalationBreaker(() => ({}));
    const runId = "r1";
    for (let i = 0; i < 7; i++) b.recordToolUse(runId, "bash", { command: "ls" });
    b.recordToolUse(runId, "bash", { command: "ls -la" }); // different input → new key
    const d = b.tick([input(runId)], T0)[0]!;
    expect(d.state.level).toBe("healthy");
    expect(d.action).toBe("none");
  });
});

describe("EscalationBreaker — error storm arm", () => {
  it("steers after errorStormLimit consecutive errors", () => {
    const b = new EscalationBreaker(() => ({}));
    const runId = "r1";
    for (let i = 0; i < 5; i++) b.recordError(runId);
    const d = b.tick([input(runId)], T0)[0]!;
    expect(d.state.level).toBe("steering");
    expect(d.state.reason).toMatch(/error storm/);
  });

  it("a distinct tool call clears the error storm", () => {
    const b = new EscalationBreaker(() => ({}));
    const runId = "r1";
    for (let i = 0; i < 5; i++) b.recordError(runId);
    b.recordToolUse(runId, "read_file", { path: "/a" });
    const d = b.tick([input(runId)], T0)[0]!;
    expect(d.state.level).toBe("healthy");
  });
});

describe("EscalationBreaker — token velocity + caps", () => {
  it("steers on a token-velocity spike (Δoutput/Δt)", () => {
    const b = new EscalationBreaker(() => ({ tokenVelocityPerMin: 60_000 }));
    const runId = "r1";
    // Tick 1: baseline 0 output.
    b.tick([input(runId, { sample: sample(0, { ts: T0 }) })], T0);
    // Tick 2: 2,000 output tokens in 1s → 120,000/min > 60,000/min.
    const d = b.tick([input(runId, { sample: sample(2_000, { ts: T0 + 1_000 }) })], T0 + 1_000)[0]!;
    expect(d.state.level).toBe("steering");
    expect(d.state.reason).toMatch(/token velocity/);
  });

  it("trips the cost cap", () => {
    const b = new EscalationBreaker(() => ({ costCapUsd: 5 }));
    const runId = "r1";
    const d = b.tick([input(runId, { sample: sample(100, { usd: 6.5, ts: T0 }) })], T0)[0]!;
    expect(d.state.level).toBe("steering");
    expect(d.state.reason).toMatch(/cost cap/);
  });

  it("trips the token cap", () => {
    const b = new EscalationBreaker(() => ({ costCapTokens: 10_000 }));
    const runId = "r1";
    const d = b.tick(
      [input(runId, { sample: sample(10, { input: 9_999, cacheRead: 1, ts: T0 }) })],
      T0,
    )[0]!;
    expect(d.state.level).toBe("steering");
    expect(d.state.reason).toMatch(/token cap/);
  });
});

describe("EscalationBreaker — no-progress arm", () => {
  it("fires only after two consecutive no-progress ticks", () => {
    const b = new EscalationBreaker(() => ({}));
    const runId = "r1";
    // Tick 1: baseline sample (no lastSample yet — velocity arm is inert).
    b.tick([input(runId, { sample: sample(100, { ts: T0 }) })], T0);
    // Tick 2: burns output, no progress → first no-progress tick (debounced).
    b.tick([input(runId, { sample: sample(200, { ts: T0 + 1_000 }) })], T0 + 1_000);
    // Tick 3: second consecutive no-progress tick → fires.
    const d = b.tick([input(runId, { sample: sample(300, { ts: T0 + 2_000 }) })], T0 + 2_000)[0]!;
    expect(d.state.level).toBe("steering");
    expect(d.state.reason).toMatch(/no-progress/);
  });

  it("a recent distinct tool call counts as progress", () => {
    const b = new EscalationBreaker(() => ({}));
    const runId = "r1";
    b.recordToolUse(runId, "read_file", { path: "/a" }, T0);
    b.tick([input(runId, { sample: sample(100, { ts: T0 }) })], T0);
    const d = b.tick([input(runId, { sample: sample(200, { ts: T0 + 1_000 }) })], T0 + 1_000)[0]!;
    expect(d.state.level).toBe("healthy");
  });
});

describe("EscalationBreaker — ladder escalation + recovery", () => {
  it("escalates one level per tick: steer → constrain → stop (hardStop)", () => {
    const b = new EscalationBreaker(() => ({ hardStop: true }));
    const runId = "r1";
    // Prime the loop counter with 7 identical calls (limit is 8).
    for (let i = 0; i < 7; i++) b.recordToolUse(runId, "bash", { command: "ls" });
    let tick = 0;
    const tripTick = () => {
      b.recordToolUse(runId, "bash", { command: "ls" }); // 8th, 9th, 10th… identical
      return b.tick([input(runId)], T0 + ++tick * 1_000)[0]!;
    };
    // First trip: healthy → steering.
    expect(tripTick().state.level).toBe("steering");
    // Second trip: steering → constrained.
    expect(tripTick().state.level).toBe("constrained");
    // Third trip: constrained → stopped.
    const d = tripTick();
    expect(d.state.level).toBe("stopped");
    expect(d.action).toBe("stop");
  });

  it("caps at constrained when hardStop is off", () => {
    const b = new EscalationBreaker(() => ({})); // hardStop defaults false
    const runId = "r1";
    // 7 primes + 3 trips: count climbs 8 → 9 → 10, each past the limit.
    for (let i = 0; i < 7; i++) b.recordToolUse(runId, "bash", { command: "ls" });
    for (let i = 0; i < 3; i++) {
      b.recordToolUse(runId, "bash", { command: "ls" });
      b.tick([input(runId)], T0 + i * 1_000);
    }
    // Repeated trips climb to constrained and stay there (hardStop off).
    expect(b.levelFor(runId)).toBe("constrained");
  });

  it("recovers one level per healthy tick", () => {
    const b = new EscalationBreaker(() => ({}));
    const runId = "r1";
    // Escalate to constrained: 7 primes + 2 trips (8th and 9th identical call).
    for (let i = 0; i < 7; i++) b.recordToolUse(runId, "bash", { command: "ls" });
    for (let i = 0; i < 2; i++) {
      b.recordToolUse(runId, "bash", { command: "ls" });
      b.tick([input(runId)], T0 + i * 1_000);
    }
    expect(b.levelFor(runId)).toBe("constrained");
    // Healthy tick (distinct tool call) → recover one level.
    b.recordToolUse(runId, "bash", { command: "ls -la" });
    const d = b.tick([input(runId)], T0 + 10_000)[0]!;
    expect(d.state.level).toBe("steering");
    expect(d.state.reason).toMatch(/recovering/);
  });

  it("escalation action fires once per level change; repeated trips at the ceiling re-fire nothing", () => {
    const b = new EscalationBreaker(() => ({})); // hardStop off → ceiling is constrained
    const runId = "r1";
    // Prime 7, then the 8th identical call trips → steer fires.
    for (let i = 0; i < 7; i++) b.recordToolUse(runId, "bash", { command: "ls" });
    b.recordToolUse(runId, "bash", { command: "ls" });
    const escalated = b.tick([input(runId)], T0)[0]!;
    expect(escalated.action).toBe("steer");
    // 9th identical call trips again → steering → constrained, constrain fires.
    b.recordToolUse(runId, "bash", { command: "ls" });
    const constrained = b.tick([input(runId)], T0 + 1_000)[0]!;
    expect(constrained.action).toBe("constrain");
    // 10th identical call trips again but we're AT the ceiling: level unchanged,
    // action none, changed false — a durable directive isn't re-emitted every tick.
    b.recordToolUse(runId, "bash", { command: "ls" });
    const same = b.tick([input(runId)], T0 + 2_000)[0]!;
    expect(same.state.level).toBe("constrained"); // unchanged level
    expect(same.action).toBe("none");
    expect(same.changed).toBe(false);
  });
});

describe("EscalationBreaker — disabled + lifecycle", () => {
  it("reports healthy and takes no action when disabled", () => {
    const b = new EscalationBreaker(() => ({ enabled: false }));
    const runId = "r1";
    for (let i = 0; i < 20; i++) b.recordToolUse(runId, "bash", { command: "ls" });
    const d = b.tick([input(runId)], T0)[0]!;
    expect(d.state.level).toBe("healthy");
    expect(d.action).toBe("none");
  });

  it("forget() drops all state so a run can't leak", () => {
    const b = new EscalationBreaker(() => ({}));
    const runId = "r1";
    for (let i = 0; i < 10; i++) b.recordToolUse(runId, "bash", { command: "ls" });
    b.forget(runId);
    expect(b.levelFor(runId)).toBe("healthy");
    const d = b.tick([input(runId)], T0)[0]!;
    expect(d.state.level).toBe("healthy");
  });
});
