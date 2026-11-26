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
import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import Fastify, { type FastifyInstance } from "fastify";

import { SANDBOX_LANGUAGES } from "@nexus/sandbox";

import { buildServer } from "../../src/server.ts";

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
  it("advertises the image languages and availability", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sandbox/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      available: boolean;
      dockerAvailable: boolean;
      pistonAvailable: boolean;
      pythonRuntime: string;
      languages: string[];
      runtimes: { language: string; via: string; serverRuns: boolean }[];
      pistonUrl: string | null;
      note: string;
    }>();
    expect(body.available).toBe(true);
    expect(body.pythonRuntime).toBe("pyodide-local");
    // Without a custom PISTON_URL, only the image languages are offered.
    expect(body.languages).toEqual([...SANDBOX_LANGUAGES]);
    expect(body.pistonAvailable).toBe(false);
    expect(body.pistonUrl).toBeNull();
    expect(typeof body.dockerAvailable).toBe("boolean");
  });

  it("says which path runs each language instead of implying the server runs them all", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sandbox/status" });
    const body = res.json<{
      languages: string[];
      runtimes: { language: string; via: string; serverRuns: boolean; version: string | null; pin: string }[];
      note: string;
    }>();
    // One entry per advertised language, in the same order, and none invented.
    expect(body.runtimes.map((runtime) => runtime.language)).toEqual(body.languages);
    const byLanguage = new Map(body.runtimes.map((runtime) => [runtime.language, runtime]));

    // The API itself runs only these two: a vm child for JS, Pyodide for Python. The version
    // names the interpreter that does it, not a number someone typed into a doc.
    expect(byLanguage.get("javascript")).toMatchObject({
      language: "javascript",
      via: "vm",
      serverRuns: true,
      version: process.version.replace(/^v/, ""),
    });
    expect(byLanguage.get("python")).toMatchObject({
      language: "python",
      via: "pyodide",
      serverRuns: true,
    });

    // The image languages run through the helper on the viewer's machine, which
    // this server cannot see; it must not claim to run them.
    for (const language of ["typescript", "bash", "go", "rust", "ruby"]) {
      expect(byLanguage.get(language)).toMatchObject({
        language,
        serverRuns: false,
      });
      // And it names what a caller can pin: the version in the image, not "latest".
      expect(byLanguage.get(language)!.pin).toMatch(/in the sandbox image$/);
    }

    // r is Piston-only. With no PISTON_URL it is not advertised at all, and the
    // note has to say how to get it rather than pretend it works.
    expect(body.languages).not.toContain("r");
    expect(byLanguage.has("r")).toBe(false);
    expect(body.note).toContain("PISTON_URL");
  });
});

describe("GET /api/sandbox/status with a self-hosted Piston", () => {
  it("adds r only when PISTON_URL points at a non-emkc instance", async () => {
    // The route reads PISTON_URL once at module load, so reload it with the
    // variable set instead of mutating the server built in beforeAll.
    process.env.PISTON_URL = "http://piston.internal:2000";
    vi.resetModules();
    try {
      const { sandboxRoutes } = await import("../../src/routes/sandbox.ts");
      const pistonApp = Fastify();
      await sandboxRoutes(pistonApp, { dockerReady: Promise.resolve(true) });
      await pistonApp.ready();
      const res = await pistonApp.inject({ method: "GET", url: "/sandbox/status" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        pistonAvailable: boolean;
        languages: string[];
        runtimes: { language: string; via: string; serverRuns: boolean }[];
        pistonUrl: string | null;
      }>();
      expect(body.pistonAvailable).toBe(true);
      expect(body.pistonUrl).toBe("http://piston.internal:2000");
      // The image list still comes from @nexus/sandbox; r is the Piston-only add.
      expect(body.languages).toEqual([...SANDBOX_LANGUAGES, "r"]);
      expect(body.runtimes.map((runtime) => runtime.language)).toEqual(body.languages);
      expect(body.runtimes.find((runtime) => runtime.language === "r")).toMatchObject({
        language: "r",
        via: "piston",
        serverRuns: true,
      });
      await pistonApp.close();
    } finally {
      delete process.env.PISTON_URL;
      vi.resetModules();
    }
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

  it("fails closed for go, rust and ruby without a custom PISTON_URL", async () => {
    for (const language of ["go", "rust", "ruby"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/sandbox/execute",
        payload: { code: "print 1", language },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<ExecResult>();
      expect(body.status).toBe("error");
      expect(body.error).toContain("PISTON_URL");
      expect(body.language).toBe(language);
    }
  });
});

describe("sandbox run history", () => {
  it("records a run the browser executed locally", async () => {
    const run = await app.inject({
      method: "POST",
      url: "/api/sandbox/runs",
      payload: {
        language: "python",
        stdout: "42\n",
        stderr: "",
        exitCode: 0,
        durationMs: 120,
      },
    });
    expect(run.statusCode).toBe(201);
    const recorded = run.json<ExecResult & { source?: string }>();
    expect(recorded.status).toBe("done");
    expect(recorded.source).toBe("helper");

    const read = await app.inject({
      method: "GET",
      url: `/api/sandbox/status/${recorded.executionId}`,
    });
    expect(read.json<ExecResult>().output).toBe("42\n");
  });

  it("marks a non-zero exit as an error and keeps the stderr", async () => {
    const run = await app.inject({
      method: "POST",
      url: "/api/sandbox/runs",
      payload: {
        language: "bash",
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
        durationMs: 5,
      },
    });
    expect(run.json<ExecResult>()).toMatchObject({ status: "error", error: "command not found" });
  });

  it("refuses a run without a language or output", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sandbox/runs",
      payload: { stdout: "orphan" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists the caller's recent runs, newest first", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/sandbox/runs",
      payload: { language: "javascript", stdout: "first", exitCode: 0, durationMs: 1 },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/sandbox/runs",
      payload: { language: "javascript", stdout: "second", exitCode: 0, durationMs: 1 },
    });
    const ids = [first.json<ExecResult>().executionId, second.json<ExecResult>().executionId];

    const listed = await app.inject({ method: "GET", url: "/api/sandbox/runs" });
    const runs = listed.json<{ runs: Array<{ executionId: string }> }>().runs;
    expect(runs[0]?.executionId).toBe(ids[1]);
    expect(runs.map((r) => r.executionId)).toContain(ids[0]);
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
