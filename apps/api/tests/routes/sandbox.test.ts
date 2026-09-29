// SPDX-License-Identifier: Apache-2.0
/**
 * Sandbox surface route tests — the §16.7 extraction of /sandbox/* from
 * api-bridge.ts into routes/sandbox.ts.
 *
 * Hermetic by construction: JavaScript runs in a local `vm` context, and the
 * Piston path is exercised WITHOUT a PISTON_URL (guarded fail-closed with the
 * actionable setup hint — the public emkc.org endpoint is whitelist-only).
 * Pyodide (network/WASM) is intentionally not exercised here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

// lib/untrusted-js gives its child Node 30 s to boot on a busy machine; a run needs more than that.
vi.setConfig({ testTimeout: 60_000 });

let app: FastifyInstance;

// One server for the file: building one per test is what timed out under full-suite load.
beforeAll(async () => {
  delete process.env.PISTON_URL;
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
});

interface ExecResult {
  executionId: string;
  status: "done" | "error" | "not_found";
  output?: string;
  error?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  language?: string;
  durationMs?: number;
  truncated?: boolean;
}

describe("GET /api/sandbox/status", () => {
  it("advertises the local runtimes (js + python) and availability", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sandbox/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      available: boolean;
      dockerAvailable: boolean;
      pistonAvailable: boolean;
      pythonRuntime: string;
      languages: string[];
      pistonUrl: string | null;
    }>();
    expect(body.available).toBe(true);
    expect(body.pythonRuntime).toBe("pyodide-local");
    // Without a custom PISTON_URL, only JS (vm) + Python (Pyodide) run here.
    expect(body.languages).toEqual(["javascript", "python"]);
    expect(body.pistonAvailable).toBe(false);
    expect(body.pistonUrl).toBeNull();
    expect(typeof body.dockerAvailable).toBe("boolean");
  });
});

describe("POST /api/sandbox/execute (javascript — local vm)", () => {
  it("runs code and returns the return value as output", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: "const x = 6 * 7; x", language: "javascript" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<ExecResult>();
    expect(body.status).toBe("done");
    expect(body.output).toBe("42");
    expect(body.stdout).toBe("42");
    expect(body.exitCode).toBe(0);
    expect(body.language).toBe("javascript");
    expect(body.executionId).toBeTruthy();
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures console.log lines plus the return value", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: "console.log('hi'); console.log('there'); 7" },
    });
    const body = res.json<ExecResult>();
    expect(body.status).toBe("done");
    expect(body.output).toBe("hi\nthere\n7");
  });

  it("reports runtime errors without leaking host globals", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: "throw new Error('boom')" },
    });
    const body = res.json<ExecResult>();
    expect(body.status).toBe("error");
    expect(body.error).toContain("boom");
    expect(body.exitCode).toBe(1);
  });

  it("denies host access — no files, no server environment", async () => {
    const read = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: 'require("node:fs").readFileSync("package.json", "utf8")' },
    });
    expect(read.json<ExecResult>().status).toBe("error");
    const env = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: "Object.keys(process.env).length" },
    });
    expect(env.json<ExecResult>().output).toBe("0");
  });

  it("caps runaway output instead of wedging the response", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: 'for (let i = 0; i < 2000; i++) console.log("x".repeat(200));' },
    });
    const body = res.json<ExecResult>();
    expect(body.status).toBe("done");
    expect(body.truncated).toBe(true);
    expect(body.output).toContain("output truncated");
  });
});

describe("POST /api/sandbox/execute (other languages — piston guard)", () => {
  it("fails closed with the actionable setup hint when no custom PISTON_URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: "echo hi", language: "bash" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<ExecResult>();
    expect(body.status).toBe("error");
    expect(body.error).toContain("Piston");
    expect(body.error).toContain("PISTON_URL");
    expect(body.language).toBe("bash");
    // A duration, not a timestamp.
    expect(body.durationMs).toBeLessThan(60_000);
  });
});

describe("GET /api/sandbox/status/:id (execution history)", () => {
  it("returns not_found for an unknown execution id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sandbox/status/nope-123" });
    expect(res.statusCode).toBe(200);
    expect(res.json<ExecResult>()).toEqual({
      executionId: "nope-123",
      status: "not_found",
    });
  });

  it("returns the recorded result after an execution", async () => {
    const run = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: "40 + 2" },
    });
    const id = run.json<ExecResult>().executionId;

    const res = await app.inject({ method: "GET", url: `/api/sandbox/status/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<ExecResult>();
    expect(body.status).toBe("done");
    expect(body.output).toBe("42");
    expect(body.executionId).toBe(id);
  });

  it("evicts the oldest entry once the history cap is exceeded", async () => {
    // With the cap at 100, 100 later executions must evict the first (Map order
    // is insertion order), and the newest must still be queryable. The fillers
    // take the fail-closed Piston path, which records without starting a process.
    const first = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: "1 + 1" },
    });
    const ids = [first.json<ExecResult>().executionId];
    for (let i = 0; i < 100; i++) {
      const run = await app.inject({
        method: "POST",
        url: "/api/sandbox/execute",
        payload: { code: "echo hi", language: "bash" },
      });
      expect(run.statusCode).toBe(201);
      ids.push(run.json<ExecResult>().executionId);
    }

    const oldest = await app.inject({ method: "GET", url: `/api/sandbox/status/${ids[0]}` });
    expect(oldest.json<ExecResult>().status).toBe("not_found");

    const newest = await app.inject({ method: "GET", url: `/api/sandbox/status/${ids[100]}` });
    expect(newest.json<ExecResult>()).toMatchObject({ executionId: ids[100], status: "error" });
  });
});
