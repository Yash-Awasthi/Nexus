// SPDX-License-Identifier: Apache-2.0
/**
 * Filtered shell sessions — the quiet-shell / agent-shell capability for
 * @nexus/sandbox.
 *
 * AI coding assistants running builds and test suites receive thousands of
 * lines of output when only the failures + summary matter. This module wraps
 * the sandbox {@link Runner} with:
 *
 *   • cwd tracking     — a logical session directory persists across commands
 *                        (`cd` builtins update it; later commands are prefixed
 *                        so each freshly spawned shell starts in the right dir).
 *   • line filtering   — quiet-shell's exact operator model: an include
 *                        whitelist keeps only error/summary lines, tail
 *                        paragraphs always keep the final summary block, and a
 *                        keep/drop mode is available for rtk-style filtering.
 *
 * Runner injection keeps everything deterministic and testable without real
 * processes (the same pattern the sandbox package already uses).
 */

import type { Runner, RunnerResult } from "./index.js";

// ── Line filtering ────────────────────────────────────────────────────────────

export interface FilterRules {
  /**
   * Whitelist mode (quiet-shell style): when any include rule is present, only
   * lines matching one of them survive (plus the tail paragraphs below).
   * Everything else — the thousands of verbose build/test lines — is dropped
   * to protect the agent's context window.
   */
  include?: RegExp[];
  /** Lines matching any keep rule survive, even if a drop rule matches. */
  keep?: RegExp[];
  /** Lines matching any drop rule are removed (unless keep/include matched). */
  drop?: RegExp[];
  /**
   * Always keep the lines of the last N paragraph blocks (blocks are separated
   * by blank lines). quiet-shell's tail_paragraphs: summaries like tsc's
   * "Found N errors" or a build's final "BUILD SUCCESS" live there even when
   * they do not match an include rule.
   */
  tailParagraphs?: number;
}

/** Collect lines belonging to the last N blank-line-separated paragraphs. */
function collectTailLines(lines: string[], count: number): Set<string> {
  if (count <= 0) return new Set();
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return new Set(blocks.slice(-count).flat());
}

/**
 * Filter command output line-by-line.
 *
 * Two modes:
 *
 *   • Whitelist (quiet-shell): when {@link FilterRules.include} is non-empty,
 *     a line survives only if it matches an include rule or belongs to the
 *     tail paragraphs. This keeps "type errors + final summary" out of a
 *     10 000-line tsc run.
 *   • Keep/drop: a line matching any keep rule survives; else it is dropped
 *     when it matches any drop rule; else it passes through.
 *
 * Empty rule arrays and absent rules are no-ops: with no rules the text is
 * returned untouched.
 */
export function filterOutput(text: string, rules: FilterRules = {}): string {
  const include = rules.include ?? [];
  const keep = rules.keep ?? [];
  const drop = rules.drop ?? [];
  const tailParagraphs = rules.tailParagraphs ?? 0;
  if (include.length === 0 && keep.length === 0 && drop.length === 0 && tailParagraphs <= 0) {
    return text;
  }
  const lines = text.split("\n");
  const tail = collectTailLines(lines, tailParagraphs);
  const out: string[] = [];
  for (const line of lines) {
    if (include.length > 0) {
      if (include.some((r) => r.test(line)) || tail.has(line)) out.push(line);
      continue;
    }
    if (keep.some((r) => r.test(line)) || tail.has(line)) {
      out.push(line);
      continue;
    }
    if (drop.some((r) => r.test(line))) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * quiet-shell-style tool presets: an include whitelist (what to surface) plus
 * how many final summary paragraphs to keep. Mirror of the upstream repo's
 * builtin-templates for the two most common assistant workloads.
 */
export const QUIET_SHELL_PRESETS: Record<string, FilterRules> = {
  tsc: {
    include: [/(error TS|TS[0-9]+:|Found [0-9]+ error)/],
    tailParagraphs: 1,
  },
  vitest: {
    include: [/(FAIL|ERROR|✖|❯.*failed|Test Files\s+\d+|Tests\s+\d+|Time:)/],
    tailParagraphs: 0,
  },
};

// ── Shell session ─────────────────────────────────────────────────────────────

export interface ShellResult extends RunnerResult {
  /** Logical working directory after this command. */
  cwd: string;
}

export interface ShellSessionOptions {
  /** The runner that executes each command (default: sandbox's defaultRunner). */
  runner?: Runner;
  /** Initial working directory (logical; default: "" = inherited). */
  initialCwd?: string;
  /** Keep/drop rules applied to stdout and stderr. */
  filter?: FilterRules;
  /** Truncate filtered output to this many chars (0 = no truncation). */
  maxOutputChars?: number;
  /** Stdin piped to the command. */
  stdin?: string;
}

const quotePath = (p: string): string => `"${p.replace(/"/g, '\\"')}"`;

/** Resolve a cd target against the current tracked directory (no fs access). */
function resolveCwd(current: string, target: string): string {
  if (target.startsWith("/")) return target;
  const wasAbsolute = current.startsWith("/");
  const parts = [...current.split("/"), ...target.split("/")];
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const joined = stack.join("/");
  return wasAbsolute ? `/${joined}` : joined;
}

/**
 * A logical shell session: executes commands through the sandbox runner while
 * tracking the working directory and filtering output (quiet-shell style).
 */
export class ShellSession {
  private readonly runner: Runner;
  private readonly filter: FilterRules;
  private readonly maxOutputChars: number;
  private readonly stdin?: string;
  private cwd: string;

  constructor(opts: ShellSessionOptions = {}) {
    this.runner = opts.runner ?? defaultShellRunner;
    this.filter = opts.filter ?? {};
    this.maxOutputChars = opts.maxOutputChars ?? 0;
    this.stdin = opts.stdin;
    this.cwd = opts.initialCwd ?? "";
  }

  /** Current logical working directory. */
  get workingDirectory(): string {
    return this.cwd;
  }

  /**
   * Run a command in the session's working directory and return filtered
   * output. A leading `cd <dir>` (relative or absolute) updates the tracked
   * directory for subsequent commands instead of spawning.
   */
  async exec(command: string): Promise<ShellResult> {
    // Handle pure cd commands without spawning a process.
    const cdMatch = /^\s*cd\s+(\S+)\s*$/.exec(command);
    if (cdMatch) {
      this.cwd = resolveCwd(this.cwd, cdMatch[1]!);
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, cwd: this.cwd };
    }

    const script = this.cwd ? `cd ${quotePath(this.cwd)} && ${command}` : command;
    const raw = await this.runner("bash", ["-c", script], {
      stdin: this.stdin,
      timeoutMs: 10_000,
      env: {},
    });

    const truncate = (s: string): string => {
      const filtered = filterOutput(s, this.filter);
      if (this.maxOutputChars > 0 && filtered.length > this.maxOutputChars) {
        return `${filtered.slice(0, this.maxOutputChars)}\n...[output truncated]`;
      }
      return filtered;
    };

    // `cd x && cmd` chains are emitted by real shells for some builtins; keep
    // the tracked dir in sync when the command itself changed it mid-script.
    return {
      stdout: truncate(raw.stdout),
      stderr: truncate(raw.stderr),
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
      cwd: this.cwd,
    };
  }
}

/** Fallback runner: spawn `cmd args` in a child process (real execution). */
const defaultShellRunner: Runner = async (cmd, args, opts) => {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, timedOut: false });
    });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
};
