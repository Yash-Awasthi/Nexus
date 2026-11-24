// SPDX-License-Identifier: Apache-2.0
/**
 * lsp-tools — RuntimeTools over the pooled `@nexus/lsp` manager.
 *
 * Five read-only tools (`lsp_definition`, `lsp_references`, `lsp_hover`,
 * `lsp_document_symbols`, `lsp_diagnostics`) and two gated ones (`lsp_rename`,
 * `lsp_code_actions`). Every path is contained by the manager; results arrive
 * already capped (200 locations, 20 references, 8 KB hover, 200 diagnostics)
 * and `truncated` is passed through instead of being hidden. `lsp_rename`
 * returns an edit for the model to apply through `edit_file`; nothing here
 * writes a file or executes a server command.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_LSP_CONFIG,
  createLspManager,
  languageForPath,
  parseLspConfig,
  resolveWorkspaceRoot,
  splitRootList,
  type LspAuthorize,
  type LspCodeActionsResult,
  type LspConfig,
  type LspDiagnosticsResult,
  type LspEditResult,
  type LspFailure,
  type LspLanguage,
  type LspLocationsResult,
  type LspManager,
  type LspSymbolsResult,
} from "@nexus/lsp";
import { withToolSpan } from "@nexus/telemetry";

import type { RuntimeTool, ToolContext } from "./index.ts";

/** Tool names that never require approval. `classifyTool` reads the same list. */
export const LSP_READ_ONLY_TOOLS: readonly string[] = Object.freeze([
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_document_symbols",
  "lsp_diagnostics",
]);

/** Tool names that mutate the workspace and stay behind the approval gate. */
export const LSP_GATED_TOOLS: readonly string[] = Object.freeze(["lsp_rename", "lsp_code_actions"]);

const LANGUAGE_ENV: Readonly<Record<LspLanguage, string>> = Object.freeze({
  typescript: "NEXUS_LSP_TYPESCRIPT_CMD",
  python: "NEXUS_LSP_PYTHON_CMD",
  go: "NEXUS_LSP_GO_CMD",
  rust: "NEXUS_LSP_RUST_CMD",
});

const LANGUAGES: readonly LspLanguage[] = ["typescript", "python", "go", "rust"];

/** Per-language availability, surfaced when a configured binary is missing. */
export interface LspLanguageStatus {
  language: LspLanguage;
  available: boolean;
  /** Present when `available` is false; names the variable to set. */
  reason?: string;
}

export interface CreateLspToolsOptions {
  /** Workspace root used to report paths relative to it. */
  root: string;
  manager: LspManager;
  /** Availability probe results; an unavailable language fails early by name. */
  languages?: readonly LspLanguageStatus[];
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`\`${name}\` must be a non-empty string`);
  }
  return value;
}

function asLine(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`\`${name}\` must be a 1-based integer`);
  return n;
}

function throwIfAborted(ctx?: ToolContext): void {
  if (ctx?.signal?.aborted) throw new Error("aborted");
}

function relativePath(root: string, target: string): string {
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return target;
  return rel.split(path.sep).join("/");
}

function unavailableMessage(language: LspLanguage, command: string): string {
  const binary = path.basename(command) || DEFAULT_LSP_CONFIG.commands[language].command;
  return `${language}: set ${LANGUAGE_ENV[language]} to a ${binary} binary`;
}

function failureError(failure: LspFailure, filePath: string): Error {
  const language = languageForPath(filePath);
  if (language && (failure.code === "START_FAILED" || failure.code === "NO_SERVER")) {
    return new Error(`${unavailableMessage(language, "")}: ${failure.reason}`);
  }
  return new Error(`${failure.code}: ${failure.reason}`);
}

function unwrap<T extends { ok: true }>(result: T | LspFailure, filePath: string): T {
  if (!result.ok) throw failureError(result, filePath);
  return result;
}

function statusFor(
  languages: readonly LspLanguageStatus[] | undefined,
  filePath: string,
): LspLanguageStatus | undefined {
  const language = languageForPath(filePath);
  return language ? languages?.find((entry) => entry.language === language) : undefined;
}

function assertAvailable(
  toolName: string,
  filePath: string,
  languages: readonly LspLanguageStatus[] | undefined,
): string {
  const status = statusFor(languages, filePath);
  if (status && !status.available) {
    throw new Error(status.reason ?? `${status.language}: language server is not installed`);
  }
  return languageForPath(filePath) ?? "unknown";
}

function normaliseLocations(root: string, result: LspLocationsResult): unknown {
  return {
    locations: result.locations.map((location) => ({
      ...location,
      path: relativePath(root, location.path),
    })),
    truncated: result.truncated,
  };
}

const POSITION_PROPERTIES = {
  path: { type: "string", description: "Workspace-relative file path." },
  line: { type: "integer", description: "1-based line number." },
  column: { type: "integer", description: "1-based column number." },
} as const;

