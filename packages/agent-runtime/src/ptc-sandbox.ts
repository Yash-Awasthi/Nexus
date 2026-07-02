// SPDX-License-Identifier: Apache-2.0
/**
 * PTC (Programmatic Tool Calling) sandbox — worker_thread isolation.
 *
 * The PTC meta-tool (run_tool_script) executes LLM-generated JavaScript via
 * the AsyncFunction constructor. When that code blocks synchronously (e.g. an
 * infinite `while(true){}`), the cooperative Promise.race timeout in
 * `createProgrammaticToolTool` cannot interrupt it because the event loop is
 * starved — the main thread is dead.
 *
 * This module adds a worker_thread sandbox: the script runs in a separate OS
 * thread with a hard deadline. If it exceeds timeout, the worker is terminated
 * via worker.terminate(), which kills the thread at the V8 level regardless of
 * what it was executing.
 *
 * Fallback: when worker_threads is unavailable (browser / bundled env), it
 * falls back to direct AsyncFunction execution with a console.warn.
 */

import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PtcSandboxOptions {
  /** JavaScript body to execute (the "code" argument from the model). */
  code: string;
  /**
   * Context injected as argument names. `call` and `print` are always injected
   * as the first two arguments, followed by any extra keys here.
   */
  context?: Record<string, unknown>;
  /** Hard timeout in ms. The worker is terminate()d after this. */
  timeoutMs?: number;
  /** Max chars of captured output (clips worker result). Default 16000. */
  maxOutputChars?: number;
}

/** JSON-stringify a value for `print`, never throwing on cycles. */
function ptcSafeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Shared PTC executor — the single source of truth for the RPC + stdout-only
 * contract. Runs the model-authored script with two injected primitives:
 *   - `call(name, args)` — bridged to `call` (in the sandbox: an RPC to the
 *     parent thread; in the fallback: a direct gated invoke). Intermediate tool
 *     outputs stay inside the script.
 *   - `print(...)`        — the ONLY channel back to the model; captured stdout.
 * A `return`ed value is appended as `[return] …`. Errors surface as `[error] …`
 * alongside whatever was printed. Nothing else re-enters the conversation.
 */
