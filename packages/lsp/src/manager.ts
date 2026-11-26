// SPDX-License-Identifier: Apache-2.0
/**
 * Pooled language-server manager. One server per (root, language), LRU and
 * idle eviction, RSS watchdog, crash policy, and one manager-shaped API for
 * the agent tools. Spawns are gated by an injected authorize callback; this
 * file imports no API, exec-policy or tool module.
 */

import { readFileSync, type Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createLspClient, type LspClient, type LspClientOptions } from "./client.ts";
import { parseLspConfig, type LspConfig } from "./config.ts";
import {
  containFile,
  resolveWorkspaceRoot,
  splitRootList,
  type ContainmentCode,
  type RootSource,
} from "./containment.ts";
import { DocumentSync } from "./documents.ts";
import { commandForLanguage, languageForPath, type LspLanguage } from "./languages.ts";
import { LspTransportError } from "./transport.ts";

export const MAX_LOCATIONS = 200;
export const MAX_REFERENCES = 20;
export const MAX_HOVER_BYTES = 8 * 1024;
export const MAX_DIAGNOSTICS = 200;
export const MAX_SYMBOL_CHILDREN = 20;

const CRASH_WINDOW_MS = 60_000;
const UNHEALTHY_MS = 60_000;
const RSS_SAMPLE_MS = 15_000;

/** tsserver reports "No Project" until a file is open, so warm workspace queries. */
const REPRESENTATIVE_EXTENSIONS: Record<LspLanguage, readonly string[]> = {
  typescript: [".ts", ".tsx", ".js", ".jsx"],
  python: [".py", ".pyi"],
  go: [".go"],
  rust: [".rs"],
};
const WARM_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

export type LspManagerErrorCode =
  | ContainmentCode
  | "DISABLED"
  | "NO_SERVER"
  | "DENIED"
  | "APPROVAL_REQUIRED"
  | "BROKEN"
  | "UNHEALTHY"
  | "START_FAILED"
  | "SERVER_EXITED"
  | "RPC_ERROR"
  | "TIMEOUT"
  | "BAD_INPUT";

export interface LspFailure {
  ok: false;
  code: LspManagerErrorCode;
  reason: string;
  approvalId?: string;
}

export interface LspPosition {
  line: number;
  column: number;
}

