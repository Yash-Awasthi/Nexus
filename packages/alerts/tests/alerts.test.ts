// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AlertError,
  AlertEngine,
  AlertHistory,
  NullAlertChannel,
  FailingAlertChannel,
  MemoryAlertRuleStore,
  MemoryAlertCooldownStore,
  FileAlertRuleStore,
  persistEngineTo,
  loadEngineFromStore,
  thresholdRule,
  type AlertRule,
  type AlertChannel,
  type AlertHooks,
  type AlertEvent,
  type AlertReadFileFn,
  type AlertWriteFileFn,
  type AlertCooldownStore,
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

// ─────────────────────────────────────────────────────────────────────────────
// AlertRuleStore — MemoryAlertRuleStore
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryAlertRuleStore", () => {
  it("loadRules() returns empty array initially", async () => {
    const store = new MemoryAlertRuleStore();
    expect(await store.loadRules()).toEqual([]);
  });

  it("saveRules() persists rules and loadRules() returns them", async () => {
    const store = new MemoryAlertRuleStore();
    const rule = thresholdRule("r1", "cpu", "gt", 90);
    await store.saveRules([rule]);
    const loaded = await store.loadRules();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("r1");
  });

  it("saveRules() replaces previous rules", async () => {
    const store = new MemoryAlertRuleStore();
    await store.saveRules([thresholdRule("old", "x", "gt", 1)]);
    await store.saveRules([thresholdRule("new", "y", "gt", 2)]);
    const loaded = await store.loadRules();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("new");
  });

  it("clear() removes all rules", async () => {
    const store = new MemoryAlertRuleStore();
    await store.saveRules([thresholdRule("r1", "x", "gt", 1)]);
    await store.clear();
    expect(await store.loadRules()).toHaveLength(0);
  });

  it("loadRules() returns a copy — mutations do not affect the store", async () => {
    const store = new MemoryAlertRuleStore();
    const rule = thresholdRule("r1", "cpu", "gt", 90);
    await store.saveRules([rule]);
    const loaded = await store.loadRules();
    loaded.push(thresholdRule("r2", "mem", "gt", 80));
    expect(await store.loadRules()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertRuleStore — FileAlertRuleStore
// ─────────────────────────────────────────────────────────────────────────────

describe("FileAlertRuleStore", () => {
  function makeFileStore(initialContent?: string) {
    let disk = initialContent ?? "[]";
    const readFile: AlertReadFileFn = vi.fn(async () => disk);
    const writeFile: AlertWriteFileFn = vi.fn(async (_p, content) => {
      disk = content;
    });
    const store = new FileAlertRuleStore({ path: "/tmp/rules.json", readFile, writeFile });
    return { store, readFile, writeFile, getDisk: () => disk };
  }

  it("loadRules() returns [] when file is empty JSON array", async () => {
    const { store } = makeFileStore("[]");
    expect(await store.loadRules()).toEqual([]);
  });

  it("loadRules() returns [] when file is missing (readFile throws)", async () => {
    const readFile: AlertReadFileFn = vi.fn(async () => { throw new Error("ENOENT"); });
    const store = new FileAlertRuleStore({ path: "/missing.json", readFile });
    expect(await store.loadRules()).toEqual([]);
  });

  it("loadRules() parses rules from disk", async () => {
    const rule = thresholdRule("disk-rule", "cpu", "gt", 80);
    const { store } = makeFileStore(JSON.stringify([rule]));
    const loaded = await store.loadRules();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("disk-rule");
  });

  it("saveRules() writes JSON to the file path", async () => {
    const { store, writeFile } = makeFileStore();
    await store.saveRules([thresholdRule("r1", "x", "gt", 1)]);
    expect(vi.mocked(writeFile)).toHaveBeenCalledOnce();
    const written = vi.mocked(writeFile).mock.calls[0]![1];
    const parsed = JSON.parse(written) as AlertRule[];
    expect(parsed[0]!.id).toBe("r1");
  });

  it("clear() writes '[]' to the file", async () => {
    const { store, writeFile } = makeFileStore('[{"id":"old"}]');
    await store.clear();
    const written = vi.mocked(writeFile).mock.calls[0]![1];
    expect(JSON.parse(written)).toEqual([]);
  });

  it("round-trip: saveRules + loadRules preserves all rule fields", async () => {
    const { store } = makeFileStore();
    const rule: AlertRule = {
      id: "rt-rule",
      name: "Round-trip",
      metric: "cost.usd",
      condition: { type: "threshold", operator: "gt", value: 100 },
      severity: "critical",
      cooldownMs: 3_600_000,
      metadata: { team: "platform" },
    };
    await store.saveRules([rule]);
    const [loaded] = await store.loadRules();
    expect(loaded).toMatchObject(rule);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// persistEngineTo / loadEngineFromStore
// ─────────────────────────────────────────────────────────────────────────────

describe("persistEngineTo", () => {
  it("writes all engine rules to store", async () => {
    const engine = new AlertEngine();
    engine.addRule(thresholdRule("r1", "cpu", "gt", 80));
    engine.addRule(thresholdRule("r2", "mem", "gt", 90));
    const store = new MemoryAlertRuleStore();
    await persistEngineTo(engine, store);
    const rules = await store.loadRules();
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("writes empty array when engine has no rules", async () => {
    const engine = new AlertEngine();
    const store = new MemoryAlertRuleStore();
    await persistEngineTo(engine, store);
    expect(await store.loadRules()).toEqual([]);
  });
});

describe("loadEngineFromStore", () => {
  it("loads rules from store into a new engine", async () => {
    const store = new MemoryAlertRuleStore();
    await store.saveRules([thresholdRule("r1", "cpu", "gt", 80), thresholdRule("r2", "mem", "gt", 90)]);
    const engine = await loadEngineFromStore(store);
    expect(engine.listRules()).toHaveLength(2);
    expect(engine.getRule("r1")).toBeDefined();
  });

  it("returns an engine with no rules when store is empty", async () => {
    const store = new MemoryAlertRuleStore();
    const engine = await loadEngineFromStore(store);
    expect(engine.listRules()).toHaveLength(0);
  });

  it("engine from store can evaluate rules immediately", async () => {
    const store = new MemoryAlertRuleStore();
    await store.saveRules([thresholdRule("cost", "cost.usd", "gt", 50, "warning")]);
    const channel = new NullAlertChannel();
    const engine = await loadEngineFromStore(store, { channels: [channel] });
    const result = await engine.evaluate("cost.usd", 100);
    expect(result.fired).toBe(1);
    expect(channel.sent).toHaveLength(1);
  });

  it("persistence round-trip survives restart", async () => {
    // Session 1: create engine, add rules, persist
    const store = new MemoryAlertRuleStore();
    const engine1 = new AlertEngine();
    engine1.addRule(thresholdRule("latency", "latency.p99", "gt", 500, "critical"));
    await persistEngineTo(engine1, store);

    // Session 2: new engine loaded from store — rules intact
    const engine2 = await loadEngineFromStore(store);
    expect(engine2.getRule("latency")).toBeDefined();
    const r = await engine2.evaluate("latency.p99", 600);
    expect(r.fired).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertHistory — circular buffer
// ─────────────────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: "e-" + Math.random().toString(36).slice(2),
    ruleId: "r1",
    ruleName: "test-rule",
    severity: "info",
    metric: "cpu",
    value: 90,
    firedAt: Date.now(),
    ...overrides,
  };
}

describe("AlertHistory", () => {
  it("starts empty", () => {
    const h = new AlertHistory();
    expect(h.size).toBe(0);
    expect(h.getAll()).toEqual([]);
  });

  it("push adds events in order", () => {
    const h = new AlertHistory();
    const e1 = makeEvent({ ruleId: "r1", firedAt: 1000 });
    const e2 = makeEvent({ ruleId: "r2", firedAt: 2000 });
    h.push(e1);
    h.push(e2);
    expect(h.size).toBe(2);
    expect(h.getAll()[0]).toBe(e1);
    expect(h.getAll()[1]).toBe(e2);
  });

  it("getAll returns a defensive copy", () => {
    const h = new AlertHistory();
    h.push(makeEvent());
    const arr = h.getAll();
    arr.length = 0;
    expect(h.size).toBe(1);
  });

  it("evicts oldest entry when maxSize is exceeded", () => {
    const h = new AlertHistory(3);
    const e1 = makeEvent({ ruleId: "old" });
    const e2 = makeEvent({ ruleId: "mid" });
    const e3 = makeEvent({ ruleId: "new3" });
    const e4 = makeEvent({ ruleId: "new4" });
    h.push(e1);
    h.push(e2);
    h.push(e3);
    h.push(e4); // evicts e1
    expect(h.size).toBe(3);
    const all = h.getAll();
    expect(all[0]).toBe(e2);
    expect(all[2]).toBe(e4);
  });

  it("defaults to maxSize 100", () => {
    const h = new AlertHistory();
    for (let i = 0; i < 105; i++) h.push(makeEvent());
    expect(h.size).toBe(100);
  });

  it("getByRule filters by ruleId", () => {
    const h = new AlertHistory();
    h.push(makeEvent({ ruleId: "r1" }));
    h.push(makeEvent({ ruleId: "r2" }));
    h.push(makeEvent({ ruleId: "r1" }));
    const r1Events = h.getByRule("r1");
    expect(r1Events).toHaveLength(2);
    expect(r1Events.every((e) => e.ruleId === "r1")).toBe(true);
  });

  it("getByRule returns empty array when no events match", () => {
    const h = new AlertHistory();
    h.push(makeEvent({ ruleId: "r1" }));
    expect(h.getByRule("r-unknown")).toHaveLength(0);
  });

  it("getBySeverity filters by severity", () => {
    const h = new AlertHistory();
    h.push(makeEvent({ severity: "info" }));
    h.push(makeEvent({ severity: "critical" }));
    h.push(makeEvent({ severity: "critical" }));
    expect(h.getBySeverity("critical")).toHaveLength(2);
    expect(h.getBySeverity("info")).toHaveLength(1);
    expect(h.getBySeverity("warning")).toHaveLength(0);
  });

  it("clear removes all events and resets size", () => {
    const h = new AlertHistory();
    h.push(makeEvent());
    h.push(makeEvent());
    h.clear();
    expect(h.size).toBe(0);
    expect(h.getAll()).toEqual([]);
  });

  it("can push again after clear", () => {
    const h = new AlertHistory(2);
    h.push(makeEvent());
    h.push(makeEvent());
    h.clear();
    h.push(makeEvent({ ruleId: "after-clear" }));
    expect(h.size).toBe(1);
    expect(h.getAll()[0]!.ruleId).toBe("after-clear");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — history integration
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — history integration", () => {
  let history: AlertHistory;

  beforeEach(() => {
    resetClock();
    history = new AlertHistory();
  });

  it("records fired alert in history", async () => {
    const engine = new AlertEngine({ now: mockNow, history });
    engine.addRule(thresholdRule("r1", "cpu", "gt", 80, "warning"));
    await engine.evaluate("cpu", 90);
    expect(history.size).toBe(1);
    expect(history.getByRule("r1")).toHaveLength(1);
  });

  it("does NOT record suppressed (cooldown) alerts in history", async () => {
    const engine = new AlertEngine({ now: mockNow, history });
    engine.addRule(thresholdRule("r1", "cpu", "gt", 80, "info", { cooldownMs: 5000 }));
    await engine.evaluate("cpu", 90);
    advanceMs(100); // still in cooldown
    await engine.evaluate("cpu", 90);
    expect(history.size).toBe(1); // only the first one
  });

  it("does NOT record disabled rule events in history", async () => {
    const engine = new AlertEngine({ now: mockNow, history });
    engine.addRule({ ...thresholdRule("r1", "cpu", "gt", 80, "info"), enabled: false });
    await engine.evaluate("cpu", 90);
    expect(history.size).toBe(0);
  });

  it("records events from multiple rules in one evaluate call", async () => {
    const engine = new AlertEngine({ now: mockNow, history });
    engine.addRule(thresholdRule("r1", "m", "gt", 0, "info"));
    engine.addRule(thresholdRule("r2", "m", "gt", 0, "warning"));
    await engine.evaluate("m", 1);
    expect(history.size).toBe(2);
  });

  it("history events contain correct ruleId and metric", async () => {
    const engine = new AlertEngine({ now: mockNow, history });
    engine.addRule(thresholdRule("cost", "cost.usd", "gt", 10, "critical"));
    await engine.evaluate("cost.usd", 15);
    const ev = history.getAll()[0]!;
    expect(ev.ruleId).toBe("cost");
    expect(ev.metric).toBe("cost.usd");
    expect(ev.value).toBe(15);
    expect(ev.severity).toBe("critical");
  });

  it("works with no history configured — no error", async () => {
    const engine = new AlertEngine({ now: mockNow }); // no history
    engine.addRule(thresholdRule("r1", "m", "gt", 0, "info"));
    await expect(engine.evaluate("m", 1)).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemoryAlertCooldownStore
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryAlertCooldownStore", () => {
  it("loadCooldowns returns {} initially", async () => {
    const store = new MemoryAlertCooldownStore();
    const cooldowns = await store.loadCooldowns();
    expect(cooldowns).toEqual({});
  });

  it("saveCooldown persists ruleId → firedAt", async () => {
    const store = new MemoryAlertCooldownStore();
    await store.saveCooldown("r1", 12345);
    const cooldowns = await store.loadCooldowns();
    expect(cooldowns["r1"]).toBe(12345);
  });

  it("saveCooldown overwrites existing entry for same ruleId", async () => {
    const store = new MemoryAlertCooldownStore();
    await store.saveCooldown("r1", 1000);
    await store.saveCooldown("r1", 2000);
    const cooldowns = await store.loadCooldowns();
    expect(cooldowns["r1"]).toBe(2000);
  });

  it("multiple ruleIds stored independently", async () => {
    const store = new MemoryAlertCooldownStore();
    await store.saveCooldown("r1", 1000);
    await store.saveCooldown("r2", 2000);
    const cooldowns = await store.loadCooldowns();
    expect(Object.keys(cooldowns)).toHaveLength(2);
    expect(cooldowns["r1"]).toBe(1000);
    expect(cooldowns["r2"]).toBe(2000);
  });

  it("deleteCooldown removes entry", async () => {
    const store = new MemoryAlertCooldownStore();
    await store.saveCooldown("r1", 1000);
    await store.deleteCooldown("r1");
    const cooldowns = await store.loadCooldowns();
    expect(cooldowns["r1"]).toBeUndefined();
  });

  it("deleteCooldown is a no-op for unknown ruleId", async () => {
    const store = new MemoryAlertCooldownStore();
    await expect(store.deleteCooldown("nonexistent")).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AlertEngine — cooldown persistence (loadCooldowns / cooldownStore)
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertEngine — cooldown persistence", () => {
  beforeEach(() => { resetClock(); });

  it("loadCooldowns returns 0 when no cooldownStore configured", async () => {
    const engine = new AlertEngine({ now: mockNow });
    const count = await engine.loadCooldowns();
    expect(count).toBe(0);
  });

  it("loadCooldowns returns 0 when store is empty", async () => {
    const cooldownStore = new MemoryAlertCooldownStore();
    const engine = new AlertEngine({ now: mockNow, cooldownStore });
    const count = await engine.loadCooldowns();
    expect(count).toBe(0);
  });

  it("saves lastFiredAt to cooldownStore when alert fires", async () => {
    const cooldownStore = new MemoryAlertCooldownStore();
    const engine = new AlertEngine({ now: mockNow, cooldownStore });
    engine.addRule(thresholdRule("r1", "cpu", "gt", 50, "warning"));
    await engine.evaluate("cpu", 90);
    // Fire-and-forget; give it a tick
    await Promise.resolve();
    const cooldowns = await cooldownStore.loadCooldowns();
    expect(cooldowns["r1"]).toBe(mockNow());
  });

  it("restored cooldown suppresses firing within window after restart", async () => {
    const cooldownStore = new MemoryAlertCooldownStore();

    // Session 1: alert fires at T=1_000_000 with 500s cooldown
    // (Use 500_000 < _time=1_000_000 so the first call fires, not suppressed)
    const engine1 = new AlertEngine({ now: mockNow, cooldownStore });
    engine1.addRule(thresholdRule("r1", "cpu", "gt", 50, "warning", { cooldownMs: 500_000 }));
    await engine1.evaluate("cpu", 90);
    // saveCooldown body runs synchronously (no awaits inside); store is populated

    // Session 2: new engine, restores cooldown; advance only 60s (still in window)
    advanceMs(60_000);
    const engine2 = new AlertEngine({ now: mockNow, cooldownStore });
    engine2.addRule(thresholdRule("r1", "cpu", "gt", 50, "warning", { cooldownMs: 500_000 }));
    const count = await engine2.loadCooldowns();
    expect(count).toBe(1);

    const ch = new NullAlertChannel();
    engine2["channels"].push(ch);

    const result = await engine2.evaluate("cpu", 90);
    expect(result.suppressed).toBe(1); // still in cooldown from session 1
    expect(ch.sent).toHaveLength(0);
  });

  it("restored cooldown allows firing after cooldown expires", async () => {
    const cooldownStore = new MemoryAlertCooldownStore();

    // Session 1: fire at T=1_000_000, cooldown 500_000ms
    const engine1 = new AlertEngine({ now: mockNow, cooldownStore });
    engine1.addRule(thresholdRule("r1", "cpu", "gt", 50, "warning", { cooldownMs: 500_000 }));
    await engine1.evaluate("cpu", 90);

    // Session 2: advance past cooldown window
    advanceMs(500_001);
    const engine2 = new AlertEngine({ now: mockNow, cooldownStore });
    engine2.addRule(thresholdRule("r1", "cpu", "gt", 50, "warning", { cooldownMs: 500_000 }));
    await engine2.loadCooldowns();

    const result = await engine2.evaluate("cpu", 90);
    expect(result.fired).toBe(1); // cooldown expired
    expect(result.suppressed).toBe(0);
  });

  it("removeRule deletes cooldown from store", async () => {
    const cooldownStore = new MemoryAlertCooldownStore();
    const engine = new AlertEngine({ now: mockNow, cooldownStore });
    engine.addRule(thresholdRule("r1", "cpu", "gt", 50, "warning"));
    await engine.evaluate("cpu", 90);
    await Promise.resolve();

    engine.removeRule("r1");
    await Promise.resolve();
    const cooldowns = await cooldownStore.loadCooldowns();
    expect(cooldowns["r1"]).toBeUndefined();
  });

  it("resetCooldown removes entry from store", async () => {
    const cooldownStore = new MemoryAlertCooldownStore();
    const engine = new AlertEngine({ now: mockNow, cooldownStore });
    engine.addRule(thresholdRule("r1", "cpu", "gt", 50, "warning", { cooldownMs: 5000 }));
    await engine.evaluate("cpu", 90);
    await Promise.resolve();

    engine.resetCooldown("r1");
    await Promise.resolve();
    const cooldowns = await cooldownStore.loadCooldowns();
    expect(cooldowns["r1"]).toBeUndefined();
  });

  it("loadEngineFromStore restores cooldowns when cooldownStore in config", async () => {
    const ruleStore = new MemoryAlertRuleStore();
    const cooldownStore = new MemoryAlertCooldownStore();

    // Session 1: fire and persist (cooldownMs 500_000 < _time 1_000_000 so first call fires)
    const engine1 = new AlertEngine({ now: mockNow, cooldownStore });
    engine1.addRule(thresholdRule("latency", "lat", "gt", 100, "critical", { cooldownMs: 500_000 }));
    await persistEngineTo(engine1, ruleStore);
    await engine1.evaluate("lat", 200);

    // Session 2: load from store 1s later, still within cooldown
    advanceMs(1000);
    const engine2 = await loadEngineFromStore(ruleStore, { now: mockNow, cooldownStore });
    const result = await engine2.evaluate("lat", 200);
    expect(result.suppressed).toBe(1);
  });
});
