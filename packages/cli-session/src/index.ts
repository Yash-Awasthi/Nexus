// SPDX-License-Identifier: Apache-2.0
/**
 * cli-session — Persistent CLI subprocess session manager.
 *
 * Manages the lifecycle of a long-running CLI subprocess:
 *   spawn → register PID → capture stdout/stderr → kill/cleanup.
 *
 * Provides:
 *   • ProcessSpawner     — injectable subprocess interface (real + mock)
 *   • CliSessionState    — session state machine
 *   • CliSession         — manages one CLI subprocess lifecycle
 *   • SessionManager     — tracks multiple named sessions
 *   • AllowedDirPolicy   — sandbox: restrict filesystem access to allowed dirs
 *   • StderrCapture      — ring-buffer stderr capture
 *   • AuthTokenInjector  — inject auth headers into subprocess environment
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionStatus = "idle" | "starting" | "running" | "stopping" | "stopped" | "crashed";

/** Spawn options interface definition. */
export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  allowedDirs?: string[];
}

/** Spawn result interface definition. */
export interface SpawnResult {
  pid: number;
  /** Write to stdin */
  write(input: string): void;
  /** Kill the subprocess */
  kill(signal?: string): void;
  /** Subscribe to stdout lines */
  onStdout(cb: (line: string) => void): void;
  /** Subscribe to stderr lines */
  onStderr(cb: (line: string) => void): void;
  /** Subscribe to exit */
  onExit(cb: (code: number | null) => void): void;
}

/** Process spawner interface definition. */
export interface ProcessSpawner {
  spawn(opts: SpawnOptions): SpawnResult;
}

// ── MockProcess ───────────────────────────────────────────────────────────────

export class MockProcess implements SpawnResult {
  pid: number;
  private stdoutCbs: ((line: string) => void)[] = [];
  private stderrCbs: ((line: string) => void)[] = [];
  private exitCbs: ((code: number | null) => void)[] = [];
  writtenInputs: string[] = [];
  killed = false;
  killSignal?: string;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(input: string): void {
    this.writtenInputs.push(input);
  }

  kill(signal = "SIGTERM"): void {
    this.killed = true;
    this.killSignal = signal;
    this.exitCbs.forEach((cb) => cb(null));
  }

  onStdout(cb: (line: string) => void): void {
    this.stdoutCbs.push(cb);
  }
  onStderr(cb: (line: string) => void): void {
    this.stderrCbs.push(cb);
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb);
  }

  // Test helpers
  emitStdout(line: string): void {
    this.stdoutCbs.forEach((cb) => cb(line));
  }
  emitStderr(line: string): void {
    this.stderrCbs.forEach((cb) => cb(line));
  }
  emitExit(code: number | null): void {
    this.exitCbs.forEach((cb) => cb(code));
  }
}

let _pidSeq = 1000;

/** Mock process spawner. */
export class MockProcessSpawner implements ProcessSpawner {
  lastOptions?: SpawnOptions;
  processes: MockProcess[] = [];

  spawn(opts: SpawnOptions): SpawnResult {
    this.lastOptions = opts;
    const proc = new MockProcess(++_pidSeq);
    this.processes.push(proc);
    return proc;
  }

  lastProcess(): MockProcess | undefined {
    return this.processes[this.processes.length - 1];
  }
}

// ── StderrCapture ─────────────────────────────────────────────────────────────

export class StderrCapture {
  private lines: string[] = [];
  private maxLines: number;

  constructor(maxLines = 1000) {
    this.maxLines = maxLines;
  }

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  recent(n = 50): string[] {
    return this.lines.slice(-n);
  }
  all(): string[] {
    return [...this.lines];
  }
  clear(): void {
    this.lines = [];
  }
  count(): number {
    return this.lines.length;
  }
}

// ── AllowedDirPolicy ──────────────────────────────────────────────────────────

export class AllowedDirPolicy {
  private dirs: string[];

  constructor(dirs: string[]) {
    this.dirs = dirs.map((d) => (d.endsWith("/") ? d : `${d}/`));
  }

  isAllowed(path: string): boolean {
    if (this.dirs.length === 0) return true;
    const normalized = path.endsWith("/") ? path : `${path}/`;
    return this.dirs.some((d) => normalized.startsWith(d) || path === d.slice(0, -1));
  }

  getAllowed(): string[] {
    return [...this.dirs];
  }
}

// ── AuthTokenInjector ─────────────────────────────────────────────────────────

export class AuthTokenInjector {
  private tokens: Record<string, string> = {};

