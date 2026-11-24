// SPDX-License-Identifier: Apache-2.0
/**
 * LSP configuration parsed from the `NEXUS_LSP_*` environment names in
 * plan.md Appendix A.1. Defaults match that table.
 */

export type LspLogLevel = "off" | "info" | "debug";

export interface LspCommand {
  /** Executable as written in the env value; never resolved through a shell. */
  command: string;
  args: string[];
}

export interface LspConfig {
  /** `NEXUS_LSP=1` enables the feature; unset or `0` keeps it off. */
  enabled: boolean;
  commands: {
    typescript: LspCommand;
    python: LspCommand;
    go: LspCommand;
    rust: LspCommand;
  };
  /** Absolute roots this feature may open. Empty means "fall back" for the API. */
  roots: string[];
  maxServers: number;
  idleMs: number;
  startTimeoutMs: number;
  requestTimeoutMs: number;
  diagnosticsWaitMs: number;
  maxMemoryMb: number;
  maxDocuments: number;
  maxFileBytes: number;
  log: LspLogLevel;
}

const DEFAULT_COMMANDS = {
  typescript: "typescript-language-server --stdio",
  python: "pyright-langserver --stdio",
  go: "gopls",
  rust: "rust-analyzer",
} as const;

export const DEFAULT_LSP_CONFIG: Readonly<LspConfig> = Object.freeze({
  enabled: false,
  commands: {
    typescript: { command: "typescript-language-server", args: ["--stdio"] },
    python: { command: "pyright-langserver", args: ["--stdio"] },
    go: { command: "gopls", args: [] },
    rust: { command: "rust-analyzer", args: [] },
  },
  roots: [],
  maxServers: 2,
  idleMs: 300_000,
  startTimeoutMs: 15_000,
  requestTimeoutMs: 10_000,
  diagnosticsWaitMs: 3_000,
  maxMemoryMb: 1_024,
  maxDocuments: 50,
  maxFileBytes: 1_000_000,
  log: "off",
});

/**
 * Split a command line on whitespace, honouring double quotes so that a path
 * such as `C:\Program Files\nodejs\node.exe` stays one argv entry.
 */
export function splitCommand(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;

  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (started) {
        parts.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quoted) throw new Error(`unterminated double quote in command: ${input}`);
  if (started) parts.push(current);
  return parts;
}

function parseCommand(value: string | undefined, fallback: string): LspCommand {
  const raw = value?.trim() ? value : fallback;
  const [command = "", ...args] = splitCommand(raw);
  return { command, args };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseRoots(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseLogLevel(value: string | undefined): LspLogLevel {
  return value === "info" || value === "debug" ? value : "off";
}

export function parseLspConfig(env: NodeJS.ProcessEnv = process.env): LspConfig {
  return {
    enabled: env.NEXUS_LSP === "1",
    commands: {
      typescript: parseCommand(env.NEXUS_LSP_TYPESCRIPT_CMD, DEFAULT_COMMANDS.typescript),
      python: parseCommand(env.NEXUS_LSP_PYTHON_CMD, DEFAULT_COMMANDS.python),
      go: parseCommand(env.NEXUS_LSP_GO_CMD, DEFAULT_COMMANDS.go),
      rust: parseCommand(env.NEXUS_LSP_RUST_CMD, DEFAULT_COMMANDS.rust),
    },
    roots: parseRoots(env.NEXUS_LSP_ROOTS),
    maxServers: positiveInt(env.NEXUS_LSP_MAX_SERVERS, DEFAULT_LSP_CONFIG.maxServers),
    idleMs: positiveInt(env.NEXUS_LSP_IDLE_MS, DEFAULT_LSP_CONFIG.idleMs),
    startTimeoutMs: positiveInt(env.NEXUS_LSP_START_TIMEOUT_MS, DEFAULT_LSP_CONFIG.startTimeoutMs),
    requestTimeoutMs: positiveInt(
      env.NEXUS_LSP_REQUEST_TIMEOUT_MS,
      DEFAULT_LSP_CONFIG.requestTimeoutMs,
    ),
    diagnosticsWaitMs: positiveInt(
      env.NEXUS_LSP_DIAGNOSTICS_WAIT_MS,
      DEFAULT_LSP_CONFIG.diagnosticsWaitMs,
    ),
    maxMemoryMb: positiveInt(env.NEXUS_LSP_MAX_MEMORY_MB, DEFAULT_LSP_CONFIG.maxMemoryMb),
    maxDocuments: positiveInt(env.NEXUS_LSP_MAX_DOCUMENTS, DEFAULT_LSP_CONFIG.maxDocuments),
    maxFileBytes: positiveInt(env.NEXUS_LSP_MAX_FILE_BYTES, DEFAULT_LSP_CONFIG.maxFileBytes),
    log: parseLogLevel(env.NEXUS_LSP_LOG),
  };
}
