// SPDX-License-Identifier: Apache-2.0
/**
 * fs-tools — Read-only filesystem RuntimeTools scoped to a workspace root.
 *
 * These bridge the auto-allowed read-only tool names (`read_file`, `list_files`,
 * `glob`, `grep`) into a {@link RuntimeToolSet}. Every path argument is resolved
 * against `ctx.workingDir` and rejected if it escapes that root, so an agent can
 * never read outside the workspace it was granted. No tool here mutates state or
 * makes an outbound call — they are pure reads, which is why their names live in
 * `AUTO_ALLOWED_TOOLS` and need no permission gate.
 *
 * Zero runtime dependencies: the glob matcher and directory walker are inlined to
 * avoid pulling a glob library into the agent hot-path.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { RuntimeTool, ToolContext } from "./index.js";

/** Directory names skipped by recursive walks (`glob`, `grep`, recursive `list_files`). */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".next",
  "dist",
  "coverage",
]);

/** Cap on files scanned by a single recursive walk — a runaway-loop backstop. */
const MAX_WALK_FILES = 20_000;
/** Cap on bytes read by `read_file` in one call. */
const MAX_READ_BYTES = 2_000_000;
/** Default cap on rows returned by `glob` / `grep` / `list_files`. */
const DEFAULT_RESULT_LIMIT = 500;

/**
 * Resolve `p` against the workspace `root`, guaranteeing the result stays inside
 * it. Absolute paths and `..` traversal that escape the root are rejected.
 */
export function resolveInWorkspace(root: string, p: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, p);
  const rel = path.relative(base, resolved);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
    throw new Error(`path escapes workspace root: ${p}`);
  }
  return resolved;
}

/** Pull the required workspace root from a tool context, or throw. */
function requireRoot(ctx?: ToolContext): string {
  const root = ctx?.workingDir;
  if (!root) throw new Error("filesystem tools require ctx.workingDir (workspace root)");
  return root;
}

function throwIfAborted(ctx?: ToolContext): void {
  if (ctx?.signal?.aborted) throw new Error("aborted");
}

/** Convert a glob (`*`, `**`, `?`) to an anchored RegExp matching a relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero path segments
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|[]{}".includes(c as string)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Yield every file (as a root-relative, forward-slash path) under `dir`. */
async function* walkFiles(
  root: string,
  dir: string,
  ctx: ToolContext | undefined,
  counter: { n: number },
): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    throwIfAborted(ctx);
    if (counter.n >= MAX_WALK_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      yield* walkFiles(root, full, ctx, counter);
    } else if (e.isFile()) {
      counter.n++;
      yield toRel(root, full);
    }
  }
}

function toRel(root: string, full: string): string {
  return path.relative(path.resolve(root), full).split(path.sep).join("/");
}

function asString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`\`${name}\` must be a non-empty string`);
  }
  return v;
}

function asPosInt(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`expected a non-negative number, got ${String(v)}`);
  return Math.floor(n);
}

// ── read_file ────────────────────────────────────────────────────────────────

function readFileTool(): RuntimeTool {
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file within the workspace. Optional line-based `offset` " +
      "(0-based) and `limit` return a slice. Paths outside the workspace are rejected.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        offset: { type: "integer", description: "0-based first line to return." },
        limit: { type: "integer", description: "Maximum number of lines to return." },
      },
      required: ["path"],
    },
    async handler(args, ctx) {
      const root = requireRoot(ctx);
      const target = resolveInWorkspace(root, asString(args.path, "path"));
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error(`not a file: ${String(args.path)}`);
      if (stat.size > MAX_READ_BYTES) {
        throw new Error(`file too large (${stat.size} bytes > ${MAX_READ_BYTES} cap): ${String(args.path)}`);
      }
      const text = await fs.readFile(target, "utf8");
      if (args.offset === undefined && args.limit === undefined) return text;
      const lines = text.split("\n");
      const offset = asPosInt(args.offset, 0);
      const limit = args.limit === undefined ? lines.length : asPosInt(args.limit, lines.length);
      return lines.slice(offset, offset + limit).join("\n");
    },
  };
}

// ── list_files ───────────────────────────────────────────────────────────────

