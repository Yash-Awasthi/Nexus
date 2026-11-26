// SPDX-License-Identifier: Apache-2.0
/**
 * Spawns a language server without a shell and speaks LSP JSON-RPC over its
 * stdio. Same shape as `packages/mcp-client/src/stdio.ts`: monotonic ids,
 * a pending map keyed by id, notifications routed by method name, and every
 * pending request rejected once when the child exits. Differences: frames are
 * `Content-Length` encoded, ids are numbers, stderr is retained in a ring
 * buffer, and a bad frame closes the child instead of leaving it hanging.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

import { FrameDecoder, encodeFrame } from "./framing.ts";

/**
 * How to launch a language server. POSIX uses `spawn` directly; Windows needs
 * `cmd.exe` for the `.cmd` shims npm installs, because CreateProcess will not
 * run a batch file. The API's availability probe finds those shims, so the
 * spawn path must agree with it instead of reporting a server that cannot start.
 */
export function resolveSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32") return { command, args: [...args] };
  const pathExt = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const withExt = (base: string): string | undefined => {
    if (extname(base)) return existsSync(base) ? base : undefined;
    for (const ext of pathExt) if (existsSync(`${base}${ext}`)) return `${base}${ext}`;
    return undefined;
  };
  let found: string | undefined;
  if (/[\\/]/.test(command)) {
    found = withExt(command);
  } else {
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
      found = withExt(join(dir, command));
      if (found) break;
    }
  }
  if (!found) return { command, args: [...args] };
  if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args: [...args] };
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const line = [quote(found), ...args.map(quote)].join(" ");
  return {
    command: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

export type LspTransportErrorCode =
  | "SPAWN_FAILED"
  | "TRANSPORT_CLOSED"
  | "TIMEOUT"
  | "RPC_ERROR"
  | "BAD_FRAME"
  | "START_FAILED";

export class LspTransportError extends Error {
  readonly code: LspTransportErrorCode;
  readonly detail: unknown;

  constructor(message: string, code: LspTransportErrorCode, detail?: unknown) {
    super(message);
    this.name = "LspTransportError";
    this.code = code;
    this.detail = detail;
  }
}

export type LspNotificationHandler = (method: string, params: unknown) => void;

export interface LspTransportOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Already restricted by the caller; this layer never merges `process.env`. */
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  stderrLimitBytes?: number;
  onNotification?: LspNotificationHandler;
  onStderr?: (chunk: string) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const DEFAULT_STDERR_LIMIT = 64 * 1024;

export class LspTransport {
  readonly options: LspTransportOptions;

  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new FrameDecoder();
  private nextId = 1;
  private closed = false;
  private exitSeen = false;
  private stderrBuffer = "";
  private readonly exitWaiters: (() => void)[] = [];

  constructor(options: LspTransportOptions) {
    this.options = options;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get exited(): boolean {
    return this.exitSeen;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Start the child. Idempotent. Windows `.cmd` shims go through `cmd.exe`. */
  start(): void {
    if (this.child) return;
    this.closed = false;
    const resolved = resolveSpawn(this.options.command, this.options.args ?? [], this.options.env);
    const child = spawn(resolved.command, resolved.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      windowsHide: true,
      ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    child.on("error", (error) => {
      this.options.onExit?.({ code: null, signal: null });
      this.failAll(new LspTransportError(`spawn failed: ${error.message}`, "SPAWN_FAILED"));
      this.markExited();
    });
    child.on("exit", (code, signal) => {
      this.options.onExit?.({ code, signal });
      this.failAll(new LspTransportError("server exited", "TRANSPORT_CLOSED", { code, signal }));
      this.markExited();
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const child = this.child;
    if (!child || this.closed || this.exitSeen) {
      return Promise.reject(new LspTransportError("transport is not running", "TRANSPORT_CLOSED"));
    }

    const id = this.nextId++;
    const limit = timeoutMs ?? this.options.requestTimeoutMs ?? 10_000;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(
          id,
          new LspTransportError(`request timed out: ${method}`, "TIMEOUT", { method, id, limit }),
        );
      }, limit);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (error: Error) => void,
        timer,
      });
      try {
        this.write({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        this.rejectPending(
          id,
          new LspTransportError(
            `write failed: ${error instanceof Error ? error.message : String(error)}`,
            "TRANSPORT_CLOSED",
          ),
        );
      }
    });
    // A rejected request with nobody awaiting it must not crash the process.
    promise.catch(() => {});
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (!this.child || this.closed) return;
    try {
      this.write({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      });
    } catch {
      // Child already gone; the exit handler settles any pending requests.
    }
  }

  /** Raw captured stderr, capped at `stderrLimitBytes` (default 64 KB). */
  stderrTail(): string {
    return this.stderrBuffer;
  }

  /** True when the child exited (or failed to spawn) within the window. */
  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitSeen) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          resolve(false);
        },
        Math.max(0, timeoutMs),
      );
      this.exitWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Kill the child and, on Windows, its whole tree. */
  killTree(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone; exit handler owns the bookkeeping.
    }
  }

  /** Close stdin and settle every pending request. */
  close(): void {
    this.closed = true;
    this.failAll(new LspTransportError("transport closed", "TRANSPORT_CLOSED"));
    if (!this.child) {
      this.markExited();
      return;
    }
    try {
      this.child.stdin.end();
    } catch {
      // Pipe already closed.
    }
  }

  private write(message: unknown): void {
    this.child?.stdin.write(encodeFrame(message));
  }

  private onData(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      this.failAll(
        error instanceof LspTransportError
          ? error
          : new LspTransportError(
              error instanceof Error ? error.message : String(error),
              "BAD_FRAME",
            ),
      );
      this.killTree();
      return;
    }
    for (const message of messages) this.route(message as JsonRpcMessage);
  }

  private route(message: JsonRpcMessage): void {
    if (typeof message.method === "string" && message.id === undefined) {
      this.options.onNotification?.(message.method, message.params);
      return;
    }

    if (typeof message.method === "string" && message.id !== undefined) {
      // Server-initiated request (progress, configuration): answer null so the
      // server is not left waiting. Nexus does not implement these yet.
      this.write({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }

    if (message.id === undefined) return;
    const id = Number(message.id);
    if (!Number.isInteger(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new LspTransportError(message.error.message ?? "JSON-RPC error", "RPC_ERROR", {
          code: message.error.code,
          id,
        }),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private appendStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    this.options.onStderr?.(text);
    this.stderrBuffer += text;
    const limit = this.options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT;
    if (this.stderrBuffer.length > limit) this.stderrBuffer = this.stderrBuffer.slice(-limit);
  }

  private markExited(): void {
    if (this.exitSeen) return;
    this.exitSeen = true;
    this.closed = true;
    for (const waiter of this.exitWaiters.splice(0)) waiter();
  }
}
