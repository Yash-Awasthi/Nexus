// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace root resolution and file containment. Roots come from the tool
 * context, then `NEXUS_LSP_ROOTS`, then `NEXUS_EXEC_ROOTS`, then
 * `NEXUS_WORKSPACE_DIR`. Every path is canonicalised with `realpath`, so a
 * symlink that leaves the root is refused. No spawn happens here.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type RootSource = "context" | "lsp" | "exec" | "workspace";

export type ContainmentCode =
  | "NO_ROOT"
  | "ROOT_OUTSIDE_EXEC_ROOTS"
  | "OUTSIDE_ROOT"
  | "NOT_FOUND"
  | "NOT_A_FILE"
  | "TOO_LARGE";

export interface RootAvailable {
  available: true;
  root: string;
  source: RootSource;
}

export interface RootUnavailable {
  available: false;
  code: ContainmentCode;
  reason: string;
}

export type RootResolution = RootAvailable | RootUnavailable;

export interface RootResolverInput {
  /** Tool-context working directory; tried first. */
  workingDir?: string;
  /** Usually `parseLspConfig(env).roots`. */
  lspRoots?: string[];
  execRoots?: string[];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ContainedFile {
  ok: true;
  root: string;
  path: string;
  relative: string;
  size: number;
}

export interface ContainmentRefusal {
  ok: false;
  code: ContainmentCode;
  reason: string;
}

export type ContainmentResult = ContainedFile | ContainmentRefusal;

export function splitRootList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function canonical(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function comparable(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isWithin(root: string, target: string): boolean {
  const rel = relative(comparable(root), comparable(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Pick the first usable root. Missing or non-directory candidates fall through
 * to the next source. When `execRoots` is non-empty the chosen root must sit
 * inside one of them.
 */
export function resolveWorkspaceRoot(input: RootResolverInput = {}): RootResolution {
  const env = input.env ?? {};
  const lspRoots = input.lspRoots ?? splitRootList(env.NEXUS_LSP_ROOTS);
  const execRoots = input.execRoots ?? splitRootList(env.NEXUS_EXEC_ROOTS);
  const workspaceDir = input.workspaceDir ?? env.NEXUS_WORKSPACE_DIR;

  const candidates: { path: string; source: RootSource }[] = [];
  if (input.workingDir) candidates.push({ path: input.workingDir, source: "context" });
  if (lspRoots[0]) candidates.push({ path: lspRoots[0], source: "lsp" });
  if (execRoots[0]) candidates.push({ path: execRoots[0], source: "exec" });
  if (workspaceDir) candidates.push({ path: workspaceDir, source: "workspace" });

  if (candidates.length === 0) {
    return {
      available: false,
      code: "NO_ROOT",
      reason:
        "no workspace root: set a tool working directory, NEXUS_LSP_ROOTS, NEXUS_EXEC_ROOTS or NEXUS_WORKSPACE_DIR",
    };
  }

  let chosen: { root: string; source: RootSource } | undefined;
  for (const candidate of candidates) {
    const root = canonical(resolve(candidate.path));
    if (!root) continue;
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    chosen = { root, source: candidate.source };
    break;
  }

  if (!chosen) {
    return {
      available: false,
      code: "NO_ROOT",
      reason: "no workspace root is an existing directory",
    };
  }

  const realExecRoots = execRoots
    .map((entry) => canonical(resolve(entry)))
    .filter((entry): entry is string => entry !== undefined);
  if (realExecRoots.length > 0 && !realExecRoots.some((entry) => isWithin(entry, chosen.root))) {
    return {
      available: false,
      code: "ROOT_OUTSIDE_EXEC_ROOTS",
      reason: `workspace root ${chosen.root} is outside NEXUS_EXEC_ROOTS`,
    };
  }

  return { available: true, root: chosen.root, source: chosen.source };
}

/**
 * Canonicalise one file and prove it is a regular file inside `root`, within
 * the exec-root constraint, and under the size cap.
 */
export function containFile(input: {
  path: string;
  root: string;
  execRoots?: string[];
  maxFileBytes: number;
}): ContainmentResult {
  const rawRoot = canonical(input.root);
  if (!rawRoot) {
    return { ok: false, code: "NO_ROOT", reason: `root does not exist: ${input.root}` };
  }

  const execRoots = input.execRoots ?? [];
  if (execRoots.length > 0) {
    const realExecRoots = execRoots
      .map((entry) => canonical(resolve(entry)))
      .filter((entry): entry is string => entry !== undefined);
    if (!realExecRoots.some((entry) => isWithin(entry, rawRoot))) {
      return {
        ok: false,
        code: "ROOT_OUTSIDE_EXEC_ROOTS",
        reason: `root ${rawRoot} is outside NEXUS_EXEC_ROOTS`,
      };
    }
  }

  const absolute = isAbsolute(input.path) ? input.path : resolve(rawRoot, input.path);
  const lexical = relative(comparable(rawRoot), comparable(absolute));
  if (lexical.startsWith("..") || isAbsolute(lexical)) {
    return { ok: false, code: "OUTSIDE_ROOT", reason: `${input.path} is outside ${rawRoot}` };
  }

  const real = canonical(absolute);
  if (!real) {
    return { ok: false, code: "NOT_FOUND", reason: `file not found: ${input.path}` };
  }
  if (!isWithin(rawRoot, real)) {
    return {
      ok: false,
      code: "OUTSIDE_ROOT",
      reason: `${input.path} resolves outside ${rawRoot}`,
    };
  }

  let size: number;
  try {
    const stat = statSync(real);
    if (!stat.isFile()) {
      return { ok: false, code: "NOT_A_FILE", reason: `not a regular file: ${input.path}` };
    }
    size = stat.size;
  } catch {
    return { ok: false, code: "NOT_FOUND", reason: `file not found: ${input.path}` };
  }

  if (size > input.maxFileBytes) {
    return {
      ok: false,
      code: "TOO_LARGE",
      reason: `${input.path} is ${size} bytes; limit is ${input.maxFileBytes}`,
    };
  }

  return {
    ok: true,
    root: rawRoot,
    path: real,
    relative: relative(rawRoot, real),
    size,
  };
}
