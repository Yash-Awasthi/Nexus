// SPDX-License-Identifier: Apache-2.0
// FreeLLMAPI learned-ceiling port (row 212) — error-body ceiling learning +
// 429 cooldown bench + Retry-After parsing.
import { describe, expect, it } from "vitest";
import {
  CeilingStore,
  CooldownTracker,
  parseProviderLimit,
  parseRetryAfterMs,
  MAX_RETRY_AFTER_MS,
} from "./limit-learning.js";

const T0 = 1_750_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// parseProviderLimit — error-body ceiling extraction
// ─────────────────────────────────────────────────────────────────────────────

describe("parseProviderLimit", () => {
  it("extracts a TPM ceiling from a Groq-shaped 413 body", () => {
    const parsed = parseProviderLimit(
      '{"error":{"message":"...on tokens per minute (TPM): Limit 30000, Requested 33476"}}',
    );
    expect(parsed).toEqual({ axis: "tpm", limit: 30000 });
  });

  it("extracts an RPM ceiling", () => {
    expect(parseProviderLimit("Rate limit reached: requests per minute Limit 60")).toEqual({
      axis: "rpm",
      limit: 60,
    });
  });

  it("prefers the per-day axis over per-minute when both words appear", () => {
    // "tokens per day" must not be shadowed by a later "tpm"-adjacent token.
    expect(parseProviderLimit("daily tokens per day exceeded: tpm budget is 8000, Limit 100000")).toEqual({
      axis: "tpd",
      limit: 100000,
    });
  });

  it("prefers tokens over requests when both axes appear", () => {
    expect(parseProviderLimit("requests per minute ok but tokens per minute Limit 12,000")).toEqual({
      axis: "tpm",
      limit: 12000,
    });
  });

  it("handles thousands separators", () => {
    expect(parseProviderLimit("Limit 300,000 requests per day")).toEqual({ axis: "rpd", limit: 300000 });
  });

  it("refuses to guess the axis (returns null) without a confident one", () => {
    expect(parseProviderLimit("Limit 1000")).toBeNull();
    expect(parseProviderLimit("you have been rate limited")).toBeNull();
  });

  it("returns null for missing or unparseable input", () => {
    expect(parseProviderLimit(null)).toBeNull();
    expect(parseProviderLimit("")).toBeNull();
    expect(parseProviderLimit("Limit zero requests per minute")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CeilingStore — conservative per-key-per-model learning
// ─────────────────────────────────────────────────────────────────────────────

describe("CeilingStore", () => {
  const keyA = { provider: "groq", model: "gpt-oss-120b", key: "key-a" };
  const keyB = { provider: "groq", model: "gpt-oss-120b", key: "key-b" };

  it("starts conservative: unknown ceilings report null and fall back to a default", () => {
    const store = new CeilingStore();
    expect(store.get(keyA, "tpm")).toBeNull();
    expect(store.getOrDefault(keyA, "tpm", 100)).toBe(100);
  });

  it("fills an unknown ceiling from an observed limit response", () => {
    const store = new CeilingStore();
    const learned = store.observe(keyA, "tokens per minute: Limit 30000, Requested 33476");
    expect(learned).toEqual({ axis: "tpm", limit: 30000 });
    expect(store.get(keyA, "tpm")).toBe(30000);
  });

  it("lowers a ceiling that proved too high", () => {
    const store = new CeilingStore();
    store.apply(keyA, "tpm", 60000);
    expect(store.observe(keyA, "tokens per minute Limit 30000, Requested 33476")).toEqual({
      axis: "tpm",
      limit: 30000,
    });
    expect(store.get(keyA, "tpm")).toBe(30000);
  });

  it("never raises a learned ceiling", () => {
    const store = new CeilingStore();
    store.observe(keyA, "tokens per minute Limit 30000");
    // A higher reported limit (e.g. a stale seeded doc) must not overwrite it.
    expect(store.apply(keyA, "tpm", 90000)).toBeNull();
    expect(store.get(keyA, "tpm")).toBe(30000);
    // Direct observation of a higher limit is also a no-op.
    expect(store.observe(keyA, "tpm Limit 50000")).toBeNull();
    expect(store.get(keyA, "tpm")).toBe(30000);
  });

  it("isolates ceilings per key (per-key-per-model counters)", () => {
    const store = new CeilingStore();
    store.observe(keyA, "requests per minute Limit 60");
    expect(store.get(keyA, "rpm")).toBe(60);
    expect(store.get(keyB, "rpm")).toBeNull(); // key B learns nothing from key A's 429
    store.observe(keyB, "requests per minute Limit 120");
    expect(store.get(keyB, "rpm")).toBe(120);
    expect(store.get(keyA, "rpm")).toBe(60);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseRetryAfterMs
// ─────────────────────────────────────────────────────────────────────────────

describe("parseRetryAfterMs", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
  });

  it("parses an HTTP-date and clamps to now-relative", () => {
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(inTenSeconds)!;
    expect(ms).toBeGreaterThan(5_000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("clamps to the one-day maximum", () => {
    expect(parseRetryAfterMs(String(200_000))).toBe(MAX_RETRY_AFTER_MS);
  });

  it("returns undefined for unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon-ish")).toBeUndefined();
    expect(parseRetryAfterMs("  ")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CooldownTracker — 429 bench escalation + recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("CooldownTracker", () => {
  const route = "groq:gpt-oss-120b:key-a";

  it("benches a transient 429 briefly without escalating", () => {
    const tracker = new CooldownTracker();
    const v = tracker.recordRateLimited(route, { grade: "transient" }, T0);
    expect(v).toEqual({ durationMs: 90_000, source: "heuristic" });
    // Repeated transients stay short — they never climb the ladder.
    const v2 = tracker.recordRateLimited(route, { grade: "transient" }, T0 + 5_000);
    expect(v2.durationMs).toBe(90_000);
    expect(tracker.isBenched(route, T0 + 10_000)).toBe(true);
    expect(tracker.benchRemainingMs(route, T0 + 95_000)).toBe(0);
  });

  it("escalates exhausted 429s through the ladder (2m → 10m → 1h → 24h)", () => {
    const tracker = new CooldownTracker();
    const d1 = tracker.recordRateLimited(route, { grade: "exhausted" }, T0);
    const d2 = tracker.recordRateLimited(route, { grade: "exhausted" }, T0 + 1_000);
    const d3 = tracker.recordRateLimited(route, { grade: "exhausted" }, T0 + 2_000);
    const d4 = tracker.recordRateLimited(route, { grade: "exhausted" }, T0 + 3_000);
    expect([d1.durationMs, d2.durationMs, d3.durationMs, d4.durationMs]).toEqual([
      2 * 60_000, 10 * 60_000, 60 * 60_000, 24 * 60 * 60_000,
    ]);
    expect(d1.source).toBe("heuristic");
  });

  it("honors an authoritative Retry-After hint over the ladder", () => {
    const tracker = new CooldownTracker();
    const v = tracker.recordRateLimited(route, { grade: "exhausted", retryAfterMs: 45_000 }, T0);
    expect(v).toEqual({ durationMs: 45_000, source: "authoritative" });
    // A later exhausted 429 without a hint must NOT inherit a 24h bench from the hint.
    const d2 = tracker.recordRateLimited(route, { grade: "exhausted" }, T0 + 46_000);
    expect(d2.durationMs).toBe(2 * 60_000); // ladder restarts: first escalation hit
  });

  it("caps unknown-limit escalation at the 10-minute guess and needs 2 hits/hour", () => {
    const tracker = new CooldownTracker();
    const first = tracker.recordRateLimited(route, { grade: "unknown" }, T0);
    expect(first.durationMs).toBe(90_000); // below the 2-hit threshold → transient
    const hits: number[] = [];
    for (let i = 0; i < 5; i++) {
      hits.push(
        tracker.recordRateLimited(route, { grade: "unknown" }, T0 + 60_000 * (i + 1)).durationMs,
      );
    }
    // Crossed the threshold → ladder, capped at 10 minutes even as hits pile up.
    expect(hits[0]).toBe(2 * 60_000);
    expect(hits[4]).toBe(10 * 60_000);
    // Old hits (older than 1h) roll out; a fresh single 429 drops back to transient.
    const afterGap = tracker.recordRateLimited(route, { grade: "unknown" }, T0 + 2 * 60 * 60_000);
    expect(afterGap.durationMs).toBe(90_000);
  });

  it("success clears the bench and the ladder history (reversibility)", () => {
    const tracker = new CooldownTracker();
    tracker.recordRateLimited(route, { grade: "exhausted" }, T0);
    tracker.recordRateLimited(route, { grade: "exhausted" }, T0 + 1_000); // ladder at 10m
    expect(tracker.benchRemainingMs(route, T0 + 1_000)).toBe(10 * 60_000);
    tracker.onSuccess(route);
    expect(tracker.isBenched(route, T0 + 1_000)).toBe(false);
    // Next failure starts the ladder over short.
    const again = tracker.recordRateLimited(route, { grade: "exhausted" }, T0 + 2_000);
    expect(again.durationMs).toBe(2 * 60_000);
  });

  it("isolates benches per route", () => {
    const tracker = new CooldownTracker();
    const other = "groq:gpt-oss-120b:key-b";
    tracker.recordRateLimited(route, { grade: "exhausted" }, T0);
    expect(tracker.isBenched(route, T0)).toBe(true);
    expect(tracker.isBenched(other, T0)).toBe(false);
    tracker.onSuccess(other); // no-op on an unrelated route
    expect(tracker.isBenched(route, T0)).toBe(true);
  });

  it("re-escalates from stale ladder hits only while they are recent", () => {
    const tracker = new CooldownTracker();
    tracker.recordRateLimited(route, { grade: "exhausted" }, T0);
    tracker.recordRateLimited(route, { grade: "exhausted" }, T0 + 1_000); // 10m
    // More than 24h later the old hits have rolled out of the window.
    const late = tracker.recordRateLimited(route, { grade: "exhausted" }, T0 + 25 * 60 * 60_000);
    expect(late.durationMs).toBe(2 * 60_000);
  });
});