export function createLspTools(options: CreateLspToolsOptions): RuntimeTool[] {
  const { root, manager, languages } = options;

  const readOnly = (
    name: string,
    operation: string,
    description: string,
    run: (args: Record<string, unknown>) => Promise<unknown>,
  ): RuntimeTool => ({
    name,
    description,
    parameters: {
      type: "object",
      properties: POSITION_PROPERTIES,
      required: ["path", "line", "column"],
    },
    async handler(args, ctx) {
      throwIfAborted(ctx);
      const filePath = asString(args.path, "path");
      const line = asLine(args.line, "line");
      const column = asLine(args.column, "column");
      const language = assertAvailable(name, filePath, languages);
      return withToolSpan(name, "auto_allowed", () => run({ path: filePath, line, column }), {
        "lsp.language": language,
        "lsp.operation": operation,
      });
    },
  });

  const readOnlyFile = (
    name: string,
    operation: string,
    description: string,
    run: (filePath: string) => Promise<unknown>,
  ): RuntimeTool => ({
    name,
    description,
    parameters: {
      type: "object",
      properties: { path: POSITION_PROPERTIES.path },
      required: ["path"],
    },
    async handler(args, ctx) {
      throwIfAborted(ctx);
      const filePath = asString(args.path, "path");
      const language = assertAvailable(name, filePath, languages);
      return withToolSpan(name, "auto_allowed", () => run(filePath), {
        "lsp.language": language,
        "lsp.operation": operation,
      });
    },
  });

  const definition = readOnly(
    "lsp_definition",
    "definition",
    "Go to the definition of the symbol at a 1-based line and column. Returns " +
      "{locations, truncated}; each location has path, line, column and a one-line preview.",
    async (args) => {
      const input = {
        path: args.path as string,
        line: args.line as number,
        column: args.column as number,
      };
      return normaliseLocations(root, unwrap(await manager.definition(input), input.path));
    },
  );

  const references = readOnly(
    "lsp_references",
    "references",
    "Find references to the symbol at a 1-based line and column. Returns " +
      "{locations, truncated} capped at 20 references.",
    async (args) => {
      const input = {
        path: args.path as string,
        line: args.line as number,
        column: args.column as number,
      };
      return normaliseLocations(root, unwrap(await manager.references(input), input.path));
    },
  );

  const hover = readOnly(
    "lsp_hover",
    "hover",
    "Show type and documentation for the symbol at a 1-based line and column. " +
      "Returns {contents, truncated}; hover text is capped at 8 KB.",
    async (args) => {
      const input = {
        path: args.path as string,
        line: args.line as number,
        column: args.column as number,
      };
      const result = unwrap(await manager.hover(input), input.path);
      return { contents: result.contents, truncated: result.truncated };
    },
  );

  const documentSymbols = readOnlyFile(
    "lsp_document_symbols",
    "document_symbol",
    "List the symbols declared in a file. Returns {symbols, truncated}; each symbol " +
      "has name, kind, path, line and column.",
    async (filePath) => {
      const result: LspSymbolsResult = unwrap(
        await manager.documentSymbols({ path: filePath }),
        filePath,
      );
      return {
        symbols: result.symbols.map((symbol) => ({
          ...symbol,
          ...(symbol.path === undefined ? {} : { path: relativePath(root, symbol.path) }),
        })),
        truncated: result.truncated,
      };
    },
  );

  const diagnostics = readOnlyFile(
    "lsp_diagnostics",
    "diagnostics",
    "Return the language server's diagnostics for a file. Returns " +
      "{diagnostics, stale, truncated}; `stale` means the wait timed out.",
    async (filePath) => {
      const result: LspDiagnosticsResult = unwrap(
        await manager.diagnostics({ path: filePath }),
        filePath,
      );
      return {
        diagnostics: result.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: relativePath(root, diagnostic.path),
        })),
        stale: result.stale,
        truncated: result.truncated,
      };
    },
  );

  const rename: RuntimeTool = {
    name: "lsp_rename",
    description:
      "Rename a symbol and return {edits, truncated, applied: false}. Each edit has " +
      "{path, range, newText}; apply it with edit_file. This tool never writes a file.",
    parameters: {
      type: "object",
      properties: {
        ...POSITION_PROPERTIES,
        new_name: { type: "string", description: "New symbol name." },
      },
      required: ["path", "line", "column", "new_name"],
    },
    async handler(args, ctx) {
      throwIfAborted(ctx);
      const filePath = asString(args.path, "path");
      const line = asLine(args.line, "line");
      const column = asLine(args.column, "column");
      const newName = asString(args.new_name, "new_name");
      const language = assertAvailable("lsp_rename", filePath, languages);
      return withToolSpan(
        "lsp_rename",
        "requires_permission",
        async () => {
          const result: LspEditResult = unwrap(
            await manager.rename({ path: filePath, line, column, newName }),
            filePath,
          );
          return {
            edits: result.edits.map((edit) => ({
              ...edit,
              path: relativePath(root, edit.path),
            })),
            truncated: result.truncated,
            applied: false,
          };
        },
        { "lsp.language": language, "lsp.operation": "rename" },
      );
    },
  };

  const codeActions: RuntimeTool = {
    name: "lsp_code_actions",
    description:
      "List code actions for a 1-based range. Returns {actions, truncated, applied: false} " +
      "with title, kind, command and edits; nothing is executed or written.",
    parameters: {
      type: "object",
      properties: {
        ...POSITION_PROPERTIES,
        end_line: { type: "integer", description: "1-based end line (default: line)." },
        end_column: { type: "integer", description: "1-based end column (default: column)." },
      },
      required: ["path", "line", "column"],
    },
    async handler(args, ctx) {
      throwIfAborted(ctx);
      const filePath = asString(args.path, "path");
      const line = asLine(args.line, "line");
      const column = asLine(args.column, "column");
      const endLine = args.end_line === undefined ? undefined : asLine(args.end_line, "end_line");
      const endColumn =
        args.end_column === undefined ? undefined : asLine(args.end_column, "end_column");
      const language = assertAvailable("lsp_code_actions", filePath, languages);
      return withToolSpan(
        "lsp_code_actions",
        "requires_permission",
        async () => {
          const result: LspCodeActionsResult = unwrap(
            await manager.codeActions({
              path: filePath,
              line,
              column,
              ...(endLine === undefined ? {} : { endLine }),
              ...(endColumn === undefined ? {} : { endColumn }),
            }),
            filePath,
          );
          return {
            actions: result.actions.map((action) => ({
              ...action,
              edits: action.edits.map((edit) => ({
                ...edit,
                path: relativePath(root, edit.path),
              })),
            })),
            truncated: result.truncated,
            applied: false,
          };
        },
        { "lsp.language": language, "lsp.operation": "code_action" },
      );
    },
  };

  return [definition, references, hover, documentSymbols, diagnostics, rename, codeActions];
}

