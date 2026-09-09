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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;

beforeEach(async () => {
  delete process.env.PISTON_URL;
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
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

  it("denies host access — require/setTimeout/fetch are undefined in the context", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: "typeof require + ' ' + typeof setTimeout + ' ' + typeof fetch" },
    });
    const body = res.json<ExecResult>();
    expect(body.status).toBe("done");
    expect(body.output).toBe("undefined undefined undefined");
  });

  it("caps runaway output instead of wedging the response", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sandbox/execute",
      payload: { code: "for (let i = 0; i < 100000; i++) console.log(i);" },
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
    // Regression: the history map used to grow without bound on a long-lived
    // server. With the cap at 100, the 101st execution must evict the first
    // (Map preserves insertion order — oldest goes first), and the newest must
    // still be queryable. Earlier tests leave 1-2 prior entries, so the first
    // id here is guaranteed evicted regardless.
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      const run = await app.inject({
        method: "POST",
        url: "/api/sandbox/execute",
        payload: { code: "1 + 1" },
      });
      expect(run.statusCode).toBe(201);
      ids.push(run.json<ExecResult>().executionId);
    }

    const oldest = await app.inject({ method: "GET", url: `/api/sandbox/status/${ids[0]}` });
    expect(oldest.json<ExecResult>().status).toBe("not_found");

    const newest = await app.inject({ method: "GET", url: `/api/sandbox/status/${ids[100]}` });
    expect(newest.json<ExecResult>().status).toBe("done");
  });
});
