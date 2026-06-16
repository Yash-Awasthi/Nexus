// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DeltaTrigger,
  CronTrigger,
  NLTrigger,
  WebhookTrigger,
  TriggerRegistry,
  type TriggerEvent,
  type Destination,
} from "../src/index.js";

// ── DeltaTrigger ──────────────────────────────────────────────────────────────

describe("DeltaTrigger", () => {
  it("fires when field changes", () => {
    const t = new DeltaTrigger({ name: "status-change", field: "status" });
    expect(t.matches({ field: "status", oldValue: "draft", newValue: "published" })).toBe(true);
  });

  it("does not fire when field is the same", () => {
    const t = new DeltaTrigger({ name: "t", field: "status" });
    expect(t.matches({ field: "status", oldValue: "draft", newValue: "draft" })).toBe(false);
  });

  it("does not fire for a different field", () => {
    const t = new DeltaTrigger({ name: "t", field: "status" });
    expect(t.matches({ field: "title", oldValue: "A", newValue: "B" })).toBe(false);
  });

  it("matches against string matchValue", () => {
    const t = new DeltaTrigger({ name: "t", field: "status", matchValue: "published" });
    expect(t.matches({ field: "status", oldValue: "draft", newValue: "published" })).toBe(true);
    expect(t.matches({ field: "status", oldValue: "draft", newValue: "archived" })).toBe(false);
  });

  it("matches against RegExp matchValue", () => {
    const t = new DeltaTrigger({ name: "t", field: "score", matchValue: /^9\d$/ });
    expect(t.matches({ field: "score", oldValue: "50", newValue: "95" })).toBe(true);
    expect(t.matches({ field: "score", oldValue: "50", newValue: "75" })).toBe(false);
  });

  it("does not fire when paused", () => {
    const t = new DeltaTrigger({ name: "t", field: "status" });
    t.status = "paused";
    expect(t.matches({ field: "status", oldValue: "a", newValue: "b" })).toBe(false);
  });

  it("has correct type and default properties", () => {
    const t = new DeltaTrigger({ name: "watcher", field: "meta.status" });
    expect(t.type).toBe("delta");
    expect(t.status).toBe("active");
    expect(t.id).toMatch(/^delta-/);
    expect(t.destinations).toEqual([]);
    expect(t.createdAt).toBeTruthy();
  });

  it("accepts destinations in config", () => {
    const fn = vi.fn();
    const dest: Destination = { type: "function", fn };
    const t = new DeltaTrigger({ name: "t", field: "x", destinations: [dest] });
    expect(t.destinations).toHaveLength(1);
  });
});

// ── CronTrigger ───────────────────────────────────────────────────────────────

describe("CronTrigger", () => {
  it("fires when nowMs passes next hourly tick", () => {
    const t = new CronTrigger({ name: "hourly", schedule: "@hourly" });
    t._setLastFiredMs(Date.now() - 3_700_000); // 1h 1m 40s ago
    expect(t.matches({ nowMs: Date.now() })).toBe(true);
  });

  it("does not fire before next hourly tick", () => {
    const t = new CronTrigger({ name: "hourly", schedule: "@hourly" });
    t._setLastFiredMs(Date.now() - 1_800_000); // 30min ago
    expect(t.matches({ nowMs: Date.now() })).toBe(false);
  });

  it("fires on @daily schedule", () => {
    const t = new CronTrigger({ name: "daily", schedule: "@daily" });
    t._setLastFiredMs(Date.now() - 86_500_000);
    expect(t.matches({ nowMs: Date.now() })).toBe(true);
  });

  it("fires on @weekly schedule", () => {
    const t = new CronTrigger({ name: "weekly", schedule: "@weekly" });
    t._setLastFiredMs(Date.now() - 604_900_000);
    expect(t.matches({ nowMs: Date.now() })).toBe(true);
  });

  it("fires on @minutely schedule", () => {
    const t = new CronTrigger({ name: "min", schedule: "@minutely" });
    t._setLastFiredMs(Date.now() - 61_000);
    expect(t.matches({ nowMs: Date.now() })).toBe(true);
  });

  it("fires on HH:MM schedule when time has passed", () => {
    const t = new CronTrigger({ name: "hhmm", schedule: "00:00" });
    // last fired a day ago so next target is today at 00:00 or tomorrow
    t._setLastFiredMs(Date.now() - 86_400_000 * 2);
    expect(t.matches({ nowMs: Date.now() })).toBe(true);
  });

  it("throws for unsupported schedule", () => {
    const t = new CronTrigger({ name: "bad", schedule: "bad-cron" });
    t._setLastFiredMs(0);
    expect(() => t.matches({ nowMs: Date.now() })).toThrow("Unsupported schedule");
  });

  it("does not fire when paused", () => {
    const t = new CronTrigger({ name: "t", schedule: "@minutely" });
    t.status = "paused";
    t._setLastFiredMs(0);
    expect(t.matches({ nowMs: Date.now() })).toBe(false);
  });

  it("has correct type", () => {
    const t = new CronTrigger({ name: "t", schedule: "@daily" });
    expect(t.type).toBe("cron");
    expect(t.id).toMatch(/^cron-/);
  });

  it("updates lastFiredMs after firing", () => {
    const t = new CronTrigger({ name: "t", schedule: "@minutely" });
    t._setLastFiredMs(0);
    const now = Date.now();
    t.matches({ nowMs: now });
    // fires and updates lastFiredMs — next call with same now should not fire
    expect(t.matches({ nowMs: now })).toBe(false);
  });
});

