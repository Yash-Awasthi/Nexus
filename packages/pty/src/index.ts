// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/pty — local pseudo-terminal sessions for agent CLIs.
 *
 * Headless by design: there is no Electron/IPC surface — each session
 * exposes subscriber callbacks (`onData`, `onExit`) that an HTTP route can
 * forward over SSE, and a bounded output tail for crash diagnostics.
 *
 * Localhost-only by design: this spawns real processes on the machine the
 * API runs on, so it must never be reachable from the public internet. The
 * caller (a route) is responsible for the localhost gate; this package only
 * owns the session lifecycle.
 *
 * Safety model inherited from the original:
 *   - command names are validated (`isSafeCommandName`) before PATH
 *     resolution — metacharacters never reach a shell;
 *   - `.cmd`/`.bat` shims are decoded to their real interpreter (or routed
 *     through the shell) so Windows spawn works;
 *   - each session keeps a bounded output tail (TAIL_MAX) so an abnormal
 *     exit can report what was on screen without unbounded memory.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import * as pty from "node-pty";

// ── Types ────────────────────────────────────────────────────────────────────

/** What the exit handler is told about a process that just died. */
export interface PtyExitInfo {
  exitCode?: number;
  signal?: number;
  tail?: string;
  command?: string;
  cwd?: string;
}

