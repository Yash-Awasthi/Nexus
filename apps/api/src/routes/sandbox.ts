// SPDX-License-Identifier: Apache-2.0
/**
 * Sandbox surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * /sandbox/* code execution: JavaScript via an isolated `vm` context (capped
 * output), Python locally via Pyodide (WASM, lazy), everything else through a
 * self-hosted Piston instance (the public emkc.org endpoint is whitelist-only
 * since 2026-02-15 — only an explicit non-emkc PISTON_URL counts).
 *
 * `runViaPyodide` / `runViaPiston` are exported for the code-agent build/run
 * path in api-bridge.ts (same single owner for all sandbox execution).
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";

import { guardExec } from "../lib/exec-guard.js";
import { ownerIdFor } from "../lib/owner.js";
import { runUntrustedJs } from "../lib/untrusted-js.js";

/** In-process execution history for GET /sandbox/status/:id. */
const _sandboxResults = new Map<
  string,
  {
    ownerId: string;
    executionId: string;
    status: string;
    output: string;
    error?: string;
    durationMs: number;
  }
>();

/**
 * Bounded history — a long-lived server must not grow the map forever.
 * When the cap is exceeded the OLDEST entry is evicted first (Map preserves
 * insertion order), so /sandbox/status/:id returns not_found for evicted ids.
 */
const MAX_SANDBOX_RESULTS = 100;
function recordResult(
  ownerId: string,
  result: {
    executionId: string;
    status: string;
    output: string;
    error?: string;
    durationMs: number;
  },
): void {
  _sandboxResults.set(result.executionId, { ...result, ownerId });
  if (_sandboxResults.size > MAX_SANDBOX_RESULTS) {
    const oldest = _sandboxResults.keys().next().value;
    if (oldest !== undefined) _sandboxResults.delete(oldest);
  }
}

// Piston public API — supports Python, Bash, TypeScript, and 70+ others.
// The public emkc.org endpoint went whitelist-only on 2026-02-15, so it is
// NOT a usable default anymore: only an explicitly configured non-emkc
// PISTON_URL (self-hosted) is a working Piston.
const PISTON_URL = process.env.PISTON_URL ?? "";
const PISTON_AVAILABLE = PISTON_URL !== "" && !PISTON_URL.includes("emkc.org");
const PISTON_SETUP_HINT =
  "Piston's public API is whitelist-only since 2026-02-15. Set PISTON_URL to a " +
  "self-hosted Piston instance (e.g. docker run -p 2000:2000 ghcr.io/engineer-man/piston) " +
  "to run this language.";
const PISTON_LANG_MAP: Record<string, { language: string; version: string; filename: string }> = {
  python: { language: "python", version: "3.10.0", filename: "main.py" },
  bash: { language: "bash", version: "5.2.0", filename: "main.sh" },
  typescript: { language: "typescript", version: "5.0.3", filename: "main.ts" },
  r: { language: "r", version: "4.1.1", filename: "main.r" },
  ruby: { language: "ruby", version: "3.0.1", filename: "main.rb" },
  go: { language: "go", version: "1.21.0", filename: "main.go" },
  rust: { language: "rust", version: "1.68.2", filename: "main.rs" },
};