// ── NLTrigger ─────────────────────────────────────────────────────────────────

describe("NLTrigger", () => {
  it("matches when enough keywords overlap", () => {
    const t = new NLTrigger({
      name: "deploy-alert",
      description: "When a deployment fails or production error occurs",
    });
    expect(t.matches({ description: "production deployment failed with error" })).toBe(true);
  });

  it("does not match on irrelevant description", () => {
    const t = new NLTrigger({
      name: "deploy-alert",
      description: "When a deployment fails or production error occurs",
    });
    expect(t.matches({ description: "user updated their profile picture today" })).toBe(false);
  });

  it("returns false for empty context description", () => {
    const t = new NLTrigger({ name: "t", description: "database backup completed" });
    expect(t.matches({})).toBe(false);
    expect(t.matches({ description: "" })).toBe(false);
  });

  it("does not fire when paused", () => {
    const t = new NLTrigger({ name: "t", description: "payment received successfully" });
    t.status = "paused";
    expect(t.matches({ description: "payment received successfully" })).toBe(false);
  });

  it("has correct type", () => {
    const t = new NLTrigger({ name: "t", description: "something happened" });
    expect(t.type).toBe("nl");
    expect(t.id).toMatch(/^nl-/);
  });

  it("filters stop words from description", () => {
    // "the" "is" "a" are stop words — keyword set should be small
    const t = new NLTrigger({ name: "t", description: "the item is a failure" });
    // "item" and "failure" are keywords (>2 chars, not stop words)
    expect(t.matches({ description: "item failure detected" })).toBe(true);
  });

  it("stores description", () => {
    const t = new NLTrigger({ name: "t", description: "user signed up" });
    expect(t.description).toBe("user signed up");
  });
});

// ── WebhookTrigger ────────────────────────────────────────────────────────────

describe("WebhookTrigger", () => {
  it("matches any event when no eventType configured", () => {
    const t = new WebhookTrigger({ name: "catch-all" });
    expect(t.matches({ eventType: "anything" })).toBe(true);
    expect(t.matches({})).toBe(true);
  });

  it("matches specific eventType", () => {
    const t = new WebhookTrigger({ name: "pr", eventType: "pull_request.opened" });
    expect(t.matches({ eventType: "pull_request.opened" })).toBe(true);
    expect(t.matches({ eventType: "pull_request.closed" })).toBe(false);
  });

  it("does not fire when paused", () => {
    const t = new WebhookTrigger({ name: "t", eventType: "push" });
    t.status = "paused";
    expect(t.matches({ eventType: "push" })).toBe(false);
  });

  it("has correct type", () => {
    const t = new WebhookTrigger({ name: "t" });
    expect(t.type).toBe("webhook");
    expect(t.id).toMatch(/^wh-/);
  });
});

// ── TriggerRegistry ───────────────────────────────────────────────────────────

