// SPDX-License-Identifier: Apache-2.0
/**
 * code-repl — Persistent REPL kernel with Jupyter-style last-expression output.
 *
 * Provides:
 *   • ReplResult          — { stdout, stderr, displayData, lastExpression }
 *   • KernelSession       — stateful session with variable store + history
 *   • JupyterMode         — wraps code to auto-print last expression
 *   • ReplExecutor        — injectable code execution interface
 *   • MockReplExecutor    — in-memory executor for tests
 *   • DockerReplExecutor  — real sandboxed execution via docker run (needs Docker)
 *   • SessionReaper       — TTL-based idle session cleanup
 *   • ReplKernel          — per-language kernel facade
 *   • KernelManager       — named kernel registry with create/get/reap
 *   • isDockerAvailable   — probe whether the docker binary is reachable
 */

import { spawn } from "node:child_process";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReplLanguage = "python" | "r" | "julia";

/** Repl input interface definition. */
export interface ReplInput {
  code: string;
  timeoutMs?: number;
}

/** Repl result interface definition. */
export interface ReplResult {
  stdout: string;
  stderr: string;
  displayData?: unknown;  // rich output (images, HTML, etc.)
  lastExpression?: string; // auto-print of last expression in Jupyter mode
  exitCode: number;
  durationMs: number;
}

/** Variable store interface definition. */
export interface VariableStore {
  [name: string]: unknown;
}

/** Kernel session state interface definition. */
export interface KernelSessionState {
  id: string;
  language: ReplLanguage;
  variables: VariableStore;
  history: string[];      // executed code snippets
  createdAt: string;
  lastUsedAt: string;
  executionCount: number;
}

// ── JupyterMode ───────────────────────────────────────────────────────────────

