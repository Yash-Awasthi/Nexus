// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  bulkCall,
  sequentialBulkCall,
  BulkToolCaller,
  NullMcpToolClient,
  type BulkCallSummary,
  type BulkToolRequest,
} from "../src/index.js";

// ── NullMcpToolClient ─────────────────────────────────────────────────────────
// NullMcpToolClient({ responses?, error?, delayMs? })
// Default: returns { content: [{ type: "text", text: "null result for <name>(...)" }], isError: false, text: "..." }

describe("NullMcpToolClient", () => {
  it("resolves without throwing", async () => {
    const client = new NullMcpToolClient();
    await expect(client.callTool("any_tool", {})).resolves.toBeDefined();
  });

  it("returns isError: false by default", async () => {
    const client = new NullMcpToolClient();
    const result = await client.callTool("any_tool", {});
    expect(result.isError).toBe(false);
  });

  it("returns preconfigured response when tool name matches", async () => {
    const client = new NullMcpToolClient({
      responses: {
        get_status: { content: [{ type: "text", text: "ok" }], isError: false, text: "ok" },
      },
    });
    const result = await client.callTool("get_status", {});
    expect(result.text).toBe("ok");
  });

  it("throws when error option is set", async () => {
    const client = new NullMcpToolClient({ error: "forced error" });
    await expect(client.callTool("tool", {})).rejects.toThrow("forced error");
  });
});

// ── bulkCall (parallel) — returns BulkCallSummary ─────────────────────────────

