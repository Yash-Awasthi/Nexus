// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @nexus/db before importing server
vi.mock("@nexus/db", () => ({
  db: {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  },
}));

// The full buildServer import chain pulls in every route module, and
// obs-providers.ts constructs a Pg-backed store at MODULE SCOPE whenever
// DATABASE_URL is set (tests/setup.ts always sets it), firing an eager
// CREATE TABLE at import. The health surface never touches Postgres beyond the
// mocked @nexus/db above, so stub `pg` to keep this file hermetic.
vi.mock("pg", () => {
  class FakePool {
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    on = vi.fn().mockReturnThis();
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: FakePool };
});

import { db } from "@nexus/db";

import { buildServer } from "../../src/server.js";
import { costLogStore } from "../../src/lib/cost-log.js";

describe("GET /health", () => {
  it("returns 200 with status, version, and timestamp", async () => {
    const app = await buildServer();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; version: string; timestamp: string }>();
    expect(body.status).toBe("ok");
    expect(body.version).toBeTruthy();
    expect(new Date(body.timestamp).getTime()).not.toBeNaN();

    await app.close();
  });
});

describe("GET /health/ready", () => {
  beforeEach(() => {
    vi.mocked(db.execute).mockResolvedValue([{ "?column?": 1 }] as never);
  });

  it("returns 200 with ready status when DB is healthy", async () => {
    const app = await buildServer();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health/ready" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; checks: Record<string, string> }>();
    expect(body.status).toBe("ready");
    expect(body.checks.db).toBe("ok");

    await app.close();
  });

  it("surfaces cost-log flush stats and stays ready while persistence is healthy", async () => {
    const app = await buildServer();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health/ready" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      checks: Record<string, string>;
      costLog: { pendingEntries: number; consecutiveFailures: number };
    }>();
    expect(body.checks.costlog_flush).toBe("ok");
    // Raw stats ride every readiness response so an operator always sees the
    // flush age / pending tail — not only when the probe trips.
    expect(body.costLog.pendingEntries).toBe(0);
    expect(body.costLog.consecutiveFailures).toBe(0);

    await app.close();
  });

  it("shows a pending tail mid-window and the onClose hook flushes it", async () => {
    const app = await buildServer();
    await app.ready();

    costLogStore.record({
      ts: new Date().toISOString(),
      model: "test/model",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.000001,
    });
    // Inside the 2 s debounce window the entry is still pending → visible.
    const res1 = await app.inject({ method: "GET", url: "/health/ready" });
    const body1 = res1.json<{ costLog: { pendingEntries: number } }>();
    expect(body1.costLog.pendingEntries).toBeGreaterThanOrEqual(1);

    // Graceful close (the SIGTERM/SIGINT path drains through app.close()) must
    // flush the pending tail rather than losing the debounce window.
    await app.close();
    expect(costLogStore.flushStats().pendingEntries).toBe(0);
  });

  it("returns 503 when DB check throws", async () => {
    vi.mocked(db.execute).mockRejectedValue(new Error("connection refused") as never);
    const app = await buildServer();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health/ready" });

    expect(res.statusCode).toBe(503);
    const body = res.json<{
      status: string;
      checks: Record<string, string>;
      messages: Record<string, string>;
    }>();
    // Aggregated readiness: a failed critical probe (db) drives status to "down".
    expect(body.status).toBe("down");
    expect(body.checks.db).toBe("fail");
    expect(body.messages.db).toMatch(/refused|error|fail/i);

    await app.close();
  });
});
