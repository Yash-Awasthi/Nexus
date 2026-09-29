// SPDX-License-Identifier: Apache-2.0
/**
 * Run user- or model-written JavaScript outside the API process.
 *
 * `node:vm` is not a boundary: any host function placed in the context (even
 * `console.log`) hands back the host's `Function`, and with it `process`. The
 * code here runs in a child Node under the permission model instead — no
 * filesystem, child processes, workers or native addons — with sockets, DNS
 * and fetch disabled before it starts, a stripped environment, a memory cap and a
 * wall-clock timeout.
 */

import { spawn } from "node:child_process";

import { SANDBOX_PRELUDE } from "@nexus/agent-runtime";

interface JsRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

const MAX_OUTPUT = 200_000;
/** Written by the child to stderr just before the code runs; the time limit starts there. */
const STARTED = "\u0001nexus-run-start\u0001\n";
/** How long the child Node may take to start, which a busy machine can stretch. */
const BOOT_MS = 30_000;

// Runs in the child. The user code arrives on stdin; its completion value is
// printed like a REPL would.
const RUNNER = `${SANDBOX_PRELUDE}
let src = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (src += c));
process.stdin.on("end", () => {
  process.stderr.write(${JSON.stringify(STARTED)});
  try {
    const value = require("node:vm").runInThisContext(src, { filename: "sandbox.js" });
    if (value !== undefined) console.log(typeof value === "string" ? value : require("node:util").inspect(value));
  } catch (e) {
    console.error(e && e.stack ? e.stack.split("\\n").slice(0, 3).join("\\n") : String(e));
    process.exitCode = 1;
  }
});
`;

export function runUntrustedJs(code: string, timeoutMs = 5_000): Promise<JsRunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--permission",
        "--max-old-space-size=64",
        "--disallow-code-generation-from-strings",
        "-e",
        RUNNER,
      ],
      // Inside the desktop app execPath is Electron, which runs as Node only when told to.
      {
        env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let runStarted = false;
    const kill = () => {
      timedOut = true;
      child.kill("SIGKILL");
    };
    let timer = setTimeout(kill, BOOT_MS);
    const take = (buf: Buffer, into: "out" | "err") => {
      let text = buf.toString("utf8");
      if (into === "err" && !runStarted && text.includes(STARTED)) {
        runStarted = true;
        text = text.replace(STARTED, "");
        clearTimeout(timer);
        timer = setTimeout(kill, timeoutMs);
      }
      const cur = into === "out" ? stdout : stderr;
      if (cur.length + text.length > MAX_OUTPUT) truncated = true;
      const next = (cur + text).slice(0, MAX_OUTPUT);
      if (into === "out") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (b: Buffer) => take(b, "out"));
    child.stderr.on("data", (b: Buffer) => take(b, "err"));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.replace(/\n$/, ""),
        stderr: timedOut ? `Timed out after ${timeoutMs}ms` : stderr.replace(/\n$/, ""),
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    });
    child.stdin.end(code);
  });
}
