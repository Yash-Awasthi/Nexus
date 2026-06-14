// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  HumanTiming,
  MouseSimulator,
  KeyboardSimulator,
  ScrollSimulator,
  BrowserSession,
  ActionPlayer,
} from "../src/index.js";

// Deterministic RNG for tests
const deterministicRng = (seed = 0.5) => () => seed;

// ── HumanTiming ───────────────────────────────────────────────────────────────

describe("HumanTiming", () => {
  it("delay returns value within range (without jitter: rng=0.5)", () => {
    const d = HumanTiming.delay({ minMs: 100, maxMs: 200, jitter: 0 }, deterministicRng(0.5));
    expect(d).toBeGreaterThanOrEqual(100);
    expect(d).toBeLessThanOrEqual(200);
  });

  it("delay uses defaults when no options provided", () => {
    const d = HumanTiming.delay({}, deterministicRng(0.5));
    expect(d).toBeGreaterThanOrEqual(0);
  });

  it("typingDelay is proportional to WPM", () => {
    const fast = HumanTiming.typingDelay(120, deterministicRng(0.5));
    const slow = HumanTiming.typingDelay(30, deterministicRng(0.5));
    expect(slow).toBeGreaterThan(fast);
  });

  it("shouldMakeMistake respects errorRate=0", () => {
    for (let i = 0; i < 100; i++) {
      expect(HumanTiming.shouldMakeMistake(0, Math.random)).toBe(false);
    }
  });

  it("shouldMakeMistake respects errorRate=1", () => {
    expect(HumanTiming.shouldMakeMistake(1, deterministicRng(0.5))).toBe(true);
  });
});

// ── MouseSimulator ────────────────────────────────────────────────────────────

describe("MouseSimulator", () => {
  const mouse = new MouseSimulator(deterministicRng(0.5));

  it("generatePath produces intermediate points", () => {
    const path = mouse.generatePath({ x: 0, y: 0 }, { x: 100, y: 100 }, 5);
    expect(path.from).toEqual({ x: 0, y: 0 });
    expect(path.to).toEqual({ x: 100, y: 100 });
    expect(path.steps.length).toBeGreaterThan(2);
    expect(path.durationMs).toBeGreaterThan(0);
  });

  it("last point in path equals destination", () => {
    const path = mouse.generatePath({ x: 0, y: 0 }, { x: 200, y: 150 });
    expect(path.steps[path.steps.length - 1]).toEqual({ x: 200, y: 150 });
  });

  it("click produces a click action", () => {
    const action = mouse.click({ x: 50, y: 80 });
    expect(action.type).toBe("click");
    expect(action.payload["x"]).toBe(50);
    expect(action.payload["y"]).toBe(80);
    expect(action.payload["button"]).toBe("left");
  });

  it("click supports right click", () => {
    const action = mouse.click({ x: 0, y: 0 }, "right");
    expect(action.payload["button"]).toBe("right");
  });

  it("pathToActions generates move actions", () => {
    const path = mouse.generatePath({ x: 0, y: 0 }, { x: 50, y: 50 }, 5);
    const actions = mouse.pathToActions(path);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.type === "move")).toBe(true);
  });
});

// ── KeyboardSimulator ─────────────────────────────────────────────────────────

describe("KeyboardSimulator", () => {
  it("types text and returns correct typed string", () => {
    // With errorRate=0, no mistakes
    const kb = new KeyboardSimulator({ errorRate: 0, rng: deterministicRng(0.5) });
    const result = kb.type("hello");
    expect(result.typed).toBe("hello");
    expect(result.errors).toBe(0);
    expect(result.actions.length).toBe(5); // one per char
  });

  it("injects errors and backspaces with high errorRate", () => {
    // Deterministic rng that always < errorRate causes mistakes
    const kb = new KeyboardSimulator({ errorRate: 1, rng: deterministicRng(0.01) });
    const result = kb.type("abc");
    expect(result.errors).toBeGreaterThan(0);
    // Each error adds 2 actions (wrong char + backspace), then 1 correct = 3 per char
    expect(result.actions.length).toBeGreaterThan(3);
  });

  it("all actions have type='type'", () => {
    const kb = new KeyboardSimulator({ errorRate: 0 });
    const { actions } = kb.type("hi");
    expect(actions.every((a) => a.type === "type")).toBe(true);
  });

  it("shortcut returns a single action with keys array", () => {
    const kb = new KeyboardSimulator();
    const action = kb.shortcut(["Ctrl", "C"]);
    expect(action.type).toBe("type");
    expect(action.payload["keys"]).toEqual(["Ctrl", "C"]);
    expect(action.payload["shortcut"]).toBe(true);
  });

  it("delay between characters is positive", () => {
    const kb = new KeyboardSimulator({ errorRate: 0 });
    const { actions } = kb.type("test");
    expect(actions.every((a) => a.delayMs > 0)).toBe(true);
  });
});

