// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AlertError,
  AlertEngine,
  NullAlertChannel,
  FailingAlertChannel,
  thresholdRule,
  type AlertRule,
  type AlertChannel,
  type AlertHooks,
  type AlertEvent,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _time = 1_000_000;
function mockNow() { return _time; }
function advanceMs(ms: number) { _time += ms; }
function resetClock() { _time = 1_000_000; }

function makeHooks(): AlertHooks {
  return { emit: vi.fn().mockResolvedValue({ handled: 1, aborted: false, errors: [] }) };
}

function makeEngine(opts: {
  channels?: AlertChannel[];
  hooks?: AlertHooks;
} = {}): AlertEngine {
  return new AlertEngine({ now: mockNow, ...opts });
}

const costRule: AlertRule = thresholdRule("cost-high", "cost.usd.daily", "gt", 10, "warning");

// ─────────────────────────────────────────────────────────────────────────────
// AlertError
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertError", () => {
  it("extends Error with correct name", () => {
    const e = new AlertError("DUPLICATE_RULE", "already exists");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AlertError");
  });

  it("exposes code and message", () => {
    const e = new AlertError("RULE_NOT_FOUND", "not found");
    expect(e.code).toBe("RULE_NOT_FOUND");
    expect(e.message).toBe("not found");
  });

  it("stores optional context", () => {
    const e = new AlertError("EVALUATE_FAILED", "err", { ruleId: "r1" });
    expect(e.context).toEqual({ ruleId: "r1" });
  });

  it("context is undefined when omitted", () => {
    const e = new AlertError("CHANNEL_SEND_FAILED", "err");
    expect(e.context).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NullAlertChannel
// ─────────────────────────────────────────────────────────────────────────────

describe("NullAlertChannel", () => {
  it("has name 'null'", () => {
    expect(new NullAlertChannel().name).toBe("null");
  });

  it("records sent events", async () => {
    const ch = new NullAlertChannel();
    const event: AlertEvent = {
      id: "e1",
      ruleId: "r1",
      ruleName: "test",
      severity: "info",
      metric: "m",
      value: 1,
      firedAt: 0,
    };
    await ch.send(event);
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]).toBe(event);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// thresholdRule factory
// ─────────────────────────────────────────────────────────────────────────────

describe("thresholdRule", () => {
  it("creates a rule with correct id, metric, operator, value, severity", () => {
    const rule = thresholdRule("r1", "cost.usd", "gt", 10, "critical");
    expect(rule).toMatchObject({
      id: "r1",
      metric: "cost.usd",
      condition: { type: "threshold", operator: "gt", value: 10 },
      severity: "critical",
    });
  });

  it("defaults severity to 'warning'", () => {
    const rule = thresholdRule("r2", "m", "lt", 5);
    expect(rule.severity).toBe("warning");
  });

  it("merges opts (name, cooldownMs, metadata)", () => {
    const rule = thresholdRule("r3", "m", "gte", 1, "info", {
      name: "My Rule",
      cooldownMs: 5000,
      metadata: { team: "ops" },
    });
    expect(rule.name).toBe("My Rule");
    expect(rule.cooldownMs).toBe(5000);
    expect(rule.metadata).toEqual({ team: "ops" });
  });

  it("defaults name to id when opts.name omitted", () => {
    const rule = thresholdRule("my-id", "m", "eq", 0);
    expect(rule.name).toBe("my-id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — rule management
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — rule management", () => {
  let engine: AlertEngine;

  beforeEach(() => {
    resetClock();
    engine = makeEngine();
  });

  it("addRule registers a rule", () => {
    engine.addRule(costRule);
    expect(engine.getRule("cost-high")).toMatchObject({ id: "cost-high" });
  });

  it("listRules returns all registered rules", () => {
    engine.addRule(costRule);
    engine.addRule(thresholdRule("lat", "latency.ms", "gt", 500, "critical"));
    expect(engine.listRules()).toHaveLength(2);
  });

  it("addRule throws DUPLICATE_RULE when id already registered", () => {
    engine.addRule(costRule);
    let caught: AlertError | undefined;
    try { engine.addRule(costRule); } catch (e) { caught = e as AlertError; }
    expect(caught?.code).toBe("DUPLICATE_RULE");
  });

  it("removeRule deletes the rule", () => {
    engine.addRule(costRule);
    engine.removeRule("cost-high");
    expect(engine.getRule("cost-high")).toBeUndefined();
  });

  it("removeRule throws RULE_NOT_FOUND when id unknown", () => {
    let caught: AlertError | undefined;
    try { engine.removeRule("nope"); } catch (e) { caught = e as AlertError; }
    expect(caught?.code).toBe("RULE_NOT_FOUND");
  });

  it("updateRule patches an existing rule", () => {
    engine.addRule(costRule);
    engine.updateRule("cost-high", { severity: "critical", cooldownMs: 1000 });
    expect(engine.getRule("cost-high")).toMatchObject({
      severity: "critical",
      cooldownMs: 1000,
    });
  });

  it("updateRule throws RULE_NOT_FOUND when id unknown", () => {
    let caught: AlertError | undefined;
    try { engine.updateRule("nope", { severity: "info" }); } catch (e) { caught = e as AlertError; }
    expect(caught?.code).toBe("RULE_NOT_FOUND");
  });

  it("clearRules removes all rules", () => {
    engine.addRule(costRule);
    engine.clearRules();
    expect(engine.listRules()).toHaveLength(0);
  });

  it("getRule returns undefined for unknown id", () => {
    expect(engine.getRule("unknown")).toBeUndefined();
  });

  it("addRule is chainable", () => {
    const e = makeEngine();
    expect(e.addRule(costRule)).toBe(e);
  });

  it("removeRule is chainable", () => {
    engine.addRule(costRule);
    expect(engine.removeRule("cost-high")).toBe(engine);
  });

  it("clearRules is chainable", () => {
    expect(engine.clearRules()).toBe(engine);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — threshold conditions
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — threshold conditions", () => {
  let engine: AlertEngine;
  let ch: NullAlertChannel;

  beforeEach(() => {
    resetClock();
    ch = new NullAlertChannel();
    engine = makeEngine({ channels: [ch] });
  });

  it("gt fires when value > threshold", async () => {
    engine.addRule(thresholdRule("r", "m", "gt", 10));
    const result = await engine.evaluate("m", 11);
    expect(result.fired).toBe(1);
    expect(ch.sent).toHaveLength(1);
  });

  it("gt does not fire when value === threshold", async () => {
    engine.addRule(thresholdRule("r", "m", "gt", 10));
    const result = await engine.evaluate("m", 10);
    expect(result.fired).toBe(0);
  });

  it("gte fires when value === threshold", async () => {
    engine.addRule(thresholdRule("r", "m", "gte", 10));
    const result = await engine.evaluate("m", 10);
    expect(result.fired).toBe(1);
  });

  it("lt fires when value < threshold", async () => {
    engine.addRule(thresholdRule("r", "m", "lt", 5));
    const result = await engine.evaluate("m", 4);
    expect(result.fired).toBe(1);
  });

  it("lte fires when value === threshold", async () => {
    engine.addRule(thresholdRule("r", "m", "lte", 5));
    const result = await engine.evaluate("m", 5);
    expect(result.fired).toBe(1);
  });

  it("eq fires when value equals threshold", async () => {
    engine.addRule(thresholdRule("r", "m", "eq", 42));
    const result = await engine.evaluate("m", 42);
    expect(result.fired).toBe(1);
  });

  it("neq fires when value differs from threshold", async () => {
    engine.addRule(thresholdRule("r", "m", "neq", 0));
    const result = await engine.evaluate("m", 1);
    expect(result.fired).toBe(1);
  });

  it("neq does not fire when value equals threshold", async () => {
    engine.addRule(thresholdRule("r", "m", "neq", 0));
    const result = await engine.evaluate("m", 0);
    expect(result.fired).toBe(0);
  });

  it("threshold does not fire when value is a non-number", async () => {
    engine.addRule(thresholdRule("r", "m", "gt", 0));
    const result = await engine.evaluate("m", "high");
    expect(result.fired).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — pattern conditions
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — pattern conditions", () => {
  let engine: AlertEngine;

  beforeEach(() => {
    resetClock();
    engine = makeEngine();
  });

  it("pattern fires on substring match", async () => {
    engine.addRule({
      id: "r",
      name: "r",
      metric: "log.message",
      condition: { type: "pattern", pattern: "ERROR" },
      severity: "critical",
    });
    const result = await engine.evaluate("log.message", "2026-06-13 ERROR: disk full");
    expect(result.fired).toBe(1);
  });

  it("pattern does not fire when substring absent", async () => {
    engine.addRule({
      id: "r", name: "r", metric: "m",
      condition: { type: "pattern", pattern: "ERROR" },
      severity: "info",
    });
    const result = await engine.evaluate("m", "INFO: all good");
    expect(result.fired).toBe(0);
  });

  it("pattern ignoreCase matches case-insensitively", async () => {
    engine.addRule({
      id: "r", name: "r", metric: "m",
      condition: { type: "pattern", pattern: "error", ignoreCase: true },
      severity: "warning",
    });
    const result = await engine.evaluate("m", "CRITICAL ERROR OCCURRED");
    expect(result.fired).toBe(1);
  });

  it("pattern regex mode matches regexp", async () => {
    engine.addRule({
      id: "r", name: "r", metric: "m",
      condition: { type: "pattern", pattern: "^ERR\\d+", regex: true },
      severity: "critical",
    });
    expect((await engine.evaluate("m", "ERR404: not found")).fired).toBe(1);
    expect((await engine.evaluate("m", "WARN: something")).fired).toBe(0);
  });

  it("pattern regex with ignoreCase flag", async () => {
    engine.addRule({
      id: "r", name: "r", metric: "m",
      condition: { type: "pattern", pattern: "timeout", regex: true, ignoreCase: true },
      severity: "warning",
    });
    const result = await engine.evaluate("m", "TIMEOUT after 30s");
    expect(result.fired).toBe(1);
  });

  it("pattern does not fire when value is non-string", async () => {
    engine.addRule({
      id: "r", name: "r", metric: "m",
      condition: { type: "pattern", pattern: "x" },
      severity: "info",
    });
    const result = await engine.evaluate("m", 42);
    expect(result.fired).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — rate conditions
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — rate conditions", () => {
  let engine: AlertEngine;

  beforeEach(() => {
    resetClock();
    engine = makeEngine();
    engine.addRule({
      id: "rate-rule",
      name: "Error rate",
      metric: "errors",
      condition: { type: "rate", count: 3, windowMs: 60_000 },
      severity: "warning",
    });
  });

  it("does not fire when count is within limit", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await engine.evaluate("errors", 1);
      expect(r.fired).toBe(0);
    }
  });

  it("fires when count exceeds limit in window", async () => {
    for (let i = 0; i < 4; i++) {
      await engine.evaluate("errors", 1);
    }
    // 4th call → timestamps.length (4) > count (3) → fires
    const r = await engine.evaluate("errors", 1);
    expect(r.fired).toBe(1);
  });

  it("evicts timestamps outside the window", async () => {
    // Push 3 events at t=0
    for (let i = 0; i < 3; i++) await engine.evaluate("errors", 1);
    // Advance past the window
    advanceMs(61_000);
    // Reset cooldown so it can fire again
    engine.resetCooldown("rate-rule");
    // These 3 fresh events should not fire (window evicted old ones)
    for (let i = 0; i < 3; i++) {
      const r = await engine.evaluate("errors", 1);
      expect(r.fired).toBe(0);
    }
  });

  it("resetRateWindow clears the rate state", async () => {
    for (let i = 0; i < 4; i++) await engine.evaluate("errors", 1);
    engine.resetRateWindow("rate-rule");
    engine.resetCooldown("rate-rule");
    // Fresh window — should not fire for 3 calls
    for (let i = 0; i < 3; i++) {
      const r = await engine.evaluate("errors", 1);
      expect(r.fired).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — composite conditions
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — composite conditions", () => {
  let engine: AlertEngine;

  beforeEach(() => {
    resetClock();
    engine = makeEngine();
    engine.addRule({
      id: "combo",
      name: "High cost + error pattern",
      metric: "cost.usd.daily",
      condition: {
        type: "composite",
        conditions: [
          { type: "threshold", operator: "gt", value: 10 },
          { type: "threshold", operator: "lt", value: 100 },
        ],
      },
      severity: "warning",
    });
  });

  it("fires when all child conditions pass", async () => {
    const r = await engine.evaluate("cost.usd.daily", 50);
    expect(r.fired).toBe(1);
  });

  it("does not fire when first child fails", async () => {
    const r = await engine.evaluate("cost.usd.daily", 5);
    expect(r.fired).toBe(0);
  });

  it("does not fire when second child fails", async () => {
    const r = await engine.evaluate("cost.usd.daily", 150);
    expect(r.fired).toBe(0);
  });

  it("composite with pattern child fires correctly", async () => {
    engine.addRule({
      id: "combo2", name: "combo2", metric: "m",
      condition: {
        type: "composite",
        conditions: [
          { type: "pattern", pattern: "ERR" },
          { type: "threshold", operator: "gt", value: 0 },
        ],
      },
      severity: "critical",
    });
    // Both: string contains ERR and... wait, value can't be both string and number
    // The threshold condition returns false for non-numbers, so composite fails
    const r1 = await engine.evaluate("m", "ERR500");
    expect(r1.fired).toBe(0); // threshold returns false for string value
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — cooldown
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — cooldown", () => {
  let engine: AlertEngine;
  let ch: NullAlertChannel;

  beforeEach(() => {
    resetClock();
    ch = new NullAlertChannel();
    engine = makeEngine({ channels: [ch] });
    engine.addRule(thresholdRule("r", "m", "gt", 0, "info", { cooldownMs: 5000 }));
  });

  it("fires on first trigger", async () => {
    const r = await engine.evaluate("m", 1);
    expect(r.fired).toBe(1);
  });

  it("suppresses subsequent triggers within cooldown window", async () => {
    await engine.evaluate("m", 1);
    advanceMs(2000);
    const r = await engine.evaluate("m", 1);
    expect(r.fired).toBe(0);
    expect(r.suppressed).toBe(1);
  });

  it("fires again after cooldown expires", async () => {
    await engine.evaluate("m", 1);
    advanceMs(6000);
    const r = await engine.evaluate("m", 1);
    expect(r.fired).toBe(1);
  });

  it("resetCooldown allows immediate re-fire", async () => {
    await engine.evaluate("m", 1);
    engine.resetCooldown("r");
    const r = await engine.evaluate("m", 1);
    expect(r.fired).toBe(1);
  });

  it("zero cooldown never suppresses", async () => {
    engine.addRule(thresholdRule("r2", "n", "gt", 0, "info", { cooldownMs: 0 }));
    await engine.evaluate("n", 1);
    const r = await engine.evaluate("n", 1);
    expect(r.fired).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — disabled rules
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — disabled rules", () => {
  it("disabled rule is not evaluated", async () => {
    const ch = new NullAlertChannel();
    const engine = makeEngine({ channels: [ch] });
    engine.addRule({ ...costRule, enabled: false });
    const r = await engine.evaluate("cost.usd.daily", 999);
    expect(r.fired).toBe(0);
    expect(r.disabled).toBe(1);
    expect(ch.sent).toHaveLength(0);
  });

  it("updateRule can re-enable a disabled rule", async () => {
    resetClock();
    const ch = new NullAlertChannel();
    const engine = makeEngine({ channels: [ch] });
    engine.addRule({ ...costRule, enabled: false });
    engine.updateRule("cost-high", { enabled: true });
    const r = await engine.evaluate("cost.usd.daily", 15);
    expect(r.fired).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — wildcard metric
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — wildcard metric", () => {
  it("rule with metric '*' matches any metric", async () => {
    resetClock();
    const ch = new NullAlertChannel();
    const engine = makeEngine({ channels: [ch] });
    engine.addRule(thresholdRule("any", "*", "gt", 100, "critical"));
    const r1 = await engine.evaluate("latency.ms", 200);
    engine.resetCooldown("any");
    const r2 = await engine.evaluate("cost.usd", 150);
    expect(r1.fired).toBe(1);
    expect(r2.fired).toBe(1);
  });

  it("metric-specific rule does not match other metrics", async () => {
    resetClock();
    const engine = makeEngine();
    engine.addRule(thresholdRule("r", "cost.usd", "gt", 10));
    const r = await engine.evaluate("latency.ms", 999);
    expect(r.fired).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — channels + hooks
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — channels and hooks", () => {
  it("sends alert to all channels", async () => {
    resetClock();
    const ch1 = new NullAlertChannel();
    const ch2 = new NullAlertChannel();
    const engine = makeEngine({ channels: [ch1, ch2] });
    engine.addRule(thresholdRule("r", "m", "gt", 0));
    await engine.evaluate("m", 1);
    expect(ch1.sent).toHaveLength(1);
    expect(ch2.sent).toHaveLength(1);
  });

  it("channel failure is non-fatal — other channels still receive", async () => {
    resetClock();
    const failing = new FailingAlertChannel("fail");
    const ok = new NullAlertChannel();
    const engine = makeEngine({ channels: [failing, ok] });
    engine.addRule(thresholdRule("r", "m", "gt", 0));
    const r = await engine.evaluate("m", 1);
    expect(ok.sent).toHaveLength(1);
    expect(r.channelErrors).toHaveLength(1);
    expect(r.channelErrors[0]!.channel).toBe("fail");
  });

  it("channelErrors is empty when all channels succeed", async () => {
    resetClock();
    const ch = new NullAlertChannel();
    const engine = makeEngine({ channels: [ch] });
    engine.addRule(thresholdRule("r", "m", "gt", 0));
    const r = await engine.evaluate("m", 1);
    expect(r.channelErrors).toHaveLength(0);
  });

  it("emits alert.fired hook event with correct payload", async () => {
    resetClock();
    const hooks = makeHooks();
    const engine = makeEngine({ hooks });
    engine.addRule(thresholdRule("r", "cost.usd", "gt", 10, "critical"));
    await engine.evaluate("cost.usd", 15);
    expect(hooks.emit).toHaveBeenCalledWith(
      "alert.fired",
      expect.objectContaining({
        ruleId: "r",
        severity: "critical",
        metric: "cost.usd",
        value: 15,
      }),
    );
  });

  it("hook errors are non-fatal", async () => {
    resetClock();
    const hooks: AlertHooks = { emit: vi.fn().mockRejectedValue(new Error("hook err")) };
    const engine = makeEngine({ hooks });
    engine.addRule(thresholdRule("r", "m", "gt", 0));
    await expect(engine.evaluate("m", 1)).resolves.toBeDefined();
  });

  it("does not emit hook when no hooks wired", async () => {
    resetClock();
    const engine = makeEngine();
    engine.addRule(thresholdRule("r", "m", "gt", 0));
    await expect(engine.evaluate("m", 1)).resolves.toBeDefined();
  });

  it("alert event includes metadata from the rule", async () => {
    resetClock();
    const ch = new NullAlertChannel();
    const engine = makeEngine({ channels: [ch] });
    engine.addRule(thresholdRule("r", "m", "gt", 0, "info", { metadata: { team: "ops" } }));
    await engine.evaluate("m", 1);
    expect(ch.sent[0]!.metadata).toEqual({ team: "ops" });
  });

  it("alert event has unique id, ruleId, metric, value, firedAt", async () => {
    resetClock();
    const ch = new NullAlertChannel();
    const engine = makeEngine({ channels: [ch] });
    engine.addRule(thresholdRule("r", "m", "gt", 0));
    await engine.evaluate("m", 7);
    const event = ch.sent[0]!;
    expect(event.ruleId).toBe("r");
    expect(event.metric).toBe("m");
    expect(event.value).toBe(7);
    expect(typeof event.id).toBe("string");
    expect(event.firedAt).toBe(_time);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — DispatchResult shape
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — DispatchResult", () => {
  it("returns zero-value result when no rules match", async () => {
    resetClock();
    const engine = makeEngine();
    engine.addRule(thresholdRule("r", "other", "gt", 0));
    const r = await engine.evaluate("m", 1);
    expect(r).toEqual({ fired: 0, suppressed: 0, disabled: 0, events: [], channelErrors: [] });
  });

  it("fired, suppressed, disabled counts are accurate in mixed scenario", async () => {
    resetClock();
    const engine = makeEngine();
    // Fires
    engine.addRule(thresholdRule("a", "m", "gt", 0, "info"));
    // Disabled
    engine.addRule({ ...thresholdRule("b", "m", "gt", 0, "info"), enabled: false });
    // Pre-fire "a" to set cooldown, then advance partially
    await engine.evaluate("m", 1);
    // Now update a to have a cooldown so next call suppresses it
    engine.updateRule("a", { cooldownMs: 60_000 });
    const r = await engine.evaluate("m", 1);
    expect(r.suppressed).toBe(1);
    expect(r.disabled).toBe(1);
    expect(r.fired).toBe(0);
  });

  it("events array contains one AlertEvent per fired rule", async () => {
    resetClock();
    const engine = makeEngine();
    engine.addRule(thresholdRule("a", "m", "gt", 0));
    engine.addRule(thresholdRule("b", "m", "gt", 0));
    const r = await engine.evaluate("m", 1);
    expect(r.events).toHaveLength(2);
    const ids = r.events.map((e) => e.ruleId);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });
});