export async function runViaPiston(
  code: string,
  language: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const mapping = PISTON_LANG_MAP[language.toLowerCase()];
  if (!mapping) throw new Error(`Unsupported language: ${language}`);
  if (!PISTON_AVAILABLE) throw new Error(PISTON_SETUP_HINT);
  const t0 = Date.now();
  const res = await fetch(`${PISTON_URL}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: mapping.language,
      version: mapping.version,
      files: [{ name: mapping.filename, content: code }],
    }),
  });
  const data = (await res.json()) as {
    run?: { stdout: string; stderr: string; code: number; output: string };
    message?: string;
  };
  const run = data.run;
  if (!run) throw new Error(data.message ?? "Piston returned no run result");
  return {
    stdout: run.stdout ?? run.output ?? "",
    stderr: run.stderr ?? "",
    exitCode: run.code ?? 0,
    durationMs: Date.now() - t0,
  };
}

// Lazy Pyodide — local Python via WASM. No Docker, no external Piston, no cost.
let _pyodidePromise: Promise<unknown> | null = null;
async function _getPyodide(): Promise<{
  setStdout: (o: { batched: (s: string) => void }) => void;
  setStderr: (o: { batched: (s: string) => void }) => void;
  runPythonAsync: (c: string) => Promise<unknown>;
}> {
  if (!_pyodidePromise) {
    _pyodidePromise = (async () => {
      const mod = (await import("pyodide")) as { loadPyodide: () => Promise<unknown> };
      return mod.loadPyodide();
    })();
  }
  return _pyodidePromise as Promise<{
    setStdout: (o: { batched: (s: string) => void }) => void;
    setStderr: (o: { batched: (s: string) => void }) => void;
    runPythonAsync: (c: string) => Promise<unknown>;
  }>;
}

export async function runViaPyodide(
  code: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const t0 = Date.now();
  const py = await _getPyodide();
  const out: string[] = [];
  const err: string[] = [];
  py.setStdout({ batched: (s: string) => out.push(s) });
  py.setStderr({ batched: (s: string) => err.push(s) });
  try {
    await py.runPythonAsync(code);
    return {
      stdout: out.join("\n"),
      stderr: err.join("\n"),
      exitCode: 0,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      stdout: out.join("\n"),
      stderr: `${err.join("\n")}\n${msg}`.trim(),
      exitCode: 1,
      durationMs: Date.now() - t0,
    };
  }
}

/**
 * Register the /sandbox/* surface. Called from apiBridgeRoutes.
 *
 * @param opts.dockerReady resolves whether a Docker daemon is reachable —
 *   surfaced on /sandbox/status (the sandbox itself never needs Docker: JS via
 *   vm, Python via Pyodide, other languages via self-hosted Piston).
 */
export async function sandboxRoutes(
  app: FastifyInstance,
  opts: { dockerReady: Promise<boolean> },
): Promise<void> {
  /** GET /sandbox/status — overall sandbox availability (no execution ID needed). */
  app.get("/sandbox/status", async (_request, reply) => {
    const dockerAvail = await opts.dockerReady;
    // emkc.org went whitelist-only Feb 2026 — only an explicit non-emkc
    // PISTON_URL counts as a working Piston instance.
    const usingCustomPiston = PISTON_AVAILABLE;
    // Only advertise languages that actually run on this box: JS (vm) and
    // Python (Pyodide) always; everything else needs a working Piston.
    const nonJsLangs = usingCustomPiston
      ? ["typescript", "python", "bash", "r", "ruby", "go", "rust"]
      : ["python"];
    return reply.send({
      available: true,
      dockerAvailable: dockerAvail,
      pistonAvailable: usingCustomPiston,
      pythonRuntime: "pyodide-local",
      languages: ["javascript", ...nonJsLangs],
      pistonUrl: process.env.PISTON_URL ?? null,
      note: usingCustomPiston
        ? undefined
        : "JS + Python run locally (Pyodide). Set PISTON_URL to a self-hosted Piston for Go/Rust/Ruby/R/bash.",
    });
  });

  app.post<{ Body: { code: string; language?: string; approvalId?: string } }>(
    "/sandbox/execute",
    async (request, reply) => {
      const { code, language = "javascript" } = request.body;
      const executionId = crypto.randomUUID();
      const startedAt = Date.now();
      const lang = language.toLowerCase();

      // The exec policy decides per language. This surface runs uncovered
      // actions by default (SURFACE_DEFAULTS) because the runtime is the
      // control here, but readonly mode and operator deny rules still apply,
      // and an operator can raise the whole surface to `ask`.
      const guarded = await guardExec(
        request,
        reply,
        { surface: "sandbox", command: lang },
        request.body.approvalId,
      );
      if (guarded === "handled") return;

      // Python → run locally via Pyodide (WASM) unless a custom Piston is configured.
      if (lang === "python" || lang === "py" || lang === "python3") {
        const customPiston =
          process.env.PISTON_URL !== undefined && !process.env.PISTON_URL.includes("emkc.org");
        if (!customPiston) {
          const r = await runViaPyodide(code);
          const result = {
            executionId,
            status: r.exitCode === 0 ? "done" : "error",
            output: r.stdout,
            error: r.stderr || undefined,
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exitCode,
            language: "python",
            durationMs: r.durationMs,
          };
          recordResult(ownerIdFor(request), result);
          return reply.code(201).send(result);
        }
      }

      // Non-JS languages → route through Piston (guarded: without a custom
      // PISTON_URL this throws the actionable setup hint instead of hitting
      // the dead whitelist-only public endpoint).
      if (lang !== "javascript" && lang !== "js") {
        const pistonLang = lang === "typescript" || lang === "ts" ? "typescript" : lang;
        try {
          const pResult = await runViaPiston(code, pistonLang);
          const result = {
            executionId,
            status: pResult.exitCode === 0 ? "done" : "error",
            output: pResult.stdout,
            error: pResult.stderr || undefined,
            stdout: pResult.stdout,
            stderr: pResult.stderr,
            exitCode: pResult.exitCode,
            language: pistonLang,
            durationMs: pResult.durationMs,
          };
          recordResult(ownerIdFor(request), result);
          return reply.code(201).send(result);
        } catch (e) {
          const result = {
            executionId,
            status: "error",
            output: "",
            error: e instanceof Error ? e.message : String(e),
            stdout: "",
            stderr: e instanceof Error ? e.message : String(e),
            exitCode: 1,
            language: lang,
            durationMs: Date.now() - startedAt,
          };
          recordResult(ownerIdFor(request), result);
          return reply.code(201).send(result);
        }
      }

      // JavaScript: a separate, permission-restricted Node process (lib/untrusted-js).
      const r = await runUntrustedJs(code, 5_000);
      const result = {
        executionId,
        status: r.exitCode === 0 ? "done" : "error",
        output: r.truncated ? `${r.stdout}\n… output truncated` : r.stdout,
        error: r.exitCode === 0 ? undefined : r.stderr,
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        language: "javascript",
        durationMs: r.durationMs,
        truncated: r.truncated,
      };
      recordResult(ownerIdFor(request), result);
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { id: string } }>("/sandbox/status/:id", async (request, reply) => {
    const found = _sandboxResults.get(request.params.id);
    if (!found || found.ownerId !== ownerIdFor(request))
      return reply.send({ executionId: request.params.id, status: "not_found" });
    const { ownerId: _owner, ...result } = found;
    return reply.send(result);
  });
}
