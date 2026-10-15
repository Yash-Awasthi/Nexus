// SPDX-License-Identifier: Apache-2.0
// Pyodide's `js` module is its host's globalThis, so Python never runs in the API process:
// each run gets a fresh permission-restricted child that can read only the Pyodide package.

import { createRequire } from "node:module";
import { dirname } from "node:path";

import { SANDBOX_PRELUDE } from "@nexus/agent-runtime";

import { runSandboxedNode, STARTED, type SandboxRunResult } from "./untrusted-js.ts";

const PYODIDE_DIR = dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));

/** 8192 pages of 64 KiB: Python sees a MemoryError past 512 MB instead of the host running out. */
const WASM_MAX_PAGES = 8192;

// Pyodide's NODEFS reads fs flag constants through process.binding at start-up,
// which the permission model forbids; constants are all it needs.
const RUNNER = `${SANDBOX_PRELUDE}
process.binding = (name) => {
  if (name === "constants") return { fs: require("node:fs").constants, os: require("node:os").constants };
  throw new Error("process.binding is not available in the sandbox");
};
const dir = process.argv[process.argv.length - 1];
let src = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (src += c));
process.stdin.on("end", async () => {
  const path = require("node:path");
  const { loadPyodide } = require(path.join(dir, "pyodide.js"));
  const py = await loadPyodide({ indexURL: dir + path.sep });
  py.setStdout({ batched: (s) => process.stdout.write(s + "\\n") });
  py.setStderr({ batched: (s) => process.stderr.write(s + "\\n") });
  process.stderr.write(${JSON.stringify(STARTED)});
  try {
    await py.runPythonAsync(src);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    process.stderr.write(msg.trim().split("\\n").slice(-3).join("\\n") + "\\n");
    process.exitCode = 1;
  }
});
`;

// ponytail: one cold Pyodide boot (~2 s) per run; a pool of single-use pre-booted children if that latency matters
export function runUntrustedPython(code: string, timeoutMs = 30_000): Promise<SandboxRunResult> {
  return runSandboxedNode(
    [
      `--allow-fs-read=${PYODIDE_DIR}`,
      "--max-old-space-size=256",
      `--wasm-max-mem-pages=${WASM_MAX_PAGES}`,
      "--disallow-code-generation-from-strings",
    ],
    RUNNER,
    code,
    timeoutMs,
    [PYODIDE_DIR],
    // Pyodide compiles ~10 MB of wasm before the first line runs, slow on a 0.1-CPU host; kept
    // under the 100 s a Cloudflare-fronted host (Render) allows a request.
    80_000,
  );
}