// ── Runtime wiring (NEXUS_LSP=1 + a contained root) ───────────────────────────

export interface CreateLspRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  /** Tool-context working directory; tried before NEXUS_LSP_ROOTS. */
  workingDir?: string;
  config?: Partial<LspConfig>;
  /** Spawn authorization; the API supplies the exec-policy decision. */
  authorize?: LspAuthorize;
  /** Reuse an existing manager instead of creating one. */
  manager?: LspManager;
}

export interface LspRuntime {
  root: string;
  manager: LspManager;
  tools: RuntimeTool[];
  languages: LspLanguageStatus[];
  dispose(): Promise<void>;
}

function commandAvailable(command: string, env: NodeJS.ProcessEnv): boolean {
  if (!command) return false;
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    if (existsSync(command)) return true;
    return extensions.some((extension) => existsSync(`${command}${extension}`));
  }
  const search = env.PATH ?? env.Path ?? "";
  return search
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) =>
      extensions.some((extension) => existsSync(path.join(dir, `${command}${extension}`))),
    );
}

function languageStatuses(config: LspConfig, env: NodeJS.ProcessEnv): LspLanguageStatus[] {
  return LANGUAGES.map((language) => {
    const command = config.commands[language].command;
    return commandAvailable(command, env)
      ? { language, available: true }
      : {
          language,
          available: false,
          reason: unavailableMessage(language, command),
        };
  });
}

/**
 * Build the LSP toolset when `NEXUS_LSP=1` and a root resolves through the
 * `@nexus/lsp` containment order; otherwise return `undefined` so callers add
 * no tools and fail nothing. A missing binary leaves only that language
 * unavailable, with the variable to set in the error.
 */
export function createLspRuntime(options: CreateLspRuntimeOptions = {}): LspRuntime | undefined {
  const env = options.env ?? process.env;
  const parsed = parseLspConfig(env);
  const config: LspConfig = {
    ...parsed,
    ...options.config,
    commands: { ...parsed.commands, ...options.config?.commands },
  };

  let manager: LspManager;
  let root: string;
  const injected = options.manager;
  if (injected) {
    const status = injected.status();
    if (!status.enabled || !status.available || !status.root) return undefined;
    manager = injected;
    root = status.root;
  } else {
    if (!config.enabled) return undefined;
    const resolution = resolveWorkspaceRoot({
      workingDir: options.workingDir,
      lspRoots: config.roots,
      execRoots: splitRootList(env.NEXUS_EXEC_ROOTS),
      workspaceDir: env.NEXUS_WORKSPACE_DIR,
      env,
    });
    if (!resolution.available) return undefined;
    root = resolution.root;
    manager = createLspManager({
      env,
      config,
      workingDir: options.workingDir,
      authorize: options.authorize ?? (() => "allow"),
    });
  }

  const languages = languageStatuses(config, env);
  return {
    root,
    manager,
    languages,
    tools: createLspTools({ root, manager, languages }),
    dispose: () => (injected ? Promise.resolve() : manager.dispose()),
  };
}