export interface LspLocation {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface LspLocationsResult {
  ok: true;
  locations: LspLocation[];
  truncated: boolean;
}

export interface LspHoverResult {
  ok: true;
  contents: string;
  truncated: boolean;
}

export interface LspSymbol {
  name: string;
  kind: number;
  path?: string;
  line: number;
  column: number;
}

export interface LspSymbolsResult {
  ok: true;
  symbols: LspSymbol[];
  truncated: boolean;
}

export interface LspDiagnostic {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
}

export interface LspDiagnosticsResult {
  ok: true;
  diagnostics: LspDiagnostic[];
  stale: boolean;
  truncated: boolean;
}

export interface LspEdit {
  path: string;
  range: { start: LspPosition; end: LspPosition };
  newText: string;
}

export interface LspEditResult {
  ok: true;
  edits: LspEdit[];
  truncated: boolean;
}

export interface LspCodeAction {
  title: string;
  kind?: string;
  command?: unknown;
  edits: LspEdit[];
}

export interface LspCodeActionsResult {
  ok: true;
  actions: LspCodeAction[];
  truncated: boolean;
}

export interface LspWorkspaceSymbolsResult {
  ok: true;
  symbols: LspSymbol[];
  truncated: boolean;
}

export interface LspFileInput {
  path: string;
}

export interface LspPositionInput extends LspFileInput {
  /** 1-based line and column at the boundary; converted to 0-based inside. */
  line: number;
  column: number;
}

export interface LspRenameInput extends LspPositionInput {
  newName: string;
}

export interface LspCodeActionsInput extends LspPositionInput {
  endLine?: number;
  endColumn?: number;
}

export interface LspSpawnAction {
  command: string;
  args: string[];
  cwd: string;
}

export interface LspAuthorization {
  decision: "allow" | "ask" | "deny";
  reason?: string;
  approvalId?: string;
}

export type LspAuthorizeResult = "allow" | "ask" | "deny" | LspAuthorization;

export type LspAuthorize = (
  action: LspSpawnAction,
) => LspAuthorizeResult | Promise<LspAuthorizeResult>;

export interface LspScheduler {
  setInterval: (handler: () => void | Promise<void>, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface LspManagerOptions {
  /** Source environment for roots, exec constraints and defaults. */
  env?: NodeJS.ProcessEnv;
  config?: Partial<LspConfig>;
  /** Tool-context working directory, tried before `NEXUS_LSP_ROOTS`. */
  workingDir?: string;
  authorize: LspAuthorize;
  now?: () => number;
  scheduler?: LspScheduler;
  /** RSS sampler; defaults to /proc on Linux and 0 elsewhere. Tests inject. */
  rssBytes?: (pid: number) => number;
  onClose?: () => void;
}

export type LspServerHealth = "starting" | "ready" | "unhealthy" | "broken" | "stopped";

export interface LspServerStatus {
  root: string;
  language: LspLanguage;
  pid?: number;
  health: LspServerHealth;
  openDocuments: number;
  lastUsedAt: number;
  crashes: number;
  restartAt?: number;
  reason?: string;
}

export interface LspManagerStatus {
  enabled: boolean;
  available: boolean;
  root?: string;
  source?: RootSource;
  reason?: string;
  servers: LspServerStatus[];
}

export interface LspManager {
  definition(input: LspPositionInput): Promise<LspLocationsResult | LspFailure>;
  references(input: LspPositionInput): Promise<LspLocationsResult | LspFailure>;
  hover(input: LspPositionInput): Promise<LspHoverResult | LspFailure>;
  documentSymbols(input: LspFileInput): Promise<LspSymbolsResult | LspFailure>;
  diagnostics(input: LspFileInput): Promise<LspDiagnosticsResult | LspFailure>;
  rename(input: LspRenameInput): Promise<LspEditResult | LspFailure>;
  codeActions(input: LspCodeActionsInput): Promise<LspCodeActionsResult | LspFailure>;
  workspaceSymbols(input: {
    query: string;
    language?: LspLanguage;
  }): Promise<LspWorkspaceSymbolsResult | LspFailure>;
  status(): LspManagerStatus;
  restart(language: LspLanguage): Promise<void>;
  dispose(): Promise<void>;
}

interface PoolEntry {
  key: string;
  root: string;
  language: LspLanguage;
  client?: LspClient;
  documents?: DocumentSync;
  lastUsedAt: number;
  starting: boolean;
  disposing: boolean;
  exitRecorded: boolean;
  crashTimes: number[];
  brokenReason?: string;
  unhealthyUntil?: number;
  unhealthyReason?: string;
}

interface Prepared {
  ok: true;
  entry: PoolEntry;
  uri: string;
  version: number;
  path: string;
}

interface RangeLike {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface LocationLike {
  uri?: string;
  targetUri?: string;
  range?: RangeLike;
  targetSelectionRange?: RangeLike;
}

const defaultScheduler: LspScheduler = {
  setInterval(handler, ms) {
    const handle = setInterval(() => {
      void handler();
    }, ms);
    handle.unref();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};

function defaultRssBytes(pid: number): number {
  if (process.platform !== "linux") return 0;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return match?.[1] ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function failure(code: LspManagerErrorCode, reason: string, approvalId?: string): LspFailure {
  return approvalId === undefined
    ? { ok: false, code, reason }
    : { ok: false, code, reason, approvalId };
}

export class LspManagerImpl implements LspManager {
  private readonly config: LspConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly execRoots: string[];
  private readonly rootResolution: ReturnType<typeof resolveWorkspaceRoot>;
  private readonly authorize: LspAuthorize;
  private readonly now: () => number;
  private readonly scheduler: LspScheduler;
  private readonly rssBytes: (pid: number) => number;
  private readonly onClose?: () => void;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly timers: unknown[] = [];
  private disposed = false;

  constructor(options: LspManagerOptions) {
    this.env = options.env ?? {};
    const parsed = parseLspConfig(this.env);
    this.config = {
      ...parsed,
      ...options.config,
      commands: { ...parsed.commands, ...options.config?.commands },
    };
    this.execRoots = splitRootList(this.env.NEXUS_EXEC_ROOTS);
    this.rootResolution = resolveWorkspaceRoot({
      workingDir: options.workingDir,
      lspRoots: this.config.roots,
      execRoots: this.execRoots,
      env: this.env,
    });
    this.authorize = options.authorize;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.rssBytes = options.rssBytes ?? defaultRssBytes;
    this.onClose = options.onClose;

    if (this.config.enabled) {
      this.timers.push(
        this.scheduler.setInterval(() => this.sweepIdle(), this.config.idleMs),
        this.scheduler.setInterval(() => this.sweepRss(), RSS_SAMPLE_MS),
      );
    }
  }

  status(): LspManagerStatus {
    const servers: LspServerStatus[] = [];
    for (const entry of this.entries.values()) {
      const now = this.now();
      const status: LspServerStatus = {
        root: entry.root,
        language: entry.language,
        health: this.health(entry, now),
        openDocuments: entry.documents?.openCount ?? 0,
        lastUsedAt: entry.lastUsedAt,
        crashes: entry.crashTimes.length,
      };
      if (entry.client?.transport.pid !== undefined) status.pid = entry.client.transport.pid;
      if (entry.brokenReason) status.reason = entry.brokenReason;
      else if (entry.unhealthyReason) status.reason = entry.unhealthyReason;
      if (entry.unhealthyUntil !== undefined) status.restartAt = entry.unhealthyUntil;
      servers.push(status);
    }
    return {
      enabled: this.config.enabled,
      available: this.rootResolution.available,
      ...(this.rootResolution.available
        ? { root: this.rootResolution.root, source: this.rootResolution.source }
        : { reason: this.rootResolution.reason }),
      servers,
    };
  }

  async definition(input: LspPositionInput): Promise<LspLocationsResult | LspFailure> {
    return this.positionRequest(input, "textDocument/definition", MAX_LOCATIONS);
  }

  async references(input: LspPositionInput): Promise<LspLocationsResult | LspFailure> {
    return this.positionRequest(input, "textDocument/references", MAX_REFERENCES);
  }

  async hover(input: LspPositionInput): Promise<LspHoverResult | LspFailure> {
    const prepared = await this.prepare(input);
    if (!prepared.ok) return prepared;
    try {
      const raw = await this.call<unknown>(prepared.entry, "textDocument/hover", {
        textDocument: { uri: prepared.uri },
        position: position(input),
      });
      const text = hoverText(raw);
      const truncated = Buffer.byteLength(text, "utf8") > MAX_HOVER_BYTES;
      return {
        ok: true,
        contents: truncated
          ? Buffer.from(text, "utf8").subarray(0, MAX_HOVER_BYTES).toString("utf8")
          : text,
        truncated,
      };
    } catch (error) {
      return this.failed(error);
    }
  }

  async documentSymbols(input: LspFileInput): Promise<LspSymbolsResult | LspFailure> {
    const prepared = await this.prepare(input);
    if (!prepared.ok) return prepared;
    const cached = prepared.entry.documents?.getSymbols(prepared.uri, prepared.version);
    if (cached) return this.symbolsResult(cached, prepared.path);
    try {
      const raw = await this.call<unknown>(prepared.entry, "textDocument/documentSymbol", {
        textDocument: { uri: prepared.uri },
      });
      const symbols = Array.isArray(raw) ? raw : [];
      prepared.entry.documents?.setSymbols(prepared.uri, prepared.version, symbols);
      return this.symbolsResult(symbols, prepared.path);
    } catch (error) {
      return this.failed(error);
    }
  }

  async diagnostics(input: LspFileInput): Promise<LspDiagnosticsResult | LspFailure> {
    const prepared = await this.prepare(input);
    if (!prepared.ok) return prepared;
    const documents = prepared.entry.documents;
    if (!documents) return failure("SERVER_EXITED", "language server is not running");
    const pulled = await this.pullDiagnostics(prepared);
    if (pulled) return pulled;
    const waited = await documents.waitForDiagnostics(
      prepared.uri,
      prepared.version,
      this.config.diagnosticsWaitMs,
    );
    return this.diagnosticsResult(prepared.path, waited.diagnostics, waited.stale);
  }

  /**
   * Some servers (pyright) only answer `textDocument/diagnostic`; a server
   * without it errors and the push path above still runs.
   */
  private async pullDiagnostics(prepared: Prepared): Promise<LspDiagnosticsResult | undefined> {
    let raw: { items?: unknown[] };
    try {
      raw = await this.call<{ items?: unknown[] }>(prepared.entry, "textDocument/diagnostic", {
        textDocument: { uri: prepared.uri },
      });
    } catch {
      return undefined;
    }
    if (!Array.isArray(raw?.items)) return undefined;
    return this.diagnosticsResult(prepared.path, raw.items, false);
  }

  private diagnosticsResult(path: string, raw: unknown[], stale: boolean): LspDiagnosticsResult {
    const truncated = raw.length > MAX_DIAGNOSTICS;
    const diagnostics: LspDiagnostic[] = [];
    for (const item of raw.slice(0, MAX_DIAGNOSTICS)) {
      const entry = item as { range?: RangeLike; severity?: number; message?: string };
      if (!entry.range || typeof entry.message !== "string") continue;
      diagnostics.push({
        path,
        line: entry.range.start.line + 1,
        column: entry.range.start.character + 1,
        severity: severityName(entry.severity),
        message: entry.message,
      });
    }
    return { ok: true, diagnostics, stale, truncated };
  }

  async rename(input: LspRenameInput): Promise<LspEditResult | LspFailure> {
    if (typeof input.newName !== "string" || input.newName.length === 0) {
      return failure("BAD_INPUT", "newName is required");
    }
    const prepared = await this.prepare(input);
    if (!prepared.ok) return prepared;
    try {
      const raw = await this.call<unknown>(prepared.entry, "textDocument/rename", {
        textDocument: { uri: prepared.uri },
        position: position(input),
        newName: input.newName,
      });
      return this.editsResult(raw);
    } catch (error) {
      return this.failed(error);
    }
  }

  async codeActions(input: LspCodeActionsInput): Promise<LspCodeActionsResult | LspFailure> {
    const prepared = await this.prepare(input);
    if (!prepared.ok) return prepared;
    const range = {
      start: position(input),
      end:
        input.endLine !== undefined && input.endColumn !== undefined
          ? { line: input.endLine - 1, character: input.endColumn - 1 }
          : position(input),
    };
    try {
      const raw = await this.call<unknown>(prepared.entry, "textDocument/codeAction", {
        textDocument: { uri: prepared.uri },
        range,
        context: { diagnostics: [] },
      });
      const items = Array.isArray(raw) ? raw : [];
      const truncated = items.length > MAX_LOCATIONS;
      const actions: LspCodeAction[] = [];
      for (const item of items.slice(0, MAX_LOCATIONS)) {
        const action = item as {
          title?: string;
          kind?: string;
          command?: unknown;
          edit?: unknown;
        };
        if (typeof action.title !== "string") continue;
        const edits = this.editsResult(action.edit).edits;
        actions.push({
          title: action.title,
          ...(action.kind === undefined ? {} : { kind: action.kind }),
          ...(action.command === undefined ? {} : { command: action.command }),
          edits,
        });
      }
      return { ok: true, actions, truncated };
    } catch (error) {
      return this.failed(error);
    }
  }

  async workspaceSymbols(input: {
    query: string;
    language?: LspLanguage;
  }): Promise<LspWorkspaceSymbolsResult | LspFailure> {
    if (!this.config.enabled) {
      return failure("DISABLED", "LSP is disabled; set NEXUS_LSP=1");
    }
    if (!this.rootResolution.available) {
      return failure(this.rootResolution.code, this.rootResolution.reason);
    }
    const language =
      input.language ??
      (["typescript", "python", "go", "rust"] as const).find(
        (candidate) => this.config.commands[candidate].command.length > 0,
      );
    if (!language) return failure("NO_SERVER", "no language server command is configured");
    const server = await this.serverFor(language);
    if (!server.ok) return server;
    await this.openRepresentative(server.entry);
    try {
      const raw = await this.call<unknown>(server.entry, "workspace/symbol", {
        query: input.query,
      });
      const { symbols, truncated } = this.normalizeSymbols(raw);
      return { ok: true, symbols, truncated };
    } catch (error) {
      return this.failed(error);
    }
  }

  async restart(language: LspLanguage): Promise<void> {
    const victims = [...this.entries.values()].filter((entry) => entry.language === language);
    for (const entry of victims) {
      this.entries.delete(entry.key);
      await this.stopEntry(entry);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of this.timers.splice(0)) this.scheduler.clearInterval(handle);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => this.stopEntry(entry)));
    this.onClose?.();
  }

  private async positionRequest(
    input: LspPositionInput,
    method: string,
    cap: number,
  ): Promise<LspLocationsResult | LspFailure> {
    const prepared = await this.prepare(input);
    if (!prepared.ok) return prepared;
    try {
      const raw = await this.call<unknown>(prepared.entry, method, {
        textDocument: { uri: prepared.uri },
        position: position(input),
        ...(method === "textDocument/references" ? { context: { includeDeclaration: true } } : {}),
      });
      return await this.locationsResult(raw, cap);
    } catch (error) {
      return this.failed(error);
    }
  }

  private async prepare(input: LspFileInput | LspPositionInput): Promise<Prepared | LspFailure> {
    if (!this.config.enabled) {
      return failure("DISABLED", "LSP is disabled; set NEXUS_LSP=1");
    }
    if (!this.rootResolution.available) {
      return failure(this.rootResolution.code, this.rootResolution.reason);
    }
    if ("line" in input && (input.line < 1 || input.column < 1)) {
      return failure("BAD_INPUT", "line and column are 1-based and must be at least 1");
    }
    const contained = containFile({
      path: input.path,
      root: this.rootResolution.root,
      execRoots: this.execRoots,
      maxFileBytes: this.config.maxFileBytes,
    });
    if (!contained.ok) return { ok: false, code: contained.code, reason: contained.reason };

    const language = languageForPath(contained.path);
    if (!language) {
      return failure("NO_SERVER", `no server for this file: ${input.path}`);
    }
    const server = await this.serverFor(language);
    if (!server.ok) return server;
    const entry = server.entry;
    if (!entry.documents) return failure("SERVER_EXITED", "language server is not running");

    let text: string;
    try {
      text = await readFile(contained.path, "utf8");
    } catch {
      return failure("NOT_FOUND", `cannot read ${input.path}`);
    }
    const uri = pathToFileURL(contained.path).href;
    const current = entry.documents.version(uri);
    let version: number;
    if (current === undefined) {
      version = entry.documents.open({ uri, languageId: language, text });
    } else if (entry.documents.text(uri) !== text) {
      version = entry.documents.change(uri, text);
    } else {
      version = current;
      entry.documents.touch(uri);
    }
    entry.lastUsedAt = this.now();
    return { ok: true, entry, uri, version, path: contained.path };
  }

  private async serverFor(
    language: LspLanguage,
  ): Promise<{ ok: true; entry: PoolEntry } | LspFailure> {
    const root = this.rootResolution.available ? this.rootResolution.root : "";
    const key = `${root}::${language}`;
    let entry = this.entries.get(key);

    if (entry) {
      if (entry.brokenReason) return failure("BROKEN", entry.brokenReason);
      if (entry.unhealthyUntil !== undefined && this.now() < entry.unhealthyUntil) {
        return failure(
          "UNHEALTHY",
          entry.unhealthyReason ?? "language server is unhealthy; retry after the cooldown",
        );
      }
      if (entry.starting) {
        // A concurrent call is starting this server; spawn again joins nothing.
        return failure("UNHEALTHY", "language server is starting");
      }
      if (entry.client && !entry.client.transport.exited) {
        entry.lastUsedAt = this.now();
        return { ok: true, entry };
      }
      entry.client = undefined;
    } else {
      entry = {
        key,
        root,
        language,
        lastUsedAt: this.now(),
        starting: false,
        disposing: false,
        exitRecorded: false,
        crashTimes: [],
      };
    }

    const live = [...this.entries.values()].filter((candidate) => candidate.client);
    if (live.length >= this.config.maxServers) {
      const victim = live.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (victim) {
        this.entries.delete(victim.key);
        await this.stopEntry(victim);
      }
    }

    return this.spawn(entry);
  }

  private async spawn(entry: PoolEntry): Promise<{ ok: true; entry: PoolEntry } | LspFailure> {
    const command = commandForLanguage(this.config, entry.language);
    if (!command.command) {
      return failure("NO_SERVER", `no command configured for ${entry.language}`);
    }

    let decision: LspAuthorization;
    try {
      const result = await this.authorize({
        command: command.command,
        args: command.args,
        cwd: entry.root,
      });
      decision = typeof result === "string" ? { decision: result } : result;
    } catch (error) {
      return failure(
        "DENIED",
        `authorization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (decision.decision === "deny") {
      return failure(
        "DENIED",
        decision.reason ?? "the exec policy denied the language server spawn",
      );
    }
    if (decision.decision === "ask") {
      return failure(
        "APPROVAL_REQUIRED",
        decision.reason ?? "language server spawn requires approval",
        decision.approvalId ?? "",
      );
    }

    entry.starting = true;
    entry.disposing = false;
    entry.exitRecorded = false;
    entry.unhealthyUntil = undefined;
    entry.unhealthyReason = undefined;
    this.entries.set(entry.key, entry);
    try {
      const options: LspClientOptions = {
        command,
        cwd: entry.root,
        env: this.env,
        config: this.config,
        onNotification: (method, params) => this.onNotification(entry, method, params),
        onExit: () => this.onExit(entry),
      };
      const client = await createLspClient(options);
      entry.client = client;
      entry.documents = new DocumentSync({
        maxDocuments: this.config.maxDocuments,
        diagnosticsWaitMs: this.config.diagnosticsWaitMs,
        notify: (method, params) => client.notify(method, params),
        now: this.now,
      });
      entry.lastUsedAt = this.now();
      return { ok: true, entry };
    } catch (error) {
      entry.disposing = true;
      this.entries.delete(entry.key);
      return failure(
        "START_FAILED",
        `${entry.language} server failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      entry.starting = false;
    }
  }

  private onNotification(entry: PoolEntry, method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics" || !entry.documents) return;
    const publish = params as { uri?: string; version?: number | null; diagnostics?: unknown[] };
    if (typeof publish.uri !== "string" || !Array.isArray(publish.diagnostics)) return;
    entry.documents.publish({
      uri: publish.uri,
      version: publish.version,
      diagnostics: publish.diagnostics,
    });
  }

  private onExit(entry: PoolEntry): void {
    if (entry.disposing || entry.exitRecorded) return;
    entry.exitRecorded = true;
    entry.client = undefined;
    entry.documents?.reset();
    entry.documents = undefined;

    const now = this.now();
    entry.crashTimes = entry.crashTimes.filter((time) => now - time < CRASH_WINDOW_MS);
    entry.crashTimes.push(now);
    if (entry.crashTimes.length >= 2) {
      entry.brokenReason = `the ${entry.language} server crashed twice within ${
        CRASH_WINDOW_MS / 1000
      }s; restart it explicitly`;
    }
  }

  private async stopEntry(entry: PoolEntry): Promise<void> {
    entry.disposing = true;
    const client = entry.client;
    entry.client = undefined;
    if (!client) return;
    try {
      await client.shutdown();
    } catch {
      client.transport.killTree();
    }
  }

  private async sweepIdle(): Promise<void> {
    if (this.disposed) return;
    const now = this.now();
    for (const [key, entry] of [...this.entries]) {
      if (!entry.client) continue;
      if (now - entry.lastUsedAt < this.config.idleMs) continue;
      this.entries.delete(key);
      await this.stopEntry(entry);
    }
  }

  private async sweepRss(): Promise<void> {
    if (this.disposed) return;
    const cap = this.config.maxMemoryMb * 1024 * 1024;
    for (const entry of this.entries.values()) {
      const pid = entry.client?.transport.pid;
      if (pid === undefined) continue;
      const rss = this.rssBytes(pid);
      if (rss <= cap) continue;
      entry.unhealthyUntil = this.now() + UNHEALTHY_MS;
      entry.unhealthyReason = `RSS ${Math.round(rss / 1024 / 1024)} MB exceeded ${this.config.maxMemoryMb} MB`;
      await this.stopEntry(entry);
    }
  }

  /**
   * Open one file of the server's language so project-based servers have a
   * project before a workspace-wide query. Reads stay inside the confined root.
   */
  private async openRepresentative(entry: PoolEntry): Promise<void> {
    if (!entry.documents || entry.documents.openCount > 0) return;
    const extensions = REPRESENTATIVE_EXTENSIONS[entry.language];
    const queue = [entry.root];
    for (let visited = 0; queue.length > 0 && visited < 300; visited += 1) {
      const dir = queue.shift();
      if (!dir) break;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entryOnDisk of entries) {
        if (entryOnDisk.isDirectory()) {
          if (!WARM_SKIP_DIRS.has(entryOnDisk.name) && !entryOnDisk.name.startsWith(".")) {
            queue.push(join(dir, entryOnDisk.name));
          }
          continue;
        }
        if (!entryOnDisk.isFile()) continue;
        if (!extensions.some((ext) => entryOnDisk.name.endsWith(ext))) continue;
        const path = join(dir, entryOnDisk.name);
        try {
          const text = await readFile(path, "utf8");
          if (Buffer.byteLength(text) > this.config.maxFileBytes) continue;
          entry.documents.open({
            uri: pathToFileURL(path).href,
            languageId: entry.language,
            text,
          });
        } catch {
          // A file that disappears mid-scan is not a reason to fail the query.
        }
        return;
      }
    }
  }

  private async call<T>(entry: PoolEntry, method: string, params: unknown): Promise<T> {
    const client = entry.client;
    if (!client) throw new LspTransportError("language server is not running", "TRANSPORT_CLOSED");
    entry.lastUsedAt = this.now();
    return client.request<T>(method, params);
  }

  private failed(error: unknown): LspFailure {
    if (error instanceof LspTransportError) {
      if (error.code === "RPC_ERROR") return failure("RPC_ERROR", error.message);
      if (error.code === "TIMEOUT") return failure("TIMEOUT", error.message);
      return failure("SERVER_EXITED", error.message);
    }
    return failure("RPC_ERROR", error instanceof Error ? error.message : String(error));
  }

  private health(entry: PoolEntry, now: number): LspServerHealth {
    if (entry.brokenReason) return "broken";
    if (entry.unhealthyUntil !== undefined && now < entry.unhealthyUntil) return "unhealthy";
    if (entry.starting) return "starting";
    if (entry.client && !entry.client.transport.exited) return "ready";
    return "stopped";
  }

  private async locationsResult(raw: unknown, cap: number): Promise<LspLocationsResult> {
    const items = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const truncated = items.length > cap;
    const locations: LspLocation[] = [];
    for (const item of items.slice(0, cap)) {
      const location = item as LocationLike;
      const uri = location.uri ?? location.targetUri;
      const range = location.range ?? location.targetSelectionRange;
      if (typeof uri !== "string" || !range) continue;
      const path = uriToPath(uri);
      if (!path) continue;
      locations.push({
        path,
        line: range.start.line + 1,
        column: range.start.character + 1,
        preview: await this.preview(path, range.start.line),
      });
    }
    return { ok: true, locations, truncated };
  }

  private symbolsResult(raw: unknown[], documentPath?: string): LspSymbolsResult {
    const normalized = this.normalizeSymbols(raw, documentPath);
    return { ok: true, symbols: normalized.symbols, truncated: normalized.truncated };
  }

  private normalizeSymbols(
    raw: unknown,
    documentPath?: string,
  ): { symbols: LspSymbol[]; truncated: boolean } {
    const items = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const symbols: LspSymbol[] = [];
    let truncated = false;

    const push = (symbol: LspSymbol): void => {
      if (symbols.length >= MAX_LOCATIONS) {
        truncated = true;
        return;
      }
      symbols.push(symbol);
    };

    const add = (item: unknown, fallbackPath?: string): void => {
      const symbol = item as {
        name?: string;
        kind?: number;
        range?: RangeLike;
        selectionRange?: RangeLike;
        location?: { uri?: string; range?: RangeLike };
        children?: unknown[];
      };
      if (typeof symbol.name !== "string") return;
      const uri = symbol.location?.uri;
      const range = symbol.location?.range ?? symbol.selectionRange ?? symbol.range;
      const path = uri ? uriToPath(uri) : fallbackPath;
      if (range) {
        push({
          name: symbol.name,
          kind: typeof symbol.kind === "number" ? symbol.kind : 0,
          ...(path === undefined ? {} : { path }),
          line: range.start.line + 1,
          column: range.start.character + 1,
        });
      }
      if (Array.isArray(symbol.children)) {
        for (const child of symbol.children.slice(0, MAX_SYMBOL_CHILDREN)) {
          add(child, path);
        }
        if (symbol.children.length > MAX_SYMBOL_CHILDREN) truncated = true;
      }
    };

    for (const item of items) add(item, documentPath);
    if (items.length > MAX_LOCATIONS) truncated = true;
    return { symbols, truncated };
  }

  private editsResult(raw: unknown): LspEditResult {
    const edit = (raw ?? {}) as {
      changes?: Record<string, { range?: RangeLike; newText?: string }[]>;
      documentChanges?: {
        textDocument?: { uri?: string };
        edits?: { range?: RangeLike; newText?: string }[];
      }[];
    };
    const edits: LspEdit[] = [];

    const add = (
      path: string | undefined,
      change: { range?: RangeLike; newText?: string },
    ): void => {
      if (!path || !change.range || typeof change.newText !== "string") return;
      edits.push({
        path,
        range: {
          start: { line: change.range.start.line + 1, column: change.range.start.character + 1 },
          end: { line: change.range.end.line + 1, column: change.range.end.character + 1 },
        },
        newText: change.newText,
      });
    };

    for (const [uri, changes] of Object.entries(edit.changes ?? {})) {
      const path = uriToPath(uri);
      for (const change of changes) add(path, change);
    }
    for (const documentChange of edit.documentChanges ?? []) {
      const path = documentChange.textDocument?.uri
        ? uriToPath(documentChange.textDocument.uri)
        : undefined;
      for (const change of documentChange.edits ?? []) add(path, change);
    }

    const truncated = edits.length > MAX_LOCATIONS;
    return { ok: true, edits: edits.slice(0, MAX_LOCATIONS), truncated };
  }

  private async preview(path: string, line: number): Promise<string> {
    try {
      const text = await readFile(path, "utf8");
      const target = text.split("\n")[line] ?? "";
      return target.trim().slice(0, 200);
    } catch {
      return "";
    }
  }
}

function position(input: LspPositionInput): { line: number; character: number } {
  return { line: input.line - 1, character: input.column - 1 };
}

function uriToPath(uri: string): string | undefined {
  if (!uri.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function severityName(severity: number | undefined): LspDiagnostic["severity"] {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "info";
  return "hint";
}

function hoverText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  const hover = raw as { contents?: unknown };
  const contents = hover.contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof (entry as { value?: unknown }).value === "string"
            ? (entry as { value: string }).value
            : "",
      )
      .filter((entry) => entry.length > 0)
      .join("\n");
  }
  if (contents && typeof (contents as { value?: unknown }).value === "string") {
    return (contents as { value: string }).value;
  }
  return "";
}

export function createLspManager(options: LspManagerOptions): LspManager {
  return new LspManagerImpl(options);
}