export interface SpawnOptions {
  /** Caller-assigned session id (must be unique). */
  id: string;
  /** Command to spawn, e.g. "claude" or an absolute path. */
  command: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface PtySession {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  /** Bounded ring of the most recent output bytes (crash diagnostics). */
  tail: string;
  /** True after the child emitted at least one frame. */
  hasOutput: boolean;
  startedAt: number;
  exited: boolean;
  exitCode?: number;
  signal?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** How much trailing PTY output to retain per session for crash diagnostics. */
const TAIL_MAX = 8192;

/** Exited sessions are kept (for tail replay + diagnostics) but bounded —
 *  beyond this count the oldest exited sessions are evicted so a long-lived
 *  server never accumulates unbounded history. */
const MAX_RETAINED_EXITED = 20;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Only a plain command name is resolved against PATH. Anything else is
 *  refused so it never reaches `which`/`where` with metacharacters. */
export function isSafeCommandName(command: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(command);
}

/**
 * Resolve a bare command (e.g. "claude") against PATH + common install
 * locations. Returns the best path AND
 * whether an existing executable was actually located — when nothing is
 * found, `path` falls back to the bare command and `found` is false.
 */
export function resolveCommand(command: string): { path: string; found: boolean } {
  // Already an absolute/relative path — pass through; `found` reflects disk.
  if (command.includes("/") || command.includes("\\")) {
    return { path: command, found: existsSync(command) };
  }
  // Only a plain command name is resolved against PATH.
  if (!isSafeCommandName(command)) return { path: command, found: false };

  if (process.platform === "win32") {
    // `where` is the Windows equivalent of `which`. Skip extensionless hits
    // and take the first PATHEXT-eligible one (.CMD/.BAT/.EXE/…).
    try {
      const res = spawnSync("where", [command], { encoding: "utf8", timeout: 3000 });
      const lines = (res.stdout ?? "")
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const pathExts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((e) => e.trim().toUpperCase())
        .filter(Boolean);
      const isExecutable = (p: string): boolean => {
        const dot = p.lastIndexOf(".");
        const sep = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
        if (dot <= sep) return false; // no extension on the basename
        return pathExts.includes(p.slice(dot).toUpperCase());
      };
      const exe = lines.find((p) => isExecutable(p) && existsSync(p));
      if (exe) return { path: exe, found: true };
    } catch {
      /* fall through to candidate dirs */
    }
    // Common Windows install locations (npm global = %APPDATA%\npm\<cmd>.cmd).
    const appData = process.env.APPDATA ?? "";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    const candidates = [
      `${appData}\\npm\\${command}.cmd`,
      `${appData}\\npm\\${command}`,
      `${localAppData}\\npm\\${command}.cmd`,
      `${localAppData}\\npm\\${command}`,
      `${home}\\npm\\${command}.cmd`,
      `${home}\\npm\\${command}`,
    ];
    const hit = candidates.find((p) => existsSync(p));
    if (hit) return { path: hit, found: true };
    return { path: command, found: false };
  }

  // POSIX: `which` (or `command -v`) against the interactive PATH.
  try {
    const res = spawnSync("sh", ["-lc", `command -v -- "${command}"`], {
      encoding: "utf8",
      timeout: 3000,
    });
    const out = (res.stdout ?? "").trim();
    if (out && existsSync(out)) return { path: out, found: true };
  } catch {
    /* fall through */
  }
  return { path: command, found: false };
}

/**
 * Decode a `.cmd`/`.bat` npm shim to its real interpreter target, or null
 * when the file isn't an npm-style shim (caller then routes through the
 * shell).
 */
export function parseNpmCmdShim(content: string): { target: string; args: string[] } | null {
  // npm .cmd shims look like:
  //   @ECHO off
  //   node "%~dp0\..\<pkg>\bin\<bin>.js" %*
  // The target is the quoted path after the node invocation on the first line.
  // Real npm .cmd shims are two lines: `@ECHO off` then
  // `node "%~dp0\..\<pkg>\bin\<bin>.js" %*` — search the whole file, not
  // just the first line. `node` is typically bare but may be quoted.
  const m = /(?:["']?[^"'\s]*node[^"'\s]*["']?)?\s*"%~dp0\\([^"]+)"/i.exec(content);
  if (!m) return null;
  return { target: m[1]!.replace(/\\/g, "/"), args: [] };
}

// ── PtyManager ───────────────────────────────────────────────────────────────

interface PtyRecord {
  id: string;
  proc: pty.IPty;
  command: string;
  cwd: string;
  tail: string;
  hasOutput: boolean;
  startedAt: number;
  exited: boolean;
  exitCode?: number;
  signal?: number;
}

export class PtyManager {
  private sessions = new Map<string, PtyRecord>();

  /** Live subscribers per session (SSE forwarders). */
  private dataSubs = new Map<string, Set<(data: string) => void>>();
  private exitSubs = new Map<string, Set<(info: PtyExitInfo) => void>>();

  constructor(
    private opts: {
      /** Absolute path override for the PTY shell on Windows (default ComSpec). */
      windowsShell?: string;
    } = {},
  ) {}

  /** Subscribe to a session's output. Returns an unsubscribe fn. */
  onData(id: string, cb: (data: string) => void): () => void {
    if (!this.sessions.has(id)) {
      throw new Error(`no such pty session: ${id}`);
    }
    let set = this.dataSubs.get(id);
    if (!set) {
      set = new Set();
      this.dataSubs.set(id, set);
    }
    set.add(cb);
    // Replay the tail so a late subscriber sees prior output.
    const rec = this.sessions.get(id)!;
    if (rec.tail) cb(rec.tail);
    return () => {
      set!.delete(cb);
    };
  }

  /** Subscribe to a session's exit. Returns an unsubscribe fn. */
  onExit(id: string, cb: (info: PtyExitInfo) => void): () => void {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error(`no such pty session: ${id}`);
    if (rec.exited) {
      cb({
        exitCode: rec.exitCode,
        signal: rec.signal,
        tail: rec.tail,
        command: rec.command,
        cwd: rec.cwd,
      });
      return () => {};
    }
    let set = this.exitSubs.get(id);
    if (!set) {
      set = new Set();
      this.exitSubs.set(id, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  }

  /** Whether an engine CLI is actually installed/locatable on this machine. */
  isCommandAvailable(command: string): boolean {
    return resolveCommand(command).found;
  }

  /** The absolute path a bare command resolves to, or null when missing. */
  commandPath(command: string): string | null {
    const r = resolveCommand(command);
    return r.found ? r.path : null;
  }

  /** Live sessions (snapshot for listing). */
  list(): PtySession[] {
    const out: PtySession[] = [];
    for (const rec of this.sessions.values()) {
      out.push({
        id: rec.id,
        command: rec.command,
        cwd: rec.cwd,
        pid: rec.proc.pid,
        tail: rec.tail,
        hasOutput: rec.hasOutput,
        startedAt: rec.startedAt,
        exited: rec.exited,
        exitCode: rec.exitCode,
        signal: rec.signal,
      });
    }
    return out;
  }

  /** Spawn a PTY session. Throws when the command is missing or the id is taken. */
  spawn(opts: SpawnOptions): PtySession {
    if (this.sessions.has(opts.id)) throw new Error(`pty session id already exists: ${opts.id}`);
    const { path, found } = resolveCommand(opts.command);
    if (!found) {
      throw new Error(
        `command not found: ${opts.command} — install it or give an absolute path (Nexus runs on ${process.platform})`,
      );
    }
    const cwd = opts.cwd ?? process.cwd();
    // Windows .cmd/.bat shims are not directly spawnable by node-pty's
    // CreateProcess (error 193) — route them through the shell.
    let file = path;
    let args = opts.args ?? [];
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
      const shell = this.opts.windowsShell ?? process.env.ComSpec ?? "cmd.exe";
      const quoted = `"${file}"${args.length ? ` ${args.map((a) => `"${a}"`).join(" ")}` : ""}`;
      file = shell;
      args = ["/d", "/s", "/c", quoted];
    }

    let proc: pty.IPty;
    try {
      proc = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      throw new Error(
        `failed to spawn ${opts.command}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const rec: PtyRecord = {
      id: opts.id,
      proc,
      command: opts.command,
      cwd,
      tail: "",
      hasOutput: false,
      startedAt: Date.now(),
      exited: false,
    };
    this.sessions.set(opts.id, rec);

    proc.onData((data) => {
      rec.hasOutput = true;
      rec.tail = (rec.tail + data).slice(-TAIL_MAX);
      const subs = this.dataSubs.get(opts.id);
      if (subs) for (const cb of subs) cb(data);
    });
    proc.onExit(({ exitCode, signal }) => {
      rec.exited = true;
      rec.exitCode = exitCode;
      rec.signal = signal;
      const info: PtyExitInfo = {
        exitCode,
        signal,
        tail: rec.tail,
        command: rec.command,
        cwd: rec.cwd,
      };
      const subs = this.exitSubs.get(opts.id);
      if (subs) for (const cb of subs) cb(info);
      this.exitSubs.delete(opts.id);
      this.dataSubs.delete(opts.id);
      // Bound retained history: evict the oldest exited sessions beyond the cap.
      const exited = [...this.sessions.values()].filter((s) => s.exited);
      const excess = exited.length - MAX_RETAINED_EXITED;
      if (excess > 0) {
        const oldest = exited.slice(0, excess);
        for (const s of oldest) this.sessions.delete(s.id);
      }
    });

    return this.list().find((s) => s.id === opts.id)!;
  }

  /** Write input to a session (throws when it doesn't exist or already exited). */
  write(id: string, data: string): void {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error(`no such pty session: ${id}`);
    if (rec.exited) throw new Error(`pty session already exited: ${id}`);
    rec.proc.write(data);
  }

  /** Resize a session's terminal. */
  resize(id: string, cols: number, rows: number): void {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error(`no such pty session: ${id}`);
    rec.proc.resize(cols, rows);
  }

  /** Kill a session (best-effort; already-exited is a no-op). */
  kill(id: string): PtyExitInfo | undefined {
    const rec = this.sessions.get(id);
    if (!rec) return undefined;
    try {
      rec.proc.kill();
    } catch {
      /* already gone */
    }
    // Give the onExit a tick to fire naturally; if the caller needs the info
    // synchronously, return the current tail.
    return {
      command: rec.command,
      cwd: rec.cwd,
      tail: rec.tail,
      exitCode: rec.exitCode,
      signal: rec.signal,
    };
  }

  /**
   * Kill AND fully remove a session (DELETE semantics). Unlike kill(), this
   * drops the record immediately — the caller is done with it and the tail is
   * no longer needed. Killing a live process fires its onExit async; the
   * record is already gone by then, so the exit handler's eviction path skips it.
   */
  remove(id: string): PtyExitInfo | undefined {
    const rec = this.sessions.get(id);
    if (!rec) return undefined;
    const info: PtyExitInfo = {
      command: rec.command,
      cwd: rec.cwd,
      tail: rec.tail,
      exitCode: rec.exitCode,
      signal: rec.signal,
    };
    try {
      if (!rec.exited) rec.proc.kill();
    } catch {
      /* already gone */
    }
    this.sessions.delete(id);
    this.dataSubs.delete(id);
    this.exitSubs.delete(id);
    return info;
  }

  /** Drop all sessions (server shutdown). */
  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  /** Count of live (not-yet-exited) sessions. */
  get liveCount(): number {
    let n = 0;
    for (const rec of this.sessions.values()) if (!rec.exited) n++;
    return n;
  }
}