  setToken(key: string, value: string): this {
    this.tokens[key] = value;
    return this;
  }

  inject(env: Record<string, string> = {}): Record<string, string> {
    return { ...env, ...this.tokens };
  }

  clear(): void {
    this.tokens = {};
  }
}

// ── CliSession ────────────────────────────────────────────────────────────────

export interface CliSessionOptions {
  command: string;
  args?: string[];
  cwd?: string;
  allowedDirs?: string[];
  env?: Record<string, string>;
  authInjector?: AuthTokenInjector;
  stderrMaxLines?: number;
}

/** Session output interface definition. */
export interface SessionOutput {
  stdout: string[];
  stderr: string[];
}

/** Cli session. */
export class CliSession {
  readonly id: string;
  private status: SessionStatus = "idle";
  private spawner: ProcessSpawner;
  private opts: CliSessionOptions;
  private proc?: SpawnResult;
  private stdoutLines: string[] = [];
  private stderrCapture: StderrCapture;
  private dirPolicy?: AllowedDirPolicy;
  private exitCode: number | null = null;
  private outputListeners: ((line: string) => void)[] = [];

  constructor(id: string, spawner: ProcessSpawner, opts: CliSessionOptions) {
    this.id = id;
    this.spawner = spawner;
    this.opts = opts;
    this.stderrCapture = new StderrCapture(opts.stderrMaxLines);
    if (opts.allowedDirs?.length) {
      this.dirPolicy = new AllowedDirPolicy(opts.allowedDirs);
    }
  }

  getStatus(): SessionStatus {
    return this.status;
  }
  getPid(): number | undefined {
    return this.proc?.pid;
  }
  getExitCode(): number | null {
    return this.exitCode;
  }

  start(): void {
    if (this.status !== "idle" && this.status !== "stopped") {
      throw new Error(`Cannot start session in status: ${this.status}`);
    }
    this.status = "starting";

    let env = this.opts.env ?? {};
    if (this.opts.authInjector) env = this.opts.authInjector.inject(env);

    this.proc = this.spawner.spawn({
      command: this.opts.command,
      args: this.opts.args,
      cwd: this.opts.cwd,
      env,
      allowedDirs: this.opts.allowedDirs,
    });

    this.proc.onStdout((line) => {
      this.stdoutLines.push(line);
      this.outputListeners.forEach((cb) => cb(line));
    });
    this.proc.onStderr((line) => this.stderrCapture.push(line));
    this.proc.onExit((code) => {
      this.exitCode = code;
      this.status = code === 0 || code === null ? "stopped" : "crashed";
    });

    this.status = "running";
  }

  stop(signal = "SIGTERM"): void {
    if (this.status !== "running") return;
    this.status = "stopping";
    this.proc?.kill(signal);
  }

  write(input: string): void {
    if (this.status !== "running") throw new Error("Session is not running");
    this.proc?.write(input);
  }

  onOutput(cb: (line: string) => void): () => void {
    this.outputListeners.push(cb);
    return () => {
      const idx = this.outputListeners.indexOf(cb);
      if (idx >= 0) this.outputListeners.splice(idx, 1);
    };
  }

  getOutput(): SessionOutput {
    return { stdout: [...this.stdoutLines], stderr: this.stderrCapture.all() };
  }

  isAllowedDir(path: string): boolean {
    return this.dirPolicy?.isAllowed(path) ?? true;
  }

  recentStderr(n = 20): string[] {
    return this.stderrCapture.recent(n);
  }
}

// ── SessionManager ────────────────────────────────────────────────────────────

let _sessionSeq = 0;

/** Session manager. */
export class SessionManager {
  private sessions = new Map<string, CliSession>();
  private spawner: ProcessSpawner;

  constructor(spawner: ProcessSpawner) {
    this.spawner = spawner;
  }

  create(opts: CliSessionOptions, id?: string): CliSession {
    const sessionId = id ?? `cli-${++_sessionSeq}`;
    if (this.sessions.has(sessionId)) throw new Error(`Session already exists: ${sessionId}`);
    const session = new CliSession(sessionId, this.spawner, opts);
    this.sessions.set(sessionId, session);
    return session;
  }

  get(id: string): CliSession | undefined {
    return this.sessions.get(id);
  }

  list(): CliSession[] {
    return [...this.sessions.values()];
  }

  remove(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.getStatus() === "running") session.stop();
    return this.sessions.delete(id);
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      if (session.getStatus() === "running") session.stop();
    }
  }

  count(): number {
    return this.sessions.size;
  }
}
