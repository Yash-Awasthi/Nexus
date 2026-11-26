// SPDX-License-Identifier: Apache-2.0
/**
 * `GET /status`: the five dependencies named, with what was measured for each.
 *
 * The interesting properties are not "it returns JSON" but: a broken critical dependency is a
 * 503 while a broken optional one is not, and nothing in the answer names a host or a key.
 */
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@nexus/db", () => ({
  db: {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  },
}));

// The module graph builds Pg-backed stores at import when DATABASE_URL is set.
vi.mock("pg", () => {
  class FakePool {
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    on = vi.fn().mockReturnThis();
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: FakePool };
});

// The model row asks the provider registry. One healthy provider, so the unit test does not
// depend on which keys a developer's shell happens to export.
vi.mock("../../src/lib/llm-failover.ts", () => ({
  getProviderSnapshot: () => [
    { id: "p1", provider: "openai", model: "gpt-4.1-mini", streaming: true },
  ],
  getProviderStats: () => ({ order: ["p1"], providers: [], lastServedBy: null }),
}));

import { db } from "@nexus/db";
import Fastify from "fastify";

import { statusRoutes, summarise, type StatusRow } from "../../src/routes/status.ts";

const app = async (opts: { docker: boolean; sandbox?: boolean } = { docker: true }) => {
  const instance = Fastify();
  await statusRoutes(instance, {
    dockerReady: Promise.resolve(opts.docker),
    sandboxReady: () => opts.sandbox ?? true,
  });
  await instance.ready();
  return instance;
};

describe("GET /status", () => {
  it("names every dependency the service needs, and what was measured", async () => {
    vi.mocked(db.execute).mockResolvedValue([{ "?column?": 1 }] as never);
    const server = await app();
    const res = await server.inject({ method: "GET", url: "/status" });
    const body = res.json<{
      status: string;
      version: string;
      uptimeSeconds: number;
      checkedAt: string;
      rows: StatusRow[];
    }>();

    expect(body.rows.map((row) => row.name)).toEqual([
      "postgres",
      "redis",
      "model",
      "sandbox",
      "docker",
    ]);
    for (const row of body.rows) {
      expect(typeof row.ok).toBe("boolean");
      expect(row.detail.length).toBeGreaterThan(0);
      expect(row.ms).toBeGreaterThanOrEqual(0);
    }
    expect(body.rows.find((row) => row.name === "postgres")!.detail).toBe("answered a select 1");
    expect(body.version).toBeTruthy();
    expect(new Date(body.checkedAt).getTime()).not.toBeNaN();
    await server.close();
  });

  it("is 503 when a critical dependency is down, and 200 when only an optional one is", async () => {
    vi.mocked(db.execute).mockRejectedValueOnce(new Error("no route to host"));
    const down = await app();
    const downRes = await down.inject({ method: "GET", url: "/status" });
    expect(downRes.statusCode).toBe(503);
    expect(downRes.json<{ status: string }>().status).toBe("down");
    // The failure is described without the hostname the driver put in its error.
    expect(downRes.body).not.toContain("no route to host");
    await down.close();

    vi.mocked(db.execute).mockResolvedValue([{ "?column?": 1 }] as never);
    // No Docker daemon is a degradation: the in-process runtimes still work.
    const degraded = await app({ docker: false });
    const degradedRes = await degraded.inject({ method: "GET", url: "/status" });
    expect(degradedRes.statusCode).toBe(200);
    const body = degradedRes.json<{ status: string; rows: StatusRow[] }>();
    expect(body.status).toBe("degraded");
    expect(body.rows.find((row) => row.name === "docker")).toMatchObject({ ok: false, critical: false });
    await degraded.close();
  });

  it("serves the cached answer twice rather than probing on every poll", async () => {
    vi.mocked(db.execute).mockClear();
    const server = await app();
    await server.inject({ method: "GET", url: "/status" });
    const afterFirst = vi.mocked(db.execute).mock.calls.length;
    await server.inject({ method: "GET", url: "/status" });
    expect(vi.mocked(db.execute).mock.calls.length).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(0);
    await server.close();
  });
});

describe("summarise", () => {
  const row = (name: StatusRow["name"], ok: boolean, critical: boolean): StatusRow => ({
    name,
    ok,
    critical,
    detail: "",
    ms: 0,
  });

  it("is down for a broken critical dependency, degraded for a broken optional one", () => {
    expect(summarise([row("postgres", true, true), row("docker", false, false)])).toBe("degraded");
    expect(summarise([row("postgres", false, true), row("docker", true, false)])).toBe("down");
    expect(summarise([row("postgres", true, true), row("docker", true, false)])).toBe("ok");
  });
});
