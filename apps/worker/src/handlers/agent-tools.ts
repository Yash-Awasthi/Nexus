// SPDX-License-Identifier: Apache-2.0
/**
 * agent-tools — the Phase 1 coding tool set for the native agent loop.
 *
 * Builds a RuntimeToolSet of file + shell tools confined to a workspace root,
 * with a path-traversal guard (ported from runtime/code-agent-pool's CodeEditor).
 * These are advertised to the model via native tool-calling, making `agent.run`
 * genuinely multi-step.
 *
 * SECURITY (Phase 2): `run_command` now scrubs the environment (only safe vars
 * forwarded) and optionally wraps execution in a Docker container via
 * @nexus/sandbox's createDockerRunner. Pass `dockerConfig` to enable.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { RuntimeToolSet } from "@nexus/agent-runtime";
import {
  buildSafeEnv,
  createDockerRunner,
  type DockerSandboxConfig,
} from "@nexus/sandbox";

export interface CodingToolsOptions {
  /** Workspace root; all file ops are confined here. */
  rootDir: string;
  /** Max bytes returned by read_file / run_command output (default 64 KiB). */
  maxOutputBytes?: number;
  /** run_command timeout in ms (default 30s). */
  commandTimeoutMs?: number;
  /** Register the shell tool. Default true. */
  enableShell?: boolean;
  /** Extra env merged into run_command (safe keys only — credentials filtered). */
  env?: Record<string, string>;
  /** Optional Docker sandbox config. When set, commands run in a container. */
  dockerConfig?: DockerSandboxConfig;
}

const DEFAULT_MAX_OUTPUT = 64 * 1024;
const DEFAULT_CMD_TIMEOUT = 30_000;

/** Resolve a workspace-relative path, rejecting any escape outside rootDir
 *  AND symlinks that point outside the workspace root. Uses realpath to
 *  resolve symlinks, blocking path-traversal via symlink indirection. */
async function safeResolve(rootDir: string, p: string): Promise<string> {
  const resolved = path.resolve(rootDir, p);
  const rel = path.relative(rootDir, resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  // Symlink guard: resolve the real path and verify it stays within rootDir
  try {
    const real = await fs.realpath(resolved);
    const realRel = path.relative(rootDir, real);
    if (realRel !== "" && (realRel.startsWith("..") || path.isAbsolute(realRel))) {
      throw new Error(`symlink escapes workspace: ${p} → ${real}`);
    }
    return real;
  } catch (err) {
    // ENOENT is fine (file doesn't exist yet for writes); re-throw escape errors
    if (err instanceof Error && err.message.includes("escapes workspace")) throw err;
    return resolved; // file doesn't exist yet — let the actual operation handle ENOENT
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} bytes]` : s;
}

/** Structured audit log for every shell command executed by an agent. */
function auditLog(event: string, detail: Record<string, unknown>): void {
  console.error(JSON.stringify({
    level: "info",
    event: `agent.command.${event}`,
    ts: new Date().toISOString(),
    ...detail,
  }));
}

/**
 * Execute a shell command.
 *
 * When dockerConfig is provided, runs inside a Docker container with
 * --network=none, --cap-drop=ALL, no-new-privileges, memory + CPU caps.
 * Otherwise falls back to a direct child_process with a scrubbed env.
 */
function runCommand(
  command: string,
  cwd: string,
  maxOut: number,
  timeoutMs: number,
  env?: Record<string, string>,
  dockerConfig?: DockerSandboxConfig,
): Promise<string> {
  auditLog("started", { command: command.slice(0, 200), cwd, sandbox: dockerConfig ? "docker" : "subprocess" });
  const safeEnv = buildSafeEnv(env);

  // ── Docker path ──────────────────────────────────────────────────
  if (dockerConfig) {
    const runner = createDockerRunner(dockerConfig);
    return new Promise((resolve) => {
      runner("/bin/sh", ["-c", command], {
        timeoutMs,
        env: safeEnv,
      })
        .then((result) => {
          auditLog("finished", { exitCode: result.exitCode, timedOut: result.timedOut, sandbox: "docker" });
          const out = (result.stdout + (result.stderr ? `\n${result.stderr}` : "")).trim();
          resolve(clip(out || `[exit ${result.exitCode}]`, maxOut));
        })
        .catch((err: Error) => {
          auditLog("error", { error: err.message, sandbox: "docker" });
          resolve(`docker error: ${err.message}`);
        });
    });
  }

  // ── Direct subprocess path (scrubbed env) ────────────────────────
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: safeEnv });
    let out = "";
    let killed = false;
    const append = (d: Buffer): void => {
      if (out.length < maxOut) out += d.toString();
    };
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      clearTimeout(timer);
      auditLog("finished", { exitCode: code, timedOut: killed, sandbox: "subprocess" });
      resolve(clip(out, maxOut) + (killed ? `\n…[killed after ${timeoutMs}ms]` : `\n[exit ${code}]`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      auditLog("error", { error: err.message, sandbox: "subprocess" });
      resolve(`error: ${err.message}`);
    });
  });
}

/** Build the coding tool set (read/write/edit/list[/run]) for a workspace. */
export function createCodingToolSet(opts: CodingToolsOptions): RuntimeToolSet {
  const root = path.resolve(opts.rootDir);
  const maxOut = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const cmdTimeout = opts.commandTimeoutMs ?? DEFAULT_CMD_TIMEOUT;
  const set = new RuntimeToolSet();

  set.add({
    name: "read_file",
    description: "Read a UTF-8 text file within the workspace. Returns its contents (truncated if large).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative file path" } },
      required: ["path"],
    },
    handler: async (args) => clip(await fs.readFile(await safeResolve(root, String(args.path ?? "")), "utf8"), maxOut),
  });

  set.add({
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file within the workspace (creates parent dirs).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    handler: async (args) => {
      const p = await safeResolve(root, String(args.path ?? ""));
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, String(args.content ?? ""), "utf8");
      return `wrote ${path.relative(root, p)}`;
    },
  });

  set.add({
    name: "edit_file",
    description: "Replace the first exact occurrence of old_str with new_str in a workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_str: { type: "string", description: "Exact text to find" },
        new_str: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_str", "new_str"],
    },
    handler: async (args) => {
      const p = await safeResolve(root, String(args.path ?? ""));
      const oldStr = String(args.old_str ?? "");
      const content = await fs.readFile(p, "utf8");
      if (!content.includes(oldStr)) throw new Error("old_str not found in file");
      await fs.writeFile(p, content.replace(oldStr, String(args.new_str ?? "")), "utf8");
      return `edited ${path.relative(root, p)}`;
    },
  });

  set.add({
    name: "list_files",
    description: "List files and directories directly under a workspace-relative path (non-recursive).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative directory (default '.')" } },
    },
    handler: async (args) => {
      const entries = await fs.readdir(await safeResolve(root, String(args.path ?? ".")), {
        withFileTypes: true,
      });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
    },
  });

  if (opts.enableShell !== false) {
    set.add({
      name: "run_command",
      description:
        "Run a shell command in the workspace root; returns combined stdout/stderr + exit code. " +
        (opts.dockerConfig
          ? "Runs in an isolated Docker container (no network, dropped capabilities)."
          : "Runs with a scrubbed environment (no credentials leaked)."),
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command line" } },
        required: ["command"],
      },
      handler: (args) =>
        runCommand(String(args.command ?? ""), root, maxOut, cmdTimeout, opts.env, opts.dockerConfig),
    });
  }

  return set;
}
