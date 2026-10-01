// SPDX-License-Identifier: Apache-2.0
/**
 * Admin request traces survive a restart on both backings and keep only the
 * newest 1000. A re-import after vi.resetModules is the restart.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Traces = typeof import("../../src/lib/request-traces.js");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-traces-"));
const prev = { db: process.env.DATABASE_URL, dir: process.env.NEXUS_DATA_DIR };

async function boot(): Promise<Traces> {
  vi.resetModules();
  return (await import("../../src/lib/request-traces.js")) as Traces;
}

function record(t: Traces, n: number): void {
  for (let i = 0; i < n; i++) {
    t.recordTrace({
      method: "POST",
      url: `/api/chat?i=${i}`,
      status: 200,
      userId: "u1",
      latencyMs: 5,
      steps: [
        {
          provider: "groq",
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 5,
          cached: false,
        },
      ],
    });
  }
}

beforeAll(() => {
  process.env.NEXUS_DATA_DIR = dataDir;
});

afterAll(() => {
  for (const [k, v] of [
    ["DATABASE_URL", prev.db],
    ["NEXUS_DATA_DIR", prev.dir],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("request traces", () => {
  it("appends to a JSONL file and compacts it past twice the cap", async () => {
    delete process.env.DATABASE_URL;
    let t = await boot();
    record(t, 3);
    await t.flushTraces();
    t = await boot();
    const page = await t.listTraces({ page: 1, limit: 10 });
    expect(page.total).toBe(3);
    expect(page.traces[0]?.path).toBe("/api/chat");
    expect(await t.getTrace(page.traces[0]!.id)).toBeTruthy();

    record(t, 2000);
    await t.flushTraces();
    const lines = fs.readFileSync(path.join(dataDir, "request-traces.jsonl"), "utf8").split("\n");
    expect(lines.filter(Boolean).length).toBeLessThanOrEqual(2000);
    t = await boot();
    expect((await t.listTraces({ page: 1, limit: 1 })).total).toBe(1000);
  });

  it("keeps one row per trace on Postgres and deletes the evicted ones", async () => {
    process.env.DATABASE_URL = "pglite://:memory:traces";
    const t = await boot();
    record(t, 1005);
    await t.flushTraces();
    const { getPgPool } = await import("../../src/lib/pg-pool.js");
    const { rows } = await getPgPool()!.query<{ n: string }>(
      "SELECT count(*) AS n FROM nexus_kv WHERE collection = 'request_traces'",
    );
    expect(Number(rows[0]?.n)).toBe(1000);
  }, 60_000);
});
