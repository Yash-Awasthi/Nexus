// SPDX-License-Identifier: Apache-2.0
/**
 * Stdio transport for MCP servers.
 *
 * Spawns a child process and speaks newline-delimited JSON-RPC 2.0 over its
 * stdin/stdout, the shape `mcp-bridge.exe` and other desktop MCP servers use.
 * Each request carries an id and resolves when the matching response line
 * arrives; notifications (no id) are written and never awaited.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { McpClientError, type McpTransport } from "./index.ts";

export interface McpStdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcLine {
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpStdioTransport implements McpTransport {
  private readonly options: McpStdioTransportOptions;
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private buffer = "";

  constructor(options: McpStdioTransportOptions) {
    this.options = options;
  }

  send(method: string, params?: unknown): Promise<unknown> {
    const id = String(this.nextId++);
    const request = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return this.write(request, id);
  }

  /** Send a notification: no id, no response expected. */
  notify(method: string, params?: unknown): void {
    this.child?.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) +
        "\n",
    );
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new McpClientError("transport closed", "TRANSPORT_CLOSED", { id }));
      this.pending.delete(id);
    }
    if (!child) return;
    child.stdin.end();
    child.kill();
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      this.failAll(new McpClientError("server exited", "TRANSPORT_CLOSED", { code, signal }));
    });
    this.child = child;
    return child;
  }

  private write(request: unknown, id: string): Promise<unknown> {
    const child = this.ensureChild();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpClientError(`timeout waiting for ${id}`, "TIMEOUT", { id }));
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify(request) + "\n");
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcLine;
    try {
      message = JSON.parse(line) as JsonRpcLine;
    } catch {
      return; // server log line, not JSON-RPC
    }
    if (message.id === undefined) return; // notification or server request
    const id = String(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new McpClientError(message.error.message, "RPC_ERROR", { code: message.error.code }),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
      this.pending.delete(id);
    }
  }
}
