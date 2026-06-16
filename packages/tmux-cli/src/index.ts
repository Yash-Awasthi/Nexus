// SPDX-License-Identifier: Apache-2.0

// ── Exec abstraction ──────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Exec fn type alias. */
export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

// ── Options ───────────────────────────────────────────────────────────────────

export interface NewSessionOpts {
  /** Spawn detached (default: true) */
  detached?: boolean;
  startDir?: string;
  windowName?: string;
}

/** New window opts interface definition. */
export interface NewWindowOpts {
  name?: string;
  startDir?: string;
  detach?: boolean;
}

/** Split pane opts interface definition. */
export interface SplitPaneOpts {
  /** Horizontal split — adds pane to the right (default: false = vertical) */
  horizontal?: boolean;
  percent?: number;
  startDir?: string;
}

/** Capture pane opts interface definition. */
export interface CapturePaneOpts {
  startLine?: number;
  endLine?: number;
  /** Join wrapped lines */
  joinLines?: boolean;
}

/** Wait opts interface definition. */
export interface WaitOpts {
  /** Poll interval in ms (default: 200) */
  intervalMs?: number;
  /** Total timeout in ms (default: 10 000) */
  timeoutMs?: number;
}

// ── Info types ────────────────────────────────────────────────────────────────

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  created: string;
}

/** Tmux pane info interface definition. */
export interface TmuxPaneInfo {
  index: number;
  active: boolean;
  width: number;
  height: number;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class TmuxError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "TmuxError";
    this.code = code;
  }
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface ITmuxClient {
  newSession(name: string, opts?: NewSessionOpts): Promise<void>;
  killSession(name: string): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  listSessions(): Promise<TmuxSessionInfo[]>;

  newWindow(session: string, opts?: NewWindowOpts): Promise<void>;
  selectWindow(target: string): Promise<void>;
  listPanes(target: string): Promise<TmuxPaneInfo[]>;

  splitPane(target: string, opts?: SplitPaneOpts): Promise<void>;

  sendKeys(target: string, keys: string, enter?: boolean): Promise<void>;
  capturePane(target: string, opts?: CapturePaneOpts): Promise<string>;

  runCommand(target: string, cmd: string): Promise<void>;
  waitForOutput(target: string, pattern: RegExp | string, opts?: WaitOpts): Promise<string>;
}

// ── TmuxClient ────────────────────────────────────────────────────────────────

export class TmuxClient implements ITmuxClient {
  constructor(private readonly exec: ExecFn) {}

  private async run(args: string[]): Promise<string> {
    const r = await this.exec("tmux", args);
    if (r.exitCode !== 0) {
      throw new TmuxError(
        r.stderr.trim() || `tmux ${args[0]} failed (exit ${r.exitCode})`,
        "TMUX_CMD_FAILED",
      );
    }
    return r.stdout;
  }

  async newSession(name: string, opts: NewSessionOpts = {}): Promise<void> {
    const args = ["new-session"];
    if (opts.detached ?? true) args.push("-d");
    args.push("-s", name);
    if (opts.windowName) args.push("-n", opts.windowName);
    if (opts.startDir) args.push("-c", opts.startDir);
    await this.run(args);
  }

  async killSession(name: string): Promise<void> {
    await this.run(["kill-session", "-t", name]);
  }