export class JupyterMode {
  /**
   * Wrap code so the last expression is automatically displayed.
   * Only applies when the last non-empty line is an expression (not assignment,
   * def, class, import, return, print, etc.).
   */
  static wrapPython(code: string): string {
    const lines = code.split("\n").map((l) => l.trimEnd());
    const lastLine = [...lines].reverse().find((l) => l.trim() !== "");
    if (!lastLine) return code;

    const stripped = lastLine.trim();
    // Don't wrap control structures, assignments, or statements
    const isStatement = /^(def |class |import |from |return |yield |raise |del |pass\b|break\b|continue\b|async |print\(|#)/.test(stripped)
      || (/^[a-zA-Z_][a-zA-Z0-9_]*\s*=/.test(stripped) && !stripped.includes("=="))
      || lastLine !== lastLine.trimStart(); // indented → inside a block

    if (isStatement) return code;

    // Replace last expression line with print wrapper
    const idx = [...lines].map((l, i) => ({ l, i }))
      .reverse()
      .find(({ l }) => l.trim() !== "");
    if (!idx) return code;

    const newLines = [...lines];
    newLines[idx.i] = `__repl_last__ = ${stripped}\nif __repl_last__ is not None: print(repr(__repl_last__))`;
    return newLines.join("\n");
  }

  static wrapR(code: string): string {
    const lines = code.split("\n").map((l) => l.trimEnd());
    const lastLine = [...lines].reverse().find((l) => l.trim() !== "");
    if (!lastLine) return code;
    const stripped = lastLine.trim();
    const isAssignment = /(<-|=)/.test(stripped) && !/==/g.test(stripped);
    if (isAssignment) return code;
    const idx = [...lines].map((l, i) => ({ l, i })).reverse().find(({ l }) => l.trim() !== "");
    if (!idx) return code;
    const newLines = [...lines];
    newLines[idx.i] = `print(${stripped})`;
    return newLines.join("\n");
  }

  static wrapJulia(code: string): string {
    const lines = code.split("\n").map((l) => l.trimEnd());
    const lastLine = [...lines].reverse().find((l) => l.trim() !== "");
    if (!lastLine) return code;
    const stripped = lastLine.trim();
    const isAssignment = /=/.test(stripped) && !/==/g.test(stripped) && !/^#/.test(stripped);
    if (isAssignment) return code;
    const idx = [...lines].map((l, i) => ({ l, i })).reverse().find(({ l }) => l.trim() !== "");
    if (!idx) return code;
    const newLines = [...lines];
    newLines[idx.i] = `println(${stripped})`;
    return newLines.join("\n");
  }

  static wrap(code: string, language: ReplLanguage): string {
    switch (language) {
      case "python": return JupyterMode.wrapPython(code);
      case "r": return JupyterMode.wrapR(code);
      case "julia": return JupyterMode.wrapJulia(code);
    }
  }
}

// ── ReplExecutor ──────────────────────────────────────────────────────────────

export interface ReplExecutor {
  execute(language: ReplLanguage, code: string, state: KernelSessionState, timeoutMs?: number): Promise<ReplResult>;
}

// ── MockReplExecutor ──────────────────────────────────────────────────────────

export interface MockExecutionBehavior {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  displayData?: unknown;
  lastExpression?: string;
  throws?: string;
  durationMs?: number;
  /** Callback to inspect/modify state before returning result */
  onExecute?: (code: string, state: KernelSessionState) => void;
}

/** Mock repl executor. */
export class MockReplExecutor implements ReplExecutor {
  private behaviors: MockExecutionBehavior[];
  private callIndex = 0;
  readonly executionLog: Array<{ language: ReplLanguage; code: string }> = [];

  constructor(behaviors: MockExecutionBehavior | MockExecutionBehavior[] = {}) {
    this.behaviors = Array.isArray(behaviors) ? behaviors : [behaviors];
  }

  async execute(language: ReplLanguage, code: string, state: KernelSessionState, _timeoutMs?: number): Promise<ReplResult> {
    this.executionLog.push({ language, code });
    const behavior = this.behaviors[Math.min(this.callIndex, this.behaviors.length - 1)]!;
    this.callIndex++;

    if (behavior.throws) throw new Error(behavior.throws);
    behavior.onExecute?.(code, state);

    return {
      stdout: behavior.stdout ?? "",
      stderr: behavior.stderr ?? "",
      displayData: behavior.displayData,
      lastExpression: behavior.lastExpression,
      exitCode: behavior.exitCode ?? 0,
      durationMs: behavior.durationMs ?? 10,
    };
  }
}

// ── DockerReplExecutor ─────────────────────────────────────────────────────────

const DOCKER_IMAGES: Record<ReplLanguage, { image: string; cmd: string[] }> = {
  python: { image: "python:3.12-slim",   cmd: ["python3", "-"] },
  r:      { image: "r-base:4.3",         cmd: ["Rscript", "-"] },
  julia:  { image: "julia:1.10-alpine",  cmd: ["julia", "--startup-file=no", "-"] },
};

const STDOUT_CAP = 65_536;  // 64 KB
const STDERR_CAP = 16_384;  // 16 KB

/**
 * Probes whether the `docker` binary is reachable and the daemon responds.
 * Used by the API route to decide whether to activate real execution.
 */
export async function isDockerAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn("docker", ["info"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/**
 * Real sandboxed code executor using `docker run`.
 *
 * Each execution spawns a fresh, isolated container with:
 *   --network=none   — no outbound/inbound network
 *   --memory         — default 512 MB RAM cap
 *   --cpus           — default 0.5 CPU core cap
 *   --pids-limit     — prevent fork bombs (128 processes)
 *   --no-new-privileges — prevent privilege escalation
 *   --rm             — auto-remove container on exit
 *
 * Code is passed via stdin; stdout/stderr are capped at 64 KB / 16 KB
 * respectively to prevent memory exhaustion from runaway output.
 * On timeout the container is SIGKILLed and exitCode 124 is returned.
 *
 * Requires Docker Desktop or Docker Engine on the host.
 * Falls back gracefully: throws if `docker` is not found so the API layer
 * can substitute MockReplExecutor.
 */
export class DockerReplExecutor implements ReplExecutor {
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;
  private readonly defaultTimeoutMs: number;
  private readonly networkMode: string;

  constructor(config?: {
    memoryLimit?: string;
    cpuLimit?: string;
    defaultTimeoutMs?: number;
    networkMode?: string;
  }) {
    this.memoryLimit       = config?.memoryLimit       ?? "512m";
    this.cpuLimit          = config?.cpuLimit          ?? "0.5";
    this.defaultTimeoutMs  = config?.defaultTimeoutMs  ?? 10_000;
    this.networkMode       = config?.networkMode       ?? "none";
  }

  async execute(
    language: ReplLanguage,
    code: string,
    _state: KernelSessionState,
    timeoutMs?: number,
  ): Promise<ReplResult> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const { image, cmd } = DOCKER_IMAGES[language];
    const t0 = Date.now();

    return new Promise<ReplResult>((resolve, reject) => {
      const dockerArgs = [
        "run", "--rm", "--interactive",
        `--network=${this.networkMode}`,
        `--memory=${this.memoryLimit}`,
        `--cpus=${this.cpuLimit}`,
        "--pids-limit=128",
        "--no-new-privileges",
        image,
        ...cmd,
      ];

      const proc = spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let outputCapped = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeout);

      // Feed code to the interpreter via stdin
      proc.stdin?.write(code, "utf-8");
      proc.stdin?.end();

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (outputCapped) return;
        stdout += chunk.toString("utf-8");
        if (stdout.length >= STDOUT_CAP) {
          stdout = stdout.slice(0, STDOUT_CAP);
          outputCapped = true;
          proc.kill("SIGKILL"); // don't let runaway output fill memory
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
        if (stderr.length > STDERR_CAP) stderr = stderr.slice(0, STDERR_CAP);
      });

      proc.on("close", (exitCode) => {
        clearTimeout(killTimer);
        const durationMs = Date.now() - t0;

        if (timedOut) {
          resolve({
            stdout,
            stderr: `Execution timed out after ${timeout}ms.\n${stderr}`.trim(),
            exitCode: 124,  // conventional timeout code (same as GNU timeout)
            durationMs,
          });
          return;
        }

        if (outputCapped) {
          resolve({
            stdout: stdout + "\n[output truncated at 64 KB]",
            stderr,
            exitCode: exitCode ?? 1,
            durationMs,
          });
          return;
        }

        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? 1,
          durationMs,
          lastExpression: exitCode === 0 && stdout.trim() ? stdout.trim() : undefined,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(killTimer);
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "ENOENT") {
          reject(new Error(
            "DockerReplExecutor: `docker` binary not found. " +
            "Install Docker Desktop or Docker Engine, then restart the API.",
          ));
        } else {
          reject(err);
        }
      });
    });
  }
}