describe("TriggerRegistry", () => {
  let registry: TriggerRegistry;

  beforeEach(() => {
    registry = new TriggerRegistry();
  });

  it("registers and retrieves a trigger", () => {
    const t = new WebhookTrigger({ name: "t" });
    registry.register(t);
    expect(registry.get(t.id)).toBe(t);
  });

  it("deregisters a trigger", () => {
    const t = new WebhookTrigger({ name: "t" });
    registry.register(t);
    expect(registry.deregister(t.id)).toBe(true);
    expect(registry.get(t.id)).toBeUndefined();
  });

  it("deregister returns false for unknown id", () => {
    expect(registry.deregister("nonexistent")).toBe(false);
  });

  it("counts triggers", () => {
    registry.register(new DeltaTrigger({ name: "d", field: "f" }));
    registry.register(new CronTrigger({ name: "c", schedule: "@daily" }));
    expect(registry.count()).toBe(2);
  });

  it("lists all triggers", () => {
    registry.register(new DeltaTrigger({ name: "d", field: "f" }));
    registry.register(new WebhookTrigger({ name: "w" }));
    expect(registry.list()).toHaveLength(2);
  });

  it("lists triggers filtered by type", () => {
    registry.register(new DeltaTrigger({ name: "d1", field: "f" }));
    registry.register(new DeltaTrigger({ name: "d2", field: "g" }));
    registry.register(new WebhookTrigger({ name: "w" }));
    expect(registry.list("delta")).toHaveLength(2);
    expect(registry.list("webhook")).toHaveLength(1);
    expect(registry.list("nl")).toHaveLength(0);
  });

  it("register supports chaining", () => {
    const t = new WebhookTrigger({ name: "t" });
    expect(registry.register(t)).toBe(registry);
  });

  it("evaluate returns fired=true for matching triggers", async () => {
    const t = new WebhookTrigger({ name: "pr", eventType: "push" });
    registry.register(t);
    const results = await registry.evaluate({ eventType: "push" });
    expect(results).toHaveLength(1);
    expect(results[0]!.fired).toBe(true);
    expect(results[0]!.trigger.id).toBe(t.id);
  });

  it("evaluate returns fired=false for non-matching triggers", async () => {
    const t = new WebhookTrigger({ name: "pr", eventType: "push" });
    registry.register(t);
    const results = await registry.evaluate({ eventType: "merge" });
    expect(results[0]!.fired).toBe(false);
    expect(results[0]!.deliveryResults).toHaveLength(0);
  });

  it("evaluate skips paused triggers", async () => {
    const t = new WebhookTrigger({ name: "t" });
    t.status = "paused";
    registry.register(t);
    const results = await registry.evaluate({});
    expect(results).toHaveLength(0);
  });

  it("evaluate delivers to function destination", async () => {
    const received: TriggerEvent[] = [];
    const dest: Destination = {
      type: "function",
      fn: (e) => {
        received.push(e);
      },
    };
    const t = new WebhookTrigger({ name: "t", destinations: [dest] });
    registry.register(t);
    await registry.evaluate({ eventType: "any" });
    expect(received).toHaveLength(1);
    expect(received[0]!.triggerType).toBe("webhook");
    expect(received[0]!.triggerId).toBe(t.id);
  });

  it("evaluate delivers to url destination (acknowledges success)", async () => {
    const dest: Destination = { type: "url", url: "https://example.com/hook" };
    const t = new WebhookTrigger({ name: "t", destinations: [dest] });
    registry.register(t);
    const results = await registry.evaluate({});
    expect(results[0]!.deliveryResults[0]!.success).toBe(true);
  });

  it("evaluate captures delivery errors", async () => {
    const dest: Destination = {
      type: "function",
      fn: () => {
        throw new Error("handler exploded");
      },
    };
    const t = new WebhookTrigger({ name: "t", destinations: [dest] });
    registry.register(t);
    const results = await registry.evaluate({});
    expect(results[0]!.deliveryResults[0]!.success).toBe(false);
    expect(results[0]!.deliveryResults[0]!.error).toContain("handler exploded");
  });

  it("evaluate returns delivery failure for misconfigured destination", async () => {
    const dest: Destination = { type: "function" }; // no fn
    const t = new WebhookTrigger({ name: "t", destinations: [dest] });
    registry.register(t);
    const results = await registry.evaluate({});
    expect(results[0]!.deliveryResults[0]!.success).toBe(false);
    expect(results[0]!.deliveryResults[0]!.error).toContain("No handler");
  });

  it("evaluate delivers event payload from context", async () => {
    const received: TriggerEvent[] = [];
    const dest: Destination = {
      type: "function",
      fn: (e) => {
        received.push(e);
      },
    };
    const t = new DeltaTrigger({ name: "d", field: "status", destinations: [dest] });
    registry.register(t);
    await registry.evaluate({ field: "status", oldValue: "a", newValue: "b" });
    expect(received[0]!.payload).toMatchObject({ field: "status", newValue: "b" });
    expect(received[0]!.firedAt).toBeTruthy();
  });

  it("evaluate handles async destination functions", async () => {
    let resolved = false;
    const dest: Destination = {
      type: "function",
      fn: async () => {
        await Promise.resolve();
        resolved = true;
      },
    };
    const t = new WebhookTrigger({ name: "t", destinations: [dest] });
    registry.register(t);
    await registry.evaluate({});
    expect(resolved).toBe(true);
  });
});
