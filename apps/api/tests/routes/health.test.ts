// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @nexus/db before importing server
vi.mock("@nexus/db", () => ({
  db: {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  },
}));

import { db } from "@nexus/db";

import { buildServer } from "../../src/server.js";

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
