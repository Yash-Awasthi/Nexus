// SPDX-License-Identifier: Apache-2.0
/**
 * The contract for the five `dedicated-volatile` operations, checked against a
 * real restart rather than against the tag's spelling:
 *
 *   GET  /api/sandbox/status          — stateless; answers before and after
 *   POST /api/sandbox/runs            — records a run
 *   GET  /api/sandbox/runs            — lists the caller's recorded runs, newest first
 *   GET  /api/sandbox/status/:id      — the recorded run
 *   POST /api/sandbox/execute         — runs code and records it in the same history
 *
 * "Dedicated-volatile" is a promise with two halves, and both are testable: the
 * data is real while the process lives (not a stub that answers `{ok:true}`), and
 * it is gone after a restart (not quietly durable, which would make the tag a lie
 * in the other direction). A restart here is a fresh module registry — the route
 * module's history Map is re-created, exactly as a new process would.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import type { FastifyInstance } from "fastify";

vi.setConfig({ testTimeout: 60_000 });

interface RunRecord {
  executionId: string;
  status: string;
  output: string;
  language?: string;
}

let first: FastifyInstance;
let restarted: FastifyInstance;

beforeAll(async () => {
  first = await buildFresh();
  await first.ready();
  await restarted;
}, 120_000);

afterAll(async () => {
  await first.close();
  await restarted?.close();
});

/** A server whose route modules have never been imported, i.e. a new process. */
async function buildFresh(): Promise<FastifyInstance> {
  vi.resetModules();
  const { buildServer } = await import("../../src/server.ts");
  return buildServer();
}

describe("dedicated-volatile: /api/sandbox/*", () => {
  let recorded: RunRecord;

  it("records a run and answers with it while the process lives", async () => {
    const created = await first.inject({
      method: "POST",
      url: "/api/sandbox/runs",
      payload: { language: "python", stdout: "hello from the helper\n", exitCode: 0 },
    });
    expect(created.statusCode).toBe(201);
    recorded = created.json<RunRecord>();
    expect(recorded.executionId).toBeTruthy();

    const read = await first.inject({
      method: "GET",
      url: `/api/sandbox/status/${recorded.executionId}`,
    });
    expect(read.statusCode).toBe(200);
    // Not a not_found stub: the data that was sent comes back.
    expect(read.json<RunRecord>().output).toBe("hello from the helper\n");

    const list = await first.inject({ method: "GET", url: "/api/sandbox/runs" });
    expect(list.statusCode).toBe(200);
    const runs = list.json<{ runs: RunRecord[] }>().runs;
    expect(runs.map((run) => run.executionId)).toContain(recorded.executionId);
  });

  it("loses that history across a restart, and keeps answering", async () => {
    restarted = await buildFresh();
    await restarted.ready();

    const list = await restarted.inject({ method: "GET", url: "/api/sandbox/runs" });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ runs: RunRecord[] }>().runs).toEqual([]);

    const read = await restarted.inject({
      method: "GET",
      url: `/api/sandbox/status/${recorded.executionId}`,
    });
    // The documented shape for an unknown id, not a 404: callers poll this.
    expect(read.statusCode).toBe(200);
    expect(read.json<{ status: string }>().status).toBe("not_found");

    // The stateless half of the surface still works in the new process.
    const status = await restarted.inject({ method: "GET", url: "/api/sandbox/status" });
    expect(status.statusCode).toBe(200);
    const body = status.json<{ languages: string[]; runtimes: unknown[] }>();
    expect(body.languages.length).toBeGreaterThan(0);
    expect(Array.isArray(body.runtimes)).toBe(true);
  });

  it("records an execute in the same volatile history", async () => {
    const res = await first.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: "console.log('volatile ok'); 1", language: "javascript" },
    });
    expect(res.statusCode).toBe(201);
    const ran = res.json<RunRecord>();
    expect(ran.status).toBe("done");
    expect(ran.output).toContain("volatile ok");

    const list = await first.inject({ method: "GET", url: "/api/sandbox/runs" });
    expect(list.json<{ runs: RunRecord[] }>().runs.map((run) => run.executionId)).toContain(
      ran.executionId,
    );
  });
});