// ── ScrollSimulator ───────────────────────────────────────────────────────────

describe("ScrollSimulator", () => {
  const scroll = new ScrollSimulator(deterministicRng(0.5));

  it("generates chunks that sum to approximately totalDelta", () => {
    const chunks = scroll.generateChunks(500);
    const total = chunks.reduce((s, c) => s + Math.abs(c.deltaY), 0);
    expect(total).toBeGreaterThanOrEqual(450); // allow some variance
  });

  it("negative delta produces negative chunks", () => {
    const chunks = scroll.generateChunks(-300);
    expect(chunks.every((c) => c.deltaY < 0)).toBe(true);
  });

  it("all chunks have positive delay", () => {
    const chunks = scroll.generateChunks(200);
    expect(chunks.every((c) => c.delayMs > 0)).toBe(true);
  });

  it("toActions produces scroll actions", () => {
    const chunks = scroll.generateChunks(100);
    const actions = scroll.toActions(chunks);
    expect(actions.every((a) => a.type === "scroll")).toBe(true);
  });
});

// ── BrowserSession ────────────────────────────────────────────────────────────

describe("BrowserSession", () => {
  it("records multiple action types", () => {
    const session = new BrowserSession(deterministicRng(0.5));
    session
      .moveTo({ x: 0, y: 0 }, { x: 100, y: 100 })
      .click({ x: 100, y: 100 })
      .type("hello")
      .scroll(300)
      .wait(100, 300);

    const actions = session.getActions();
    expect(actions.some((a) => a.type === "move")).toBe(true);
    expect(actions.some((a) => a.type === "click")).toBe(true);
    expect(actions.some((a) => a.type === "type")).toBe(true);
    expect(actions.some((a) => a.type === "scroll")).toBe(true);
    expect(actions.some((a) => a.type === "wait")).toBe(true);
  });

  it("totalDuration sums all delays", () => {
    const session = new BrowserSession(deterministicRng(0.5));
    session.click({ x: 0, y: 0 }).click({ x: 10, y: 10 });
    const total = session.totalDuration();
    expect(total).toBeGreaterThan(0);
  });

  it("clear removes all actions", () => {
    const session = new BrowserSession();
    session.click({ x: 0, y: 0 });
    session.clear();
    expect(session.getActions()).toHaveLength(0);
  });

  it("supports chaining", () => {
    const session = new BrowserSession();
    expect(session.click({ x: 0, y: 0 })).toBe(session);
    expect(session.clear()).toBe(session);
  });
});

// ── ActionPlayer ──────────────────────────────────────────────────────────────

describe("ActionPlayer", () => {
  it("plays all actions and returns results", async () => {
    const executed: string[] = [];
    const player = new ActionPlayer((action) => { executed.push(action.type); });
    const session = new BrowserSession(deterministicRng(0.5));
    session.click({ x: 0, y: 0 }).type("hi");
    const result = await player.play(session.getActions());
    expect(result.executed).toBe(result.total);
    expect(result.errors).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("counts errors when executor throws", async () => {
    const player = new ActionPlayer(() => { throw new Error("failed"); });
    const session = new BrowserSession();
    session.click({ x: 0, y: 0 }).click({ x: 10, y: 10 });
    const result = await player.play(session.getActions());
    expect(result.errors).toBe(2);
    expect(result.executed).toBe(0);
  });

  it("handles async executor", async () => {
    let count = 0;
    const player = new ActionPlayer(async () => { await Promise.resolve(); count++; });
    const session = new BrowserSession();
    session.click({ x: 0, y: 0 });
    await player.play(session.getActions());
    expect(count).toBeGreaterThan(0);
  });
});