function listFilesTool(): RuntimeTool {
  return {
    name: "list_files",
    description:
      "List entries in a workspace directory (default the root). With `recursive: " +
      "true` walks subdirectories, skipping node_modules/.git/dist. Directories end in `/`.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory (default `.`)." },
        recursive: { type: "boolean", description: "Recurse into subdirectories." },
        limit: { type: "integer", description: `Max entries (default ${DEFAULT_RESULT_LIMIT}).` },
      },
    },
    async handler(args, ctx) {
      const root = requireRoot(ctx);
      const dir = resolveInWorkspace(root, typeof args.path === "string" ? args.path : ".");
      const limit = asPosInt(args.limit, DEFAULT_RESULT_LIMIT);
      const out: string[] = [];
      if (args.recursive === true) {
        const counter = { n: 0 };
        for await (const rel of walkFiles(root, dir, ctx, counter)) {
          out.push(rel);
          if (out.length >= limit) break;
        }
        out.sort();
        return out;
      }
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        out.push(e.isDirectory() ? `${e.name}/` : e.name);
        if (out.length >= limit) break;
      }
      out.sort();
      return out;
    },
  };
}

// ── glob ─────────────────────────────────────────────────────────────────────

function globTool(): RuntimeTool {
  return {
    name: "glob",
    description:
      "Find files whose workspace-relative path matches a glob (`*`, `**`, `?`). " +
      "Searches from `path` (default the root). Returns relative paths, sorted.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob such as `**/*.ts` or `src/*.json`." },
        path: { type: "string", description: "Workspace-relative directory to search from." },
        limit: { type: "integer", description: `Max results (default ${DEFAULT_RESULT_LIMIT}).` },
      },
      required: ["pattern"],
    },
    async handler(args, ctx) {
      const root = requireRoot(ctx);
      const from = resolveInWorkspace(root, typeof args.path === "string" ? args.path : ".");
      const re = globToRegExp(asString(args.pattern, "pattern"));
      const limit = asPosInt(args.limit, DEFAULT_RESULT_LIMIT);
      const fromRel = toRel(root, from);
      const out: string[] = [];
      const counter = { n: 0 };
      for await (const rel of walkFiles(root, from, ctx, counter)) {
        // Match against the path relative to the search root, so `*.ts` behaves
        // intuitively when `path` narrows the search.
        const candidate = fromRel ? rel.slice(fromRel.length + 1) : rel;
        if (re.test(candidate) || re.test(rel)) {
          out.push(rel);
          if (out.length >= limit) break;
        }
      }
      out.sort();
      return out;
    },
  };
}

// ── grep ─────────────────────────────────────────────────────────────────────

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

function grepTool(): RuntimeTool {
  return {
    name: "grep",
    description:
      "Search file contents for a JavaScript regex within the workspace. Optional " +
      "`glob` filters which files are scanned. Returns {file, line, text} matches.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Workspace-relative directory to search from." },
        glob: { type: "string", description: "Only scan files whose relative path matches this glob." },
        flags: { type: "string", description: "Regex flags (default `i`)." },
        limit: { type: "integer", description: `Max matches (default ${DEFAULT_RESULT_LIMIT}).` },
      },
      required: ["pattern"],
    },
    async handler(args, ctx) {
      const root = requireRoot(ctx);
      const from = resolveInWorkspace(root, typeof args.path === "string" ? args.path : ".");
      const flags = typeof args.flags === "string" ? args.flags : "i";
      const re = new RegExp(asString(args.pattern, "pattern"), flags);
      const globRe = typeof args.glob === "string" ? globToRegExp(args.glob) : null;
      const limit = asPosInt(args.limit, DEFAULT_RESULT_LIMIT);
      const out: GrepMatch[] = [];
      const counter = { n: 0 };
      for await (const rel of walkFiles(root, from, ctx, counter)) {
        if (globRe && !globRe.test(rel)) continue;
        throwIfAborted(ctx);
        let text: string;
        try {
          const stat = await fs.stat(path.join(path.resolve(root), rel));
          if (stat.size > MAX_READ_BYTES) continue;
          text = await fs.readFile(path.join(path.resolve(root), rel), "utf8");
        } catch {
          continue; // unreadable / vanished mid-walk — skip
        }
        if (text.includes("\u0000")) continue; // skip binary
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i] as string)) {
            out.push({ file: rel, line: i + 1, text: (lines[i] as string).slice(0, 500) });
            if (out.length >= limit) return out;
          }
        }
      }
      return out;
    },
  };
}

/**
 * Build the read-only filesystem tools (`read_file`, `list_files`, `glob`,
 * `grep`). Each is scoped to `ctx.workingDir` and rejects paths that escape it.
 * All four names are auto-allowed by {@link classifyTool}, so no gate is needed.
 */
