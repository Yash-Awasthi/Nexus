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

import { SANDBOX_LANGUAGES } from "@nexus/sandbox";
import type { FastifyInstance } from "fastify";

import { guardExec } from "../lib/exec-guard.ts";
import { ownerIdFor } from "../lib/owner.ts";
import {
  languageMatrix,
  pyodideVersion,
  resourceReport,
  sampleMemory,
  IMAGE_VERSIONS,
} from "../lib/sandbox-matrix.ts";
import { runUntrustedJs } from "../lib/untrusted-js.ts";
import { runUntrustedPython } from "../lib/untrusted-python.ts";

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
    language?: string;
    source?: "api" | "helper";
    createdAt: number;
    /** Insertion order; ms timestamps tie when two runs land in the same tick. */
    seq: number;
  }
>();

/**
 * Bounded history — a long-lived server must not grow the map forever.
 * When the cap is exceeded the OLDEST entry is evicted first (Map preserves
 * insertion order), so /sandbox/status/:id returns not_found for evicted ids.
 */
const MAX_SANDBOX_RESULTS = 100;
let _sandboxSequence = 0;
function recordResult(
  ownerId: string,
  result: {
    executionId: string;
    status: string;
    output: string;
    error?: string;
    durationMs: number;
    language?: string;
    source?: "api" | "helper";
    /** What the run cost; kept with the record so a history row can show it. */
    resources?: { cpuMs: number; peakRssBytes: number; wallMs: number; method: string };
  },
): void {
  _sandboxResults.set(result.executionId, {
    ...result,
    ownerId,
    source: result.source ?? "api",
    createdAt: Date.now(),
    seq: ++_sandboxSequence,
  });
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

/** Languages only Piston can run here; the rest come from @nexus/sandbox. */
const PISTON_ONLY_LANGUAGES = ["r"] as const;

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

/** Local Python via Pyodide (WASM), each run in its own restricted child process. */
export async function runViaPyodide(
  code: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const r = await runUntrustedPython(code, timeoutMs);
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, durationMs: r.durationMs };
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
    // Local languages are the sandbox image's: the page runs them through the
    // local helper. Piston adds what the image lacks (r) and can also take the rest.
    const languages = usingCustomPiston
      ? [...SANDBOX_LANGUAGES, ...PISTON_ONLY_LANGUAGES]
      : [...SANDBOX_LANGUAGES];
    // Per-language truth, with the version each language actually runs: a caller that pins
    // behaviour needs `3.4.13`, not "ruby". One source — `languageMatrix` — decides `via` and
    // `serverRuns` as well as the version, so the page, the pin and the status cannot disagree.
    const runtimes = languageMatrix({
      nodeVersion: process.version.replace(/^v/, ""),
      pyodideVersion: pyodideVersion(),
      pistonAvailable: usingCustomPiston,
      dockerAvailable: dockerAvail,
      languages,
    });
    return reply.send({
      available: true,
      dockerAvailable: dockerAvail,
      pistonAvailable: usingCustomPiston,
      pythonRuntime: "pyodide-local",
      languages,
      runtimes,
      imageVersions: IMAGE_VERSIONS,
      pistonUrl: process.env.PISTON_URL ?? null,
      note: usingCustomPiston
        ? "Piston answers every language this deployment lists, and the sandbox image is still the path for skill code and missions."
        : dockerAvail
          ? "JS and Python run in the API; the other image languages run through the local sandbox helper on your machine. Set PISTON_URL to a self-hosted Piston to run them on the server, and for r."
          : "JS and Python run in the API. No Docker daemon answers here, so the sandbox image is unavailable: Go, Rust, Ruby, TypeScript and Bash need Docker for the helper or a self-hosted PISTON_URL. r needs PISTON_URL.",
    });
  });

  app.post<{ Body: { code: string; language?: string; approvalId?: string } }>(
    "/sandbox/execute",
    async (request, reply) => {
      const { code, language = "javascript" } = request.body;
      const executionId = crypto.randomUUID();
      const startedAt = Date.now();
      const cpuAtStart = process.cpuUsage();
      // Peak resident memory during the run, sampled; see `ResourceReport.method`.
      const memory = sampleMemory();
      /** The figures for this run, for every exit path to attach to its result. */
      const resources = () => {
        const peakRssBytes = memory.stop();
        return resourceReport({
          startedAt,
          cpu: process.cpuUsage(cpuAtStart),
          peakRssBytes,
        });
      };
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
            resources: resources(),
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
            resources: resources(),
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
            resources: resources(),
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
        resources: resources(),
      };
      recordResult(ownerIdFor(request), result);
      return reply.code(201).send(result);
    },
  );

  /**
   * POST /sandbox/runs — record a run this browser executed through the local
   * sandbox helper. The helper runs on the viewer's machine, so the server only
   * sees what the page reports; that is why these rows are marked `helper`.
   */
  app.post<{
    Body: {
      language?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      exitCode?: unknown;
      durationMs?: unknown;
    };
  }>("/sandbox/runs", async (request, reply) => {
    const { language, stdout, stderr, exitCode, durationMs } = request.body ?? {};
    if (typeof language !== "string" || typeof stdout !== "string") {
      return reply
        .code(400)
        .send({ error: "invalid_run", message: "Send the language and the output." });
    }
    const exit = typeof exitCode === "number" ? exitCode : 0;
    const result = {
      executionId: crypto.randomUUID(),
      status: exit === 0 ? "done" : "error",
      output: stdout.slice(0, 64 * 1024),
      error: typeof stderr === "string" && stderr !== "" ? stderr.slice(0, 64 * 1024) : undefined,
      durationMs: typeof durationMs === "number" ? durationMs : 0,
      language,
      source: "helper" as const,
    };
    recordResult(ownerIdFor(request), result);
    return reply.code(201).send(result);
  });

  /** GET /sandbox/runs — this caller's recent runs, newest first. */
  app.get("/sandbox/runs", async (request, reply) => {
    const owner = ownerIdFor(request);
    const runs = [..._sandboxResults.values()]
      .filter((entry) => entry.ownerId === owner)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 20)
      .map(({ ownerId: _owner, seq: _seq, ...rest }) => rest);
    return reply.send({ runs });
  });

  app.get<{ Params: { id: string } }>("/sandbox/status/:id", async (request, reply) => {
    const found = _sandboxResults.get(request.params.id);
    if (!found || found.ownerId !== ownerIdFor(request))
      return reply.send({ executionId: request.params.id, status: "not_found" });
    const { ownerId: _owner, ...result } = found;
    return reply.send(result);
  });
}