export async function executePtcScript(
  code: string,
  context: Record<string, unknown>,
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const outputs: string[] = [];
  const print = (...vals: unknown[]): void => {
    outputs.push(vals.map((v) => (typeof v === "string" ? v : ptcSafeJson(v))).join(" "));
  };
  const bridgedCall = async (toolName: unknown, toolArgs?: unknown): Promise<unknown> => {
    if (opts.signal?.aborted) throw new Error("aborted");
    return call(String(toolName), (toolArgs ?? {}) as Record<string, unknown>);
  };

  const extraNames = Object.keys(context);
  const extraVals = Object.values(context);
  const AsyncFn = (async () => {}).constructor as new (
    ...args: string[]
  ) => (...callArgs: unknown[]) => Promise<unknown>;
  const fn = new AsyncFn("call", "print", ...extraNames, code);

  let returnLine = "";
  const run = (async (): Promise<void> => {
    const ret = await fn(bridgedCall, print, ...extraVals);
    if (ret !== undefined) returnLine = `\n[return] ${typeof ret === "string" ? ret : ptcSafeJson(ret)}`;
  })();

  try {
    if (opts.timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`script timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
        timer?.unref?.();
      });
      try {
        await Promise.race([run, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } else {
      await run;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const partial = outputs.join("\n");
    return `${partial}${partial ? "\n" : ""}[error] ${msg}`;
  }
  return (outputs.join("\n") + returnLine).trim() || "(script produced no output)";
}

// ── Worker-side execution ─────────────────────────────────────────────────────
//
// When this file is loaded as a worker (via `new Worker(filename)`), the
// isMainThread check below is false and we enter the worker path. The worker
// receives code + context via workerData, executes, and posts the result back.

function workerEntry(): void {
  if (isMainThread) return; // safety: only execute in worker

  const { code, context } = workerData as { code: string; context: Record<string, unknown> };

  // call() bridges to the parent thread via message passing (local RPC): the
  // worker sends {type:"call", name, args} and awaits a {type:"call_result", …}.
  // The real, permission-gated tool invocation happens in the parent.
  const call = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const handle = (msg: unknown): void => {
        const m = msg as { type: string; result?: unknown; error?: string };
        if (m.type === "call_result") {
          parentPort!.off("message", handle);
          if (m.error) reject(new Error(m.error));
          else resolve(m.result);
        }
      };
      parentPort!.on("message", handle);
      parentPort!.postMessage({ type: "call", name, args });
    });

  void executePtcScript(code, context, call).then((output) => {
    parentPort!.postMessage({ type: "done", output });
    return undefined;
  });
}

// Execute worker entry when running as a worker
if (!isMainThread) {
  workerEntry();
}

// ── Main-thread orchestrator ───────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 16_000;

function clipOutput(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

/**
 * Execute LLM-generated PTC script in a worker_thread with a hard timeout.
 *
 * The worker is terminated if it exceeds `timeoutMs`, which kills the OS thread
 * regardless of whether the JS code is blocking synchronously or asynchronously.
 *
 * For tool calls (`call(name, args)`), the worker sends a message to the parent
 * that must be handled by passing a `onToolCall` callback. This is the bridge
 * back to the tool system, which lives in the main thread.
 *
 * @param code        - JavaScript body to execute.
 * @param context     - Extra variables to inject into script scope (after
 *                      `call` and `print`).
 * @param timeoutMs   - Hard deadline; worker is .terminate()d after this.
 * @param onToolCall  - Called when the script invokes `call(name, args)`.
 *                      Must return the tool output (or throw).
 * @param maxOutputChars - Clip result to this many characters.
 * @param signal      - Optional AbortSignal for cooperative cancellation.
 */
export function runInWorkerThread(
  code: string,
  context: Record<string, unknown>,
  timeoutMs: number,
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  maxOutputChars = DEFAULT_MAX_OUTPUT,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (output: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    // Hard timeout — terminate the OS thread
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().then(
        () => {
          resolve(`[error] script timed out after ${timeoutMs}ms`);
          return undefined;
        },
        (err: unknown) => {
          resolve(
            `[error] script timed out after ${timeoutMs}ms (terminate error: ${err instanceof Error ? err.message : String(err)})`,
          );
        },
      );
    }, timeoutMs);
    timer.unref?.();

    // Handle cooperative abort signal
    const onAbort = (): void => {
      if (settled) return;
      settle("[error] aborted");
      worker.terminate().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { code, context },
    });

    worker.on(
      "message",
      (msg: { type: string; name?: string; args?: Record<string, unknown>; output?: string }) => {
        if (settled) return;
        switch (msg.type) {
          case "call": {
            // Worker wants to invoke a tool — bridge to main thread
            onToolCall(msg.name!, msg.args!)
              .then((result) => {
                worker.postMessage({ type: "call_result", result });
                return undefined;
              })
              .catch((e: unknown) => {
                worker.postMessage({
                  type: "call_result",
                  error: e instanceof Error ? e.message : String(e),
                });
                return undefined;
              });
            break;
          }
          case "done": {
            const output = clipOutput(msg.output ?? "", maxOutputChars);
            settle(output);
            worker.terminate().catch(() => {});
            break;
          }
        }
      },
    );

    worker.on("error", (err) => {
      fail(err);
    });

    worker.on("exit", (code) => {
      // If we already settled (got "done" message), this is the expected
      // exit after terminate(). Otherwise something went wrong.
      if (!settled && code !== 0) {
        fail(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

// ── Convenience: same API, but with inline tool handling ───────────────────────
//
// Equivalent to runInWorkerThread but handles the tool-call bridging internally
// using the provided toolSet + permissionGate (same pattern as the in-process PTC).

import type { PermissionGate, RuntimeToolSet, ToolContext } from "./index.js";
import { gatedInvoke } from "./index.js";

/**
 * Full PTC execution sandboxed in a worker_thread.
 *
 * Wraps `runInWorkerThread` and bridges the worker's `call()` requests to
 * the gated tool invocation system. This mirrors the in-process PTC handler
 * in `createProgrammaticToolTool` but runs the script in an isolated OS thread
 * that can be force-killed on timeout.
 *
 * When `worker_threads` is unavailable, falls back to direct AsyncFunction
 * execution with a warning.
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const maxCalls = opts.maxCalls ?? 100;
  const excluded = new Set<string>(opts.exclude ?? []);

  // Build context with callable tools list (same as in-process PTC)
  const toolNames = opts.toolSet
    .list()
    .filter((t) => !excluded.has(t.name))
    .map((t) => ({ name: t.name, description: t.description }));

  const context: Record<string, unknown> = {
    tools: toolNames,
  };

  // Bridge worker tool calls -> main-thread gatedInvoke, enforcing the same
  // call-count + exclusion limits the in-process meta-tool applies.
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

  try {
    return await runInWorkerThread(code, context, timeoutMs, onToolCall, maxOutput, opts.signal);
  } catch (err) {
    // If worker_threads isn't available (e.g. bundled browser env), the
    // `new Worker()` call throws. Fall back to in-process execution.
    if (err instanceof Error && err.message.includes("worker_threads")) {
      console.warn(
        "[ptc-sandbox] worker_threads not available — falling back to in-process AsyncFunction (no hard timeout for sync loops)",
      );
      return runToolScriptFallback(code, opts);
    }
    throw err;
  }
}

// ── In-process fallback ───────────────────────────────────────────────────────
//
// Mirrors the core of createProgrammaticToolTool's handler. Used when
// worker_threads is unavailable. Same timeout semantics as the original PTC:
// cooperative only (Promise.race), so a synchronous infinite loop still hangs.

async function runToolScriptFallback(
  code: string,
  opts: {
    toolSet: RuntimeToolSet;
    permissionGate?: PermissionGate;
    ctx?: ToolContext;
    timeoutMs?: number;
    maxOutputChars?: number;
    signal?: AbortSignal;
    maxCalls?: number;
    exclude?: readonly string[];
  },
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const maxCalls = opts.maxCalls ?? 100;
  const excluded = new Set<string>(opts.exclude ?? []);

  const toolNames = opts.toolSet
    .list()
    .filter((t) => !excluded.has(t.name))
    .map((t) => ({ name: t.name, description: t.description }));

  let calls = 0;
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (excluded.has(name)) throw new Error(`tool '${name}' is not callable from a script`);
    if (++calls > maxCalls) throw new Error(`script exceeded ${maxCalls} tool calls`);
    return gatedInvoke(opts.toolSet, opts.permissionGate, name, args, {
      sessionId: opts.ctx?.sessionId,
      toolCallId: opts.ctx?.toolCallId,
      signal: opts.ctx?.signal,
      workingDir: opts.ctx?.workingDir,
    });
  };

  const out = await executePtcScript(code, { tools: toolNames }, call, {
    timeoutMs,
    ...(opts.ctx?.signal ? { signal: opts.ctx.signal } : {}),
  });
  return clipOutput(out, maxOutput);
}