export function createFilesystemTools(): RuntimeTool[] {
  return [readFileTool(), listFilesTool(), globTool(), grepTool()];
}

// ── edit_file (mutating, gated) ────────────────────────────────────────────────

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Build the `edit_file` tool: an exact string replacement on a workspace file.
 *
 * Unlike the batch {@link StrReplaceProcessor} (first-match, in-memory), this
 * enforces uniqueness — `old_string` must match exactly once unless `replace_all`
 * is set — so an edit can never silently hit the wrong occurrence. It is a
 * mutating tool, so its name resolves to the `requires_permission` tier via
 * {@link classifyTool} (NOT auto-allowed); callers opt in explicitly by adding it.
 */
export function createEditFileTool(): RuntimeTool {
  return {
    name: "edit_file",
    description:
      "Replace an exact string in a workspace file. `old_string` must appear exactly " +
      "once unless `replace_all` is true. Paths outside the workspace are rejected. " +
      "This is a mutating, permission-gated tool.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        old_string: { type: "string", description: "Exact text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
      },
      required: ["path", "old_string", "new_string"],
    },
    async handler(args, ctx) {
      const root = requireRoot(ctx);
      const target = resolveInWorkspace(root, asString(args.path, "path"));
      const oldStr = asString(args.old_string, "old_string");
      const newStr = typeof args.new_string === "string" ? args.new_string : "";
      if (oldStr === newStr) throw new Error("`old_string` and `new_string` are identical");
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error(`not a file: ${String(args.path)}`);
      const content = await fs.readFile(target, "utf8");
      const count = countOccurrences(content, oldStr);
      if (count === 0) throw new Error(`\`old_string\` not found in ${String(args.path)}`);
      const replaceAll = args.replace_all === true;
      if (count > 1 && !replaceAll) {
        throw new Error(
          `\`old_string\` is not unique in ${String(args.path)} (${count} matches); ` +
            "pass replace_all: true or include more surrounding context",
        );
      }
      const updated = replaceAll
        ? content.split(oldStr).join(newStr)
        : content.replace(oldStr, newStr);
      await fs.writeFile(target, updated, "utf8");
      return { path: toRel(root, target), replaced: replaceAll ? count : 1 };
    },
  };
}

// ── run_command (mutating, gated, injected executor) ───────────────────────────

/** Outcome of a sandboxed command — a narrowing of `@nexus/sandbox`'s SandboxResult. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Executor seam for {@link createRunCommandTool}. The intended binding is
 * `@nexus/sandbox`'s `executeCode` running the command as `language: "bash"`,
 * but any implementation satisfying this contract works — which keeps
 * `agent-runtime` free of a hard sandbox dependency and makes the tool trivially
 * mockable in tests.
 *
 * @example
 * import { executeCode } from "@nexus/sandbox";
 * const exec: CommandExecutor = async (command, opts) => {
 *   const r = await executeCode({
 *     taskType: "sandbox.execute", language: "bash", code: command,
 *     timeoutMs: opts.timeoutMs,
 *   });
 *   return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut };
 * };
 * toolSet.add(createRunCommandTool(exec));
 */
export type CommandExecutor = (
  command: string,
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
) => Promise<CommandResult>;

/**
 * Build the `run_command` tool, delegating execution to an injected sandbox
 * {@link CommandExecutor}. The workspace root (`ctx.workingDir`) is forwarded as
 * the command's `cwd`. Being mutating, its name resolves to `requires_permission`
 * via {@link classifyTool} (NOT auto-allowed) — callers opt in explicitly.
 */
export function createRunCommandTool(exec: CommandExecutor): RuntimeTool {
  return {
    name: "run_command",
    description:
      "Execute a shell command inside the workspace sandbox. Runs in `ctx.workingDir`. " +
      "Returns {stdout, stderr, exitCode, timedOut}. Mutating, permission-gated.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run (executed as bash)." },
        timeout_ms: { type: "integer", description: "Optional execution timeout in milliseconds." },
      },
      required: ["command"],
    },
    async handler(args, ctx) {
      throwIfAborted(ctx);
      const command = asString(args.command, "command");
      const timeoutMs = args.timeout_ms === undefined ? undefined : asPosInt(args.timeout_ms, 0) || undefined;
      return exec(command, { cwd: ctx?.workingDir, timeoutMs, signal: ctx?.signal });
    },
  };
}