  async hasSession(name: string): Promise<boolean> {
    const r = await this.exec("tmux", ["has-session", "-t", name]);
    return r.exitCode === 0;
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    const fmt = "#{session_name}:#{session_windows}:#{session_attached}:#{session_created}";
    let out: string;
    try {
      out = await this.run(["list-sessions", "-F", fmt]);
    } catch {
      // no sessions — tmux exits non-zero when there are none
      return [];
    }
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, windows, attached, created] = line.split(":");
        return {
          name: name ?? "",
          windows: parseInt(windows ?? "0", 10),
          attached: attached === "1",
          created: created ?? "",
        };
      });
  }

  async newWindow(session: string, opts: NewWindowOpts = {}): Promise<void> {
    const args = ["new-window", "-t", session];
    if (opts.detach) args.push("-d");
    if (opts.name) args.push("-n", opts.name);
    if (opts.startDir) args.push("-c", opts.startDir);
    await this.run(args);
  }

  async selectWindow(target: string): Promise<void> {
    await this.run(["select-window", "-t", target]);
  }

  async listPanes(target: string): Promise<TmuxPaneInfo[]> {
    const fmt = "#{pane_index}:#{pane_active}:#{pane_width}:#{pane_height}";
    const out = await this.run(["list-panes", "-t", target, "-F", fmt]);
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [index, active, width, height] = line.split(":");
        return {
          index: parseInt(index ?? "0", 10),
          active: active === "1",
          width: parseInt(width ?? "0", 10),
          height: parseInt(height ?? "0", 10),
        };
      });
  }

  async splitPane(target: string, opts: SplitPaneOpts = {}): Promise<void> {
    const args = ["split-window", "-t", target];
    args.push(opts.horizontal ? "-h" : "-v");
    if (opts.percent !== undefined) args.push("-p", String(opts.percent));
    if (opts.startDir) args.push("-c", opts.startDir);
    await this.run(args);
  }

  async sendKeys(target: string, keys: string, enter = false): Promise<void> {
    const args = ["send-keys", "-t", target, keys];
    if (enter) args.push("Enter");
    await this.run(args);
  }

  async capturePane(target: string, opts: CapturePaneOpts = {}): Promise<string> {
    const args = ["capture-pane", "-t", target, "-p"];
    if (opts.joinLines) args.push("-J");
    if (opts.startLine !== undefined) args.push("-S", String(opts.startLine));
    if (opts.endLine !== undefined) args.push("-E", String(opts.endLine));
    return this.run(args);
  }

  async runCommand(target: string, cmd: string): Promise<void> {
    await this.sendKeys(target, cmd, true);
  }

  async waitForOutput(
    target: string,
    pattern: RegExp | string,
    opts: WaitOpts = {},
  ): Promise<string> {
    const intervalMs = opts.intervalMs ?? 200;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const out = await this.capturePane(target);
      if (re.test(out)) return out;
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new TmuxError(
      `Timed out after ${timeoutMs}ms waiting for ${re} in pane ${target}`,
      "WAIT_TIMEOUT",
    );
  }
}

// ── NullTmuxClient ────────────────────────────────────────────────────────────

interface _NullSession {
  name: string;
  windows: number;
  attached: boolean;
  created: string;
}

/** Null tmux client. */
export class NullTmuxClient implements ITmuxClient {
  private readonly _sessions = new Map<string, _NullSession>();
  private readonly _paneOutput = new Map<string, string>();
  private readonly _sentKeys: { target: string; keys: string }[] = [];

  /** Pre-seed pane output returned by capturePane / waitForOutput. */
  setPaneOutput(sessionOrTarget: string, output: string): void {
    this._paneOutput.set(sessionOrTarget.split(":")[0]!, output);
  }

  getSentKeys(): readonly { target: string; keys: string }[] {
    return this._sentKeys;
  }

  clearSentKeys(): void {
    this._sentKeys.length = 0;
  }

  // ── Session management ──────────────────────────────────────────────────────

  async newSession(name: string, _opts?: NewSessionOpts): Promise<void> {
    if (this._sessions.has(name)) {
      throw new TmuxError(`session '${name}' already exists`, "SESSION_EXISTS");
    }
    this._sessions.set(name, {
      name,
      windows: 1,
      attached: false,
      created: new Date().toISOString(),
    });
  }

  async killSession(name: string): Promise<void> {
    if (!this._sessions.has(name)) {
      throw new TmuxError(`no session: ${name}`, "NO_SESSION");
    }
    this._sessions.delete(name);
  }

  async hasSession(name: string): Promise<boolean> {
    return this._sessions.has(name);
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    return Array.from(this._sessions.values()).map((s) => ({
      name: s.name,
      windows: s.windows,
      attached: s.attached,
      created: s.created,
    }));
  }

  // ── Window / pane management ────────────────────────────────────────────────

  async newWindow(session: string, _opts?: NewWindowOpts): Promise<void> {
    const s = this._sessions.get(session);
    if (!s) throw new TmuxError(`no session: ${session}`, "NO_SESSION");
    s.windows++;
  }

  async selectWindow(_target: string): Promise<void> {}

  async listPanes(_target: string): Promise<TmuxPaneInfo[]> {
    return [{ index: 0, active: true, width: 220, height: 50 }];
  }

  async splitPane(_target: string, _opts?: SplitPaneOpts): Promise<void> {}

  // ── I/O ────────────────────────────────────────────────────────────────────

  async sendKeys(target: string, keys: string, enter = false): Promise<void> {
    this._sentKeys.push({ target, keys: enter ? keys + "\n" : keys });
  }

  async capturePane(target: string, _opts?: CapturePaneOpts): Promise<string> {
    const key = target.split(":")[0]!;
    return this._paneOutput.get(key) ?? "";
  }

  async runCommand(target: string, cmd: string): Promise<void> {
    await this.sendKeys(target, cmd, true);
  }

  async waitForOutput(
    target: string,
    pattern: RegExp | string,
    opts: WaitOpts = {},
  ): Promise<string> {
    const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const out = await this.capturePane(target);
      if (re.test(out)) return out;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new TmuxError(
      `Timed out after ${timeoutMs}ms waiting for ${re} in pane ${target}`,
      "WAIT_TIMEOUT",
    );
  }
}
