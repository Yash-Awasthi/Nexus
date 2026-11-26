// SPDX-License-Identifier: Apache-2.0
/**
 * The API's half of the LSP plane: one pooled manager for the process, and the
 * spawn gate that connects it to @nexus/exec-policy and the approval store.
 *
 * The manager knows nothing about HTTP or approvals; it asks this module's
 * `authorize` before every spawn. The request that caused the spawn carries its
 * caller and any approval id through AsyncLocalStorage, so the callback can
 * answer for that user without the manager learning anything about requests.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";

import { decide, policyFromEnv, type ExecAction } from "@nexus/exec-policy";
import {
  createLspManager,
  languageForPath,
  parseLspConfig,
  type LspAuthorizeResult,
  type LspLanguage,
  type LspManager,
  type LspManagerStatus,
  type LspSpawnAction,
} from "@nexus/lsp";

import { redeemApproval, requestApproval, type RedeemFailure } from "./exec-approvals.ts";

/** Every language a server can be configured for, in display order. */
export const LSP_LANGUAGES: readonly LspLanguage[] = ["typescript", "python", "go", "rust"];

/** The env name a missing language server points the operator at. */
const COMMAND_ENV: Readonly<Record<LspLanguage, string>> = {
  typescript: "NEXUS_LSP_TYPESCRIPT_CMD",
  python: "NEXUS_LSP_PYTHON_CMD",
  go: "NEXUS_LSP_GO_CMD",
  rust: "NEXUS_LSP_RUST_CMD",
};

export interface ApiLspServerStatus {
  language: LspLanguage;
  state: string;
  pid?: number;
  rssMb: number;
  requests: number;
}

export interface ApiLspLanguageStatus {
  language: LspLanguage;
  available: boolean;
  reason?: string;
}

export interface ApiLspStatus {
  enabled: boolean;
  root?: string;
  servers: ApiLspServerStatus[];
  languages: ApiLspLanguageStatus[];
}

interface LspRequestContext {
  ownerId: string;
  approvalId?: string;
  /** The route already spent an approval for this exact action. */
  redeemed?: boolean;
}

const _context = new AsyncLocalStorage<LspRequestContext>();
const _requests = new Map<LspLanguage, number>();
const _rssByPid = new Map<number, number>();

let _manager: LspManager | null = null;

/** RSS sampler; the manager's watchdog needs the value, status reports it in MB. */
function sampleRss(pid: number): number {
  if (process.platform !== "linux") return 0;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    const bytes = match?.[1] ? Number(match[1]) * 1024 : 0;
    if (bytes > 0) _rssByPid.set(pid, bytes);
    return bytes;
  } catch {
    return 0;
  }
}

/**
 * Gate one spawn the way every other executing surface does. A denial names
 * the rule, so the caller can fix the policy rather than guess at it.
 */
export async function authorizeLspSpawn(action: LspSpawnAction): Promise<LspAuthorizeResult> {
  const execAction: ExecAction = {
    surface: "lsp",
    command: action.command,
    args: action.args,
    cwd: action.cwd,
  };
  const verdict = decide(execAction, policyFromEnv());

  if (verdict.decision === "deny") {
    return { decision: "deny", reason: `Denied by rule [${verdict.rule}]: ${verdict.reason}` };
  }
  if (verdict.decision === "allow") return "allow";

  const context = _context.getStore();
  if (context?.redeemed) return "allow";
  if (!context) {
    return {
      decision: "deny",
      reason: "Approval required, but no user is attached to this language-server spawn.",
    };
  }

  if (context.approvalId) {
    const redeemed = redeemApproval(context.ownerId, context.approvalId, execAction);
    if (typeof redeemed !== "string") return "allow";
    return {
      decision: "deny",
      reason: `Approval ${context.approvalId} cannot be used: ${redeemed}.`,
    };
  }

  const pending = requestApproval(context.ownerId, execAction, verdict.reason);
  return { decision: "ask", reason: verdict.reason, approvalId: pending.id };
}

/** Run an LSP call as its caller, so the spawn gate can find the approval owner. */
export function withLspRequest<T>(
  ownerId: string,
  approvalId: string | undefined,
  fn: () => Promise<T>,
  redeemed = false,
): Promise<T> {
  const context: LspRequestContext =
    approvalId === undefined
      ? { ownerId, ...(redeemed ? { redeemed } : {}) }
      : { ownerId, approvalId, ...(redeemed ? { redeemed } : {}) };
  return _context.run(context, fn);
}

/**
 * Spend a granted approval for one language's spawn. Called by the route before
 * touching the pool, so a replay is refused even when the server is already up.
 */
export function redeemLspStart(
  ownerId: string,
  language: LspLanguage,
  approvalId: string,
): "ok" | RedeemFailure {
  const command = parseLspConfig(process.env).commands[language];
  const root = getLspManager().status().root ?? process.env.NEXUS_WORKSPACE_DIR ?? "";
  const result = redeemApproval(ownerId, approvalId, {
    surface: "lsp",
    command: command.command,
    args: command.args,
    ...(root ? { cwd: root } : {}),
  });
  return typeof result === "string" ? result : "ok";
}

