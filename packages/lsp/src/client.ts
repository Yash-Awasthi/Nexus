// SPDX-License-Identifier: Apache-2.0
/**
 * LSP lifecycle: initialize/initialized handshake, request forwarding, and a
 * shutdown that escalates to a tree kill. The manager layer (pool, roots,
 * documents) is not here; it only needs `createLspClient`.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseLspConfig, type LspCommand, type LspConfig } from "./config.ts";
import { LspTransport, LspTransportError } from "./transport.ts";

export interface ServerInfo {
  name: string;
  version?: string;
}

export interface ServerCapabilities {
  textDocumentSync?: unknown;
  definitionProvider?: unknown;
  referencesProvider?: unknown;
  hoverProvider?: unknown;
  documentSymbolProvider?: unknown;
  workspaceSymbolProvider?: unknown;
  renameProvider?: unknown;
  codeActionProvider?: unknown;
  [key: string]: unknown;
}

interface InitializeResult {
  capabilities?: ServerCapabilities;
  serverInfo?: ServerInfo;
}

export interface LspClientOptions {
  command: LspCommand;
  cwd?: string;
  /** Source environment; only PATH, HOME, LANG, LC_ALL, TMPDIR and TZ reach the child. */
  env?: NodeJS.ProcessEnv;
  config?: Partial<LspConfig>;
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

/** Environment variables the child is allowed to inherit. */
export const CHILD_ENV_NAMES = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"] as const;

export function minimalChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const CLIENT_CAPABILITIES = {
  workspace: {
    workspaceFolders: false,
    configuration: false,
    symbol: { dynamicRegistration: false },
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
      didSave: true,
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    publishDiagnostics: { relatedInformation: true, versionSupport: false },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    rename: { prepareSupport: false },
  },
  window: { workDoneProgress: false },
} as const;

export class LspClient {
  readonly transport: LspTransport;
  readonly config: LspConfig;

  capabilities: ServerCapabilities = {};
  serverInfo?: ServerInfo;

  private started = false;
  private shuttingDown = false;

  constructor(options: LspClientOptions) {
    const parsed = parseLspConfig();
    this.config = {
      ...parsed,
      ...options.config,
      commands: { ...parsed.commands, ...options.config?.commands },
    };
    const log = this.config.log;
    this.transport = new LspTransport({
      command: options.command.command,
      args: options.command.args,
      cwd: options.cwd,
      env: minimalChildEnv(options.env),
      requestTimeoutMs: this.config.requestTimeoutMs,
      onNotification: options.onNotification,
      onExit: options.onExit,
      onStderr:
        log === "info" || log === "debug"
          ? (chunk) => process.stderr.write(`[lsp] ${chunk}`)
          : undefined,
    });
  }

  get running(): boolean {
    return this.started && !this.shuttingDown && !this.transport.exited;
  }

  get stderr(): string {
    return this.transport.stderrTail();
  }

  /** Handshake. Rejects (and kills the child) when initialize misses the start timeout. */
  async start(): Promise<void> {
    if (this.started) return;
    const cwd = resolve(this.transport.options.cwd ?? process.cwd());
    this.transport.start();
    try {
      const result = await this.transport.request<InitializeResult>(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToFileURL(cwd).href,
          workspaceFolders: null,
          clientInfo: { name: "nexus-lsp", version: "0.0.0" },
          capabilities: CLIENT_CAPABILITIES,
        },
        this.config.startTimeoutMs,
      );
      this.capabilities = result?.capabilities ?? {};
      this.serverInfo = result?.serverInfo;
      this.transport.notify("initialized", {});
      this.started = true;
    } catch (error) {
      this.transport.killTree();
      throw new LspTransportError(
        `initialize failed: ${error instanceof Error ? error.message : String(error)}`,
        "START_FAILED",
        error,
      );
    }
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.started || this.shuttingDown) {
      return Promise.reject(
        new LspTransportError("client is not running", "TRANSPORT_CLOSED", { method }),
      );
    }
    return this.transport.request<T>(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    if (!this.started || this.shuttingDown) return;
    this.transport.notify(method, params);
  }

  /**
   * `shutdown`, then `exit`; SIGKILL the whole tree when the server has not
   * exited within `graceMs` (default 2 s).
   */
  async shutdown(graceMs = 2_000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.transport.exited) return;

    const deadline = Date.now() + graceMs;
    try {
      await this.transport.request("shutdown", undefined, Math.max(1, deadline - Date.now()));
    } catch {
      // Server ignored shutdown or died; exit escalation below handles both.
    }
    this.transport.notify("exit");
    if (await this.transport.waitForExit(Math.max(0, deadline - Date.now()))) return;
    this.transport.killTree();
    await this.transport.waitForExit(graceMs);
  }
}

/** Manager-facing factory: spawn, initialize, and return a ready client. */
export async function createLspClient(options: LspClientOptions): Promise<LspClient> {
  const client = new LspClient(options);
  await client.start();
  return client;
}