// ── KernelSession ─────────────────────────────────────────────────────────────

let _sessionSeq = 0;

/** Kernel session. */
export class KernelSession {
  private state: KernelSessionState;
  private executor: ReplExecutor;
  private jupyterMode: boolean;

  constructor(language: ReplLanguage, executor: ReplExecutor, jupyterMode = true) {
    this.executor = executor;
    this.jupyterMode = jupyterMode;
    this.state = {
      id: `kernel-${++_sessionSeq}`,
      language,
      variables: {},
      history: [],
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      executionCount: 0,
    };
  }

  get id(): string { return this.state.id; }
  get language(): ReplLanguage { return this.state.language; }
  get executionCount(): number { return this.state.executionCount; }
  get state_(): KernelSessionState { return this.state; }

  /** Execute code in this session. */
  async execute(input: ReplInput): Promise<ReplResult> {
    const wrappedCode = this.jupyterMode
      ? JupyterMode.wrap(input.code, this.state.language)
      : input.code;

    this.state.history.push(input.code);
    this.state.executionCount++;
    this.state.lastUsedAt = new Date().toISOString();

    const result = await this.executor.execute(
      this.state.language,
      wrappedCode,
      this.state,
      input.timeoutMs,
    );

    return result;
  }

  /** Set a variable in the kernel state (test helper / real kernel sync). */
  setVariable(name: string, value: unknown): void {
    this.state.variables[name] = value;
  }

  getVariable(name: string): unknown {
    return this.state.variables[name];
  }

  getHistory(): string[] { return [...this.state.history]; }

  /** Returns idle time in ms. */
  idleTimeMs(): number {
    return Date.now() - new Date(this.state.lastUsedAt).getTime();
  }
}

// ── SessionReaper ─────────────────────────────────────────────────────────────

export class SessionReaper {
  private maxIdleMs: number;

  constructor(maxIdleMs = 30 * 60 * 1000) { // 30 min default
    this.maxIdleMs = maxIdleMs;
  }

  /** Returns session IDs that should be reaped. */
  identify(sessions: KernelSession[]): string[] {
    return sessions
      .filter((s) => s.idleTimeMs() > this.maxIdleMs)
      .map((s) => s.id);
  }

  /** Reap idle sessions from a registry map. Returns count reaped. */
  reap(registry: Map<string, KernelSession>): number {
    const toReap = this.identify([...registry.values()]);
    for (const id of toReap) registry.delete(id);
    return toReap.length;
  }
}

// ── KernelManager ─────────────────────────────────────────────────────────────

export interface KernelManagerOptions {
  executor: ReplExecutor;
  jupyterMode?: boolean;
  maxSessions?: number;
  reaper?: SessionReaper;
}

/** Kernel manager. */
export class KernelManager {
  private kernels = new Map<string, KernelSession>();
  private executor: ReplExecutor;
  private jupyterMode: boolean;
  private maxSessions: number;
  private reaper: SessionReaper;

  constructor(opts: KernelManagerOptions) {
    this.executor = opts.executor;
    this.jupyterMode = opts.jupyterMode ?? true;
    this.maxSessions = opts.maxSessions ?? 20;
    this.reaper = opts.reaper ?? new SessionReaper();
  }

  /** Create a new kernel session. Reaps idle sessions if at capacity. */
  create(language: ReplLanguage): KernelSession {
    if (this.kernels.size >= this.maxSessions) {
      const reaped = this.reaper.reap(this.kernels);
      if (reaped === 0 && this.kernels.size >= this.maxSessions) {
        throw new Error(`KernelManager at capacity (maxSessions=${this.maxSessions})`);
      }
    }
    const session = new KernelSession(language, this.executor, this.jupyterMode);
    this.kernels.set(session.id, session);
    return session;
  }

  get(id: string): KernelSession | undefined { return this.kernels.get(id); }
  has(id: string): boolean { return this.kernels.has(id); }
  destroy(id: string): boolean { return this.kernels.delete(id); }
  destroyAll(): void { this.kernels.clear(); }
  count(): number { return this.kernels.size; }
  list(): KernelSession[] { return [...this.kernels.values()]; }

  /** Run the reaper and return count removed. */
  reapIdle(): number { return this.reaper.reap(this.kernels); }
}
