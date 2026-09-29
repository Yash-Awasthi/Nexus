// SPDX-License-Identifier: Apache-2.0
/**
 * PTC (Programmatic Tool Calling) sandbox — the script runs in a child Node.
 *
 * A worker thread or `AsyncFunction` in this process shares its environment
 * and module loader, so a script could read provider keys from `process.env`
 * or import `child_process` and step around the permission gate. The child
 * runs under Node's permission model (no filesystem, child processes, workers
 * or addons), with an empty environment, sockets and fetch disabled, a memory
 * cap, and a hard kill at the deadline — a synchronous loop included.
 *
 * `call(name, args)` travels to this process as a JSON line on the child's
 * stdout and runs here through `gatedInvoke`; the answer goes back on stdin.
 * Only what the script prints (and returns) re-enters the conversation.
 */

import { spawn } from "node:child_process";

import { SANDBOX_PRELUDE } from "./sandbox-prelude.js";

import type { PermissionGate, RuntimeToolSet, ToolContext } from "./index.js";
import { gatedInvoke } from "./index.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 16_000;
/** How long the child may take to start, which a busy machine can stretch. */
const BOOT_MS = 30_000;

// Runs in the child. Messages are one JSON object per line in both directions.
const RUNNER = `${SANDBOX_PRELUDE}
const vm = require("node:vm");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const safe = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
const pending = new Map();
let seq = 0;
async function start(code, tools) {
  const out = [];
  const print = (...vals) => out.push(vals.map((v) => (typeof v === "string" ? v : safe(v))).join(" "));
  const call = (name, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      send({ type: "call", id, name: String(name), args: args ?? {} });
    });
  console.log = console.info = print;
  let tail = "";
  try {
    const fn = vm.runInThisContext("(async function (call, print, tools) {\\n" + code + "\\n})", { filename: "script.js" });
    const ret = await fn(call, print, tools);
    if (ret !== undefined) tail = "\\n[return] " + (typeof ret === "string" ? ret : safe(ret));
  } catch (e) {
    out.push("[error] " + (e && e.message ? e.message : String(e)));
  }
  send({ type: "done", output: (out.join("\\n") + tail).trim() || "(script produced no output)" });
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.type === "start") { send({ type: "ready" }); void start(m.code, m.tools); continue; }
    const p = pending.get(m.id);
    if (!p) continue;
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(m.error));
    else p.resolve(m.result);
  }
});
`;

function clipOutput(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

/** Run `code` in a child Node, answering its `call()`s with `onToolCall`. */
function runInChild(
  code: string,
  tools: { name: string; description: string }[],
  timeoutMs: number,
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--permission", "--max-old-space-size=128", "-e", RUNNER],
      // Inside the desktop app execPath is Electron, which runs as Node only when told to.
      {
        env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let settled = false;
    let stderr = "";
    const finish = (output: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      resolve(output);
    };
    const deadline = (ms: number) =>
      setTimeout(() => finish(`[error] script timed out after ${timeoutMs}ms`), ms);
    let timer = deadline(BOOT_MS);
    const onAbort = (): void => finish("[error] aborted");
    signal?.addEventListener("abort", onAbort, { once: true });

    const reply = (m: Record<string, unknown>): void => {
      if (!settled) child.stdin.write(`${JSON.stringify(m)}\n`);
    };
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: { type?: string; id?: number; name?: string; args?: unknown; output?: unknown };
        try {
          m = JSON.parse(line) as typeof m;
        } catch {
          continue;
        }
        if (m.type === "ready") {
          clearTimeout(timer);
          timer = deadline(timeoutMs);
        } else if (m.type === "done") {
          finish(String(m.output ?? ""));
        } else if (m.type === "call") {
          const args =
            m.args && typeof m.args === "object" ? (m.args as Record<string, unknown>) : {};
          onToolCall(String(m.name), args).then(
            (result) => reply({ id: m.id, result }),
            (e: unknown) => reply({ id: m.id, error: e instanceof Error ? e.message : String(e) }),
          );
        }
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString("utf8")).slice(-2000);
    });
    child.on("error", (e) => finish(`[error] could not start the script sandbox: ${e.message}`));
    child.on("close", (exit) =>
      finish(
        `[error] the script sandbox exited (${exit ?? "killed"})${stderr ? `: ${stderr}` : ""}`,
      ),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.write(`${JSON.stringify({ type: "start", code, tools })}\n`);
  });
}

/**
 * Run a PTC script sandboxed in a child Node process. Tool calls are gated in
 * this process with the same call-count and exclusion limits as in-process PTC.
 */
export async function runToolScript(
  code: string,
  opts: {
    toolSet: RuntimeToolSet;
    permissionGate?: PermissionGate;
    ctx?: ToolContext;
    timeoutMs?: number;
    maxOutputChars?: number;
    signal?: AbortSignal;
    /** Max tool calls the script may make (parity with in-process PTC). */
    maxCalls?: number;
    /** Tool names the script may not call. */
    exclude?: readonly string[];
  },
): Promise<string> {
  const maxCalls = opts.maxCalls ?? 100;
  const excluded = new Set<string>(opts.exclude ?? []);
  const tools = opts.toolSet
    .list()
    .filter((t) => !excluded.has(t.name))
    .map((t) => ({ name: t.name, description: t.description }));

  let calls = 0;
  const onToolCall = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (opts.ctx?.signal?.aborted) throw new Error("aborted");
    if (excluded.has(name)) throw new Error(`tool '${name}' is not callable from a script`);
    if (++calls > maxCalls) throw new Error(`script exceeded ${maxCalls} tool calls`);
    return gatedInvoke(opts.toolSet, opts.permissionGate, name, args, {
      sessionId: opts.ctx?.sessionId,
      toolCallId: opts.ctx?.toolCallId,
      signal: opts.ctx?.signal,
      workingDir: opts.ctx?.workingDir,
    });
  };

  const out = await runInChild(
    code,
    tools,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onToolCall,
    opts.signal ?? opts.ctx?.signal,
  );
  return `${clipOutput(out, opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT)}\n[${calls} tool call(s)]`;
}