describe("bulkCall", () => {
  // BulkToolRequest: { id?, tool, args? }
  const REQUESTS: BulkToolRequest[] = [
    { tool: "read_file", args: { path: "/a.txt" } },
    { tool: "read_file", args: { path: "/b.txt" } },
    { tool: "read_file", args: { path: "/c.txt" } },
  ];

  it("returns a BulkCallSummary with correct total", async () => {
    const client = new NullMcpToolClient();
    const summary = await bulkCall(client, REQUESTS);
    expect(summary.total).toBe(3);
  });

  it("summary.results has one entry per request", async () => {
    const client = new NullMcpToolClient();
    const summary = await bulkCall(client, REQUESTS);
    expect(summary.results).toHaveLength(3);
  });

  it("marks all results as success when no errors", async () => {
    const client = new NullMcpToolClient();
    const summary = await bulkCall(client, REQUESTS);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    for (const r of summary.results) {
      expect(r.success).toBe(true);
    }
  });

  it("isolates individual call errors — rest succeed", async () => {
    let callCount = 0;
    const client = {
      async callTool(_name: string, _args: Record<string, unknown>) {
        callCount++;
        if (callCount === 2) throw new Error("tool error");
        return { content: [{ type: "text", text: "ok" }], isError: false, text: "ok" };
      },
    };
    const summary = await bulkCall(client, REQUESTS);
    expect(summary.results[0]?.success).toBe(true);
    expect(summary.results[1]?.success).toBe(false);
    expect(summary.results[1]?.error).toMatch(/tool error/);
    expect(summary.results[2]?.success).toBe(true);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it("returns summary with zero totals for empty requests", async () => {
    const client = new NullMcpToolClient();
    const summary = await bulkCall(client, []);
    expect(summary.total).toBe(0);
    expect(summary.results).toHaveLength(0);
  });

  it("fires all calls in parallel (total time ≈ one call time)", async () => {
    const client = {
      async callTool(_n: string, _a: Record<string, unknown>) {
        await new Promise((r) => setTimeout(r, 10));
        return { content: [], isError: false, text: "" };
      },
    };
    const reqs: BulkToolRequest[] = Array.from({ length: 4 }, (_, i) => ({ tool: `t${i}`, args: {} }));
    const t0 = Date.now();
    await bulkCall(client, reqs);
    const elapsed = Date.now() - t0;
    // 4 × 10ms in parallel → ~10ms not ~40ms
    expect(elapsed).toBeLessThan(80);
  });

  it("each result has tool, id, durationMs", async () => {
    const client = new NullMcpToolClient();
    const summary = await bulkCall(client, [{ tool: "ping", args: {} }]);
    const r = summary.results[0];
    expect(r?.tool).toBe("ping");
    expect(typeof r?.durationMs).toBe("number");
    expect(r?.id).toBeDefined();
  });
});

// ── sequentialBulkCall ────────────────────────────────────────────────────────

describe("sequentialBulkCall", () => {
  const REQUESTS: BulkToolRequest[] = [
    { tool: "tool_a", args: {} },
    { tool: "tool_b", args: {} },
  ];

  it("calls tools in order", async () => {
    const order: string[] = [];
    const client = {
      async callTool(name: string, _args: Record<string, unknown>) {
        order.push(name);
        return { content: [], isError: false, text: "" };
      },
    };
    await sequentialBulkCall(client, REQUESTS);
    expect(order).toEqual(["tool_a", "tool_b"]);
  });

  it("returns summary with correct total", async () => {
    const client = new NullMcpToolClient();
    const summary = await sequentialBulkCall(client, REQUESTS);
    expect(summary.total).toBe(2);
    expect(summary.results).toHaveLength(2);
  });

  it("isolates errors and continues processing remaining calls", async () => {
    let callCount = 0;
    const client = {
      async callTool(_n: string, _a: Record<string, unknown>) {
        callCount++;
        if (callCount === 1) throw new Error("fail");
        return { content: [], isError: false, text: "" };
      },
    };
    const summary = await sequentialBulkCall(client, REQUESTS);
    expect(summary.results[0]?.success).toBe(false);
    expect(summary.results[1]?.success).toBe(true);
    expect(callCount).toBe(2);
  });

  it("respects optional delayMs between calls", async () => {
    const timestamps: number[] = [];
    const client = {
      async callTool(_n: string, _a: Record<string, unknown>) {
        timestamps.push(Date.now());
        return { content: [], isError: false, text: "" };
      },
    };
    await sequentialBulkCall(client, REQUESTS, { delayMs: 30 });
    expect(timestamps).toHaveLength(2);
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(25);
  });
});

// ── BulkToolCaller class ──────────────────────────────────────────────────────
// BulkToolCaller({ client, mode?, delayMs?, maxBatchSize? })
// .call(requests) → BulkCallSummary
// .callInBatches(requests, batchSize) → BulkCallSummary[]

describe("BulkToolCaller", () => {
  it(".call() in parallel mode returns summary for all requests", async () => {
    const client = new NullMcpToolClient();
    const caller = new BulkToolCaller({ client });
    const requests: BulkToolRequest[] = [
      { tool: "a", args: {} },
      { tool: "b", args: {} },
    ];
    const summary = await caller.call(requests);
    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(2);
  });

  it(".call() in sequential mode processes in order", async () => {
    const order: string[] = [];
    const client = {
      async callTool(name: string, _a: Record<string, unknown>) {
        order.push(name);
        return { content: [], isError: false, text: "" };
      },
    };
    const caller = new BulkToolCaller({ client, mode: "sequential" });
    await caller.call([{ tool: "first", args: {} }, { tool: "second", args: {} }]);
    expect(order).toEqual(["first", "second"]);
  });

  it(".call() returns empty summary for empty array", async () => {
    const client = new NullMcpToolClient();
    const caller = new BulkToolCaller({ client });
    const summary = await caller.call([]);
    expect(summary.total).toBe(0);
    expect(summary.results).toHaveLength(0);
  });

  it(".callInBatches() splits requests into batches", async () => {
    const client = new NullMcpToolClient();
    const caller = new BulkToolCaller({ client });
    const reqs: BulkToolRequest[] = Array.from({ length: 6 }, (_, i) => ({ tool: `t${i}`, args: {} }));
    const summaries = await caller.callInBatches(reqs, 2);
    expect(summaries).toHaveLength(3); // 6 / 2 = 3 batches
    for (const s of summaries) {
      expect(s.total).toBe(2);
    }
  });

  it(".call() throws when request count exceeds maxBatchSize", async () => {
    const client = new NullMcpToolClient();
    const caller = new BulkToolCaller({ client, maxBatchSize: 2 });
    const reqs: BulkToolRequest[] = Array.from({ length: 5 }, (_, i) => ({ tool: `t${i}`, args: {} }));
    await expect(caller.call(reqs)).rejects.toThrow();
  });

  it("summary has correct succeeded/failed counts", async () => {
    let n = 0;
    const client = {
      async callTool(_name: string, _args: Record<string, unknown>) {
        n++;
        if (n === 2) throw new Error("boom");
        return { content: [], isError: false, text: "" };
      },
    };
    const caller = new BulkToolCaller({ client });
    const summary: BulkCallSummary = await caller.call([
      { tool: "a", args: {} },
      { tool: "b", args: {} },
      { tool: "c", args: {} },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
  });
});