/** Count successful calls per language, which is what status reports as `requests`. */
function instrument(manager: LspManager): LspManager {
  const bump = (language: LspLanguage | undefined, ok: boolean): void => {
    if (!language || !ok) return;
    _requests.set(language, (_requests.get(language) ?? 0) + 1);
  };
  const fromPath = (path: string) => languageForPath(path);

  return {
    async definition(input) {
      const result = await manager.definition(input);
      bump(fromPath(input.path), result.ok);
      return result;
    },
    async references(input) {
      const result = await manager.references(input);
      bump(fromPath(input.path), result.ok);
      return result;
    },
    async hover(input) {
      const result = await manager.hover(input);
      bump(fromPath(input.path), result.ok);
      return result;
    },
    async documentSymbols(input) {
      const result = await manager.documentSymbols(input);
      bump(fromPath(input.path), result.ok);
      return result;
    },
    async diagnostics(input) {
      const result = await manager.diagnostics(input);
      bump(fromPath(input.path), result.ok);
      return result;
    },
    async rename(input) {
      const result = await manager.rename(input);
      bump(fromPath(input.path), result.ok);
      return result;
    },
    async codeActions(input) {
      const result = await manager.codeActions(input);
      bump(fromPath(input.path), result.ok);
      return result;
    },
    async workspaceSymbols(input) {
      const result = await manager.workspaceSymbols(input);
      bump(input.language, result.ok);
      return result;
    },
    status: () => manager.status(),
    restart: (language) => manager.restart(language),
    dispose: () => manager.dispose(),
  };
}

/** The process-wide manager. Created on first use so env is read from the started app. */
export function getLspManager(): LspManager {
  if (_manager) return _manager;
  const manager = createLspManager({
    env: process.env,
    workingDir: process.env.NEXUS_WORKSPACE_DIR,
    authorize: authorizeLspSpawn,
    rssBytes: sampleRss,
  });
  _manager = instrument(manager);
  return _manager;
}

/** Install a manager for tests; `_resetLspForTests` removes it again. */
export function _setLspManagerForTests(manager: LspManager): void {
  _manager = instrument(manager);
}

/** Reset the pool and counters. Tests use this between environment changes. */
export async function _resetLspForTests(): Promise<void> {
  const manager = _manager;
  _manager = null;
  _requests.clear();
  _rssByPid.clear();
  await manager?.dispose();
}

function managerStatus(manager: LspManager): LspManagerStatus {
  return manager.status();
}

/**
 * Whether the configured command resolves the way a shell would: an absolute or
 * path-containing command must exist (with PATHEXT on Windows), and a bare name
 * must be found on PATH. Same rule as the agent-core toolset uses, copied here
 * so the API does not depend on agent-core for a filesystem probe.
 */
function commandAvailable(command: string, env: NodeJS.ProcessEnv): boolean {
  if (!command) return false;
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    if (existsSync(command)) return true;
    return extensions.some((extension) => existsSync(`${command}${extension}`));
  }
  const search = env.PATH ?? env.Path ?? "";
  return search
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => extensions.some((extension) => existsSync(join(dir, `${command}${extension}`))));
}

/** Names the variable to set; only the binary's basename, never the full path. */
function unavailableReason(language: LspLanguage, command: string): string {
  const binary = command ? basename(command) : "language server";
  return `${language}: set ${COMMAND_ENV[language]} to a ${binary} binary`;
}

/** Availability per language, naming the env variable that is missing. */
function languageStatus(enabled: boolean, rootReason: string | undefined): ApiLspLanguageStatus[] {
  const config = parseLspConfig(process.env);
  return LSP_LANGUAGES.map((language) => {
    if (!enabled) {
      return { language, available: false, reason: "LSP is disabled; set NEXUS_LSP=1" };
    }
    if (rootReason) return { language, available: false, reason: rootReason };
    const command = config.commands[language].command;
    if (!commandAvailable(command, process.env)) {
      return { language, available: false, reason: unavailableReason(language, command) };
    }
    return { language, available: true };
  });
}

/** The status payload; no command line and no root of an entry, only the workspace root. */
export function lspStatus(): ApiLspStatus {
  const manager = getLspManager();
  const raw = managerStatus(manager);
  const servers: ApiLspServerStatus[] = raw.servers.map((server) => {
    const pid = server.pid;
    const rss = pid === undefined ? 0 : (_rssByPid.get(pid) ?? 0);
    return {
      language: server.language,
      state: server.health,
      ...(pid === undefined ? {} : { pid }),
      rssMb: Math.round(rss / 1024 / 1024),
      requests: _requests.get(server.language) ?? 0,
    };
  });
  return {
    enabled: raw.enabled,
    ...(raw.root === undefined ? {} : { root: raw.root }),
    servers,
    languages: languageStatus(raw.enabled, raw.available ? undefined : raw.reason),
  };
}

/** Drop one language's counters when its servers are gone. */
export function clearLspCounters(language: LspLanguage): void {
  _requests.delete(language);
}
