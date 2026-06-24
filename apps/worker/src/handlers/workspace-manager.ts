// SPDX-License-Identifier: Apache-2.0
/**
 * workspace-manager — Phase 3 worktree-backed agent workspaces (Conductor model).
 *
 * Each agent gets an isolated git worktree (one branch ⇄ one worktree) cut from
 * `origin/<base>` after a fetch, plus a reserved 10-port range and a small env
 * block (`NEXUS_ROOT_PATH` / `NEXUS_WORKSPACE_PATH` / `NEXUS_WORKSPACE_NAME` /
 * `NEXUS_PORT`). Workspaces are archived-not-deleted: the working dir is removed
 * but the branch (and its commits) survive, so a run can be restored later.
 *
 * The unit of delegation is the workspace (= worktree); the unit of integration
 * is the branch/PR — decomposition drives parallelism, there is no scheduler.
 *
 * Mirrors `.conductor/settings.toml`: `.nexus/settings.toml` carries
 * `[scripts] setup/run/archive` + `run_mode = concurrent|nonconcurrent`.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Per-workspace settings parsed from `.nexus/settings.toml`. */
export interface NexusSettings {
  scripts: { setup?: string; run?: string; archive?: string };
  /** concurrent: each workspace gets its own ports/DB; nonconcurrent: share one. */
  runMode: "concurrent" | "nonconcurrent";
}

/** A provisioned workspace. */
export interface Workspace {
  name: string;
  /** Absolute path to the worktree (where the agent's tools are confined). */
  path: string;
  /** The one branch bound to this worktree. */
  branch: string;
  baseBranch: string;
  /** The main checkout this worktree was cut from. */
  rootPath: string;
  /** Reserved contiguous port range [base, base+9]. */
  ports: number[];
  /** Env block injected into scripts / run_command. */
  env: Record<string, string>;
  archived: boolean;
}

/** Persisted record (subset of Workspace) for archive/restore. */
interface WorkspaceRecord {
  name: string;
  path: string;
  branch: string;
  baseBranch: string;
  ports: number[];
  archived: boolean;
}

export interface WorkspaceManagerOptions {
  /** Main git checkout to cut worktrees from. */
  repoPath: string;
  /** Where worktrees live (default ~/.nexus/workspaces/<repo>). */
  workspacesRoot?: string;
  /** First port to probe when reserving a range (default 3100 / NEXUS_PORT_BASE). */
  portBase?: number;
  /** Branch prefix for created worktrees (default "nexus/"). */
  branchPrefix?: string;
}

const PORT_RANGE = 10;
const STOP_GRACE_MS = 200;
/** Default cap for a one-shot `.nexus` script (setup/archive). */
export const SCRIPT_TIMEOUT_MS = 5 * 60_000;

/** Run git in a working dir, returning trimmed stdout; throws on nonzero exit. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/** True if the repo has an `origin` remote (so we can fetch). */
async function hasOrigin(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ["remote", "get-url", "origin"]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve to the git repo root (so worktree bookkeeping is consistent). */
async function repoRoot(repoPath: string): Promise<string> {
  return git(repoPath, ["rev-parse", "--show-toplevel"]);
}

/** True if `port` can be bound on localhost right now. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Find a contiguous block of `count` free ports starting at/after `base`.
 * Ranges overlapping `reserved` (ports already assigned to other active
 * workspaces) are skipped before the OS bind probe, so two workspaces never
 * receive the same range. A residual OS-level race (an external process binding
 * a port between probe and use) is unavoidable without holding the sockets; the
 * run script simply fails to bind in that case, which is observable.
 */
async function reservePortRange(
  base: number,
  reserved: ReadonlySet<number> = new Set(),
  count = PORT_RANGE,
): Promise<number[]> {
  for (let start = base; start < base + 1000; start += count) {
    const range = Array.from({ length: count }, (_, i) => start + i);
    if (range.some((p) => reserved.has(p))) continue;
    const checks = await Promise.all(range.map(isPortFree));
    if (checks.every(Boolean)) return range;
  }
  throw new Error(`no free ${count}-port range found from ${base}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/**
 * Acquire a cross-process lock by atomically creating `lockDir` (mkdir is atomic
 * on a local filesystem). Reclaims a lock whose holder is older than `staleMs`
 * (presumed dead), and gives up after `timeoutMs`.
 */
async function acquireLock(
  lockDir: string,
  { staleMs = 120_000, retryMs = 50, timeoutMs = 60_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      return;
    } catch {
      try {
        const st = await fs.stat(lockDir);
        if (Date.now() - st.mtimeMs > staleMs) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock vanished between mkdir and stat — retry immediately
      }
      if (Date.now() > deadline) throw new Error(`workspace index lock timeout: ${lockDir}`);
      await sleep(retryMs);
    }
  }
}

/**
 * Parse the known subset of `.nexus/settings.toml`. Deliberately tiny — handles
 * `# comments`, `[section]` headers, and `key = "value"` / `'value'` / bareword.
 * Only the `[scripts]` table and a top-level `run_mode` key are recognised.
 */
export function parseNexusSettings(toml: string): NexusSettings {
  const settings: NexusSettings = { scripts: {}, runMode: "concurrent" };
  let section = "";
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim().replace(/^["']|["']$/g, "");
    if (section === "scripts" && (key === "setup" || key === "run" || key === "archive")) {
      settings.scripts[key] = value;
    } else if (section === "" && key === "run_mode") {
      settings.runMode = value === "nonconcurrent" ? "nonconcurrent" : "concurrent";
    }
  }
  return settings;
}

/** Load `.nexus/settings.toml` from a workspace; defaults if absent. */
export async function loadNexusSettings(workspacePath: string): Promise<NexusSettings> {
  try {
    const toml = await fs.readFile(path.join(workspacePath, ".nexus", "settings.toml"), "utf8");
    return parseNexusSettings(toml);
  } catch {
    return { scripts: {}, runMode: "concurrent" };
  }
}

/**
 * Stop a child process gracefully: SIGHUP, then SIGKILL after a 200ms grace
 * window (Conductor's stop semantics). Resolves once the process has exited.
 */
export function stopProcess(child: ChildProcess, graceMs = STOP_GRACE_MS): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    const timer = setTimeout(() => {
      if (!done) child.kill("SIGKILL");
    }, graceMs);
    timer.unref();
    child.kill("SIGHUP");
  });
}

/**
 * Spawn a one-shot shell command in `cwd` with `env` merged over the worker's
 * own, and wait for it to exit — or stop it (SIGHUP→SIGKILL) once `timeoutMs`
 * elapses. Used for `.nexus` setup/archive scripts.
 */
export async function runScriptBounded(opts: {
  cwd: string;
  env: Record<string, string>;
  command: string;
  timeoutMs?: number;
  onExit?: (code: number | null) => void;
}): Promise<void> {
  const child = spawn("/bin/sh", ["-c", opts.command], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      () => void stopProcess(child).then(done),
      opts.timeoutMs ?? SCRIPT_TIMEOUT_MS,
    );
    timer.unref();
    child.once("exit", (code) => {
      opts.onExit?.(code);
      done();
    });
  });
}

export class WorkspaceManager {
  private readonly repoPath: string;
  private readonly workspacesRoot: string;
  private readonly portBase: number;
  private readonly branchPrefix: string;
  private readonly indexPath: string;
  private readonly lockPath: string;

  constructor(opts: WorkspaceManagerOptions) {
    this.repoPath = path.resolve(opts.repoPath);
    const repoName = path.basename(this.repoPath);
    this.workspacesRoot =
      opts.workspacesRoot ?? path.join(os.homedir(), ".nexus", "workspaces", repoName);
    this.portBase = opts.portBase ?? Number(process.env.NEXUS_PORT_BASE ?? 3100);
    this.branchPrefix = opts.branchPrefix ?? "nexus/";
    this.indexPath = path.join(this.workspacesRoot, "workspaces.json");
    this.lockPath = path.join(this.workspacesRoot, "workspaces.lock");
  }

  /**
   * Run `fn` while holding the index lock, so the read-modify-write of the
   * index (and the port reservation that depends on it) is atomic across
   * concurrent jobs — even across worker processes sharing the same root.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.workspacesRoot, { recursive: true });
    await acquireLock(this.lockPath);
    try {
      return await fn();
    } finally {
      await fs.rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Read the workspace index ({} if none yet). */
  private async readIndex(): Promise<Record<string, WorkspaceRecord>> {
    try {
      return JSON.parse(await fs.readFile(this.indexPath, "utf8")) as Record<
        string,
        WorkspaceRecord
      >;
    } catch {
      return {};
    }
  }

  private async writeIndex(index: Record<string, WorkspaceRecord>): Promise<void> {
    await fs.mkdir(this.workspacesRoot, { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf8");
  }

  private toWorkspace(rec: WorkspaceRecord): Workspace {
    return {
      name: rec.name,
      path: rec.path,
      branch: rec.branch,
      baseBranch: rec.baseBranch,
      rootPath: this.repoPath,
      ports: rec.ports,
      archived: rec.archived,
      env: this.envFor(rec.name, rec.path, rec.ports),
    };
  }

  /** Ports already committed to active (non-archived) workspaces. */
  private usedPorts(index: Record<string, WorkspaceRecord>): Set<number> {
    const used = new Set<number>();
    for (const rec of Object.values(index)) {
      if (!rec.archived) for (const p of rec.ports) used.add(p);
    }
    return used;
  }

  private envFor(name: string, wsPath: string, ports: number[]): Record<string, string> {
    return {
      NEXUS_ROOT_PATH: this.repoPath,
      NEXUS_WORKSPACE_PATH: wsPath,
      NEXUS_WORKSPACE_NAME: name,
      NEXUS_PORT: String(ports[0]),
    };
  }

  /**
   * Provision a worktree workspace. Fetches `origin/<base>` (when an origin
   * exists), then cuts a fresh branch+worktree from it. One branch ⇄ one
   * worktree; the name must be unique among active workspaces.
   */
  async create(opts: { name: string; baseBranch: string; branch?: string }): Promise<Workspace> {
    const { name, baseBranch } = opts;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`invalid workspace name: ${name}`);
    }
    return this.withLock(async () => {
      const index = await this.readIndex();
      if (index[name] && !index[name].archived) {
        throw new Error(`workspace already active: ${name}`);
      }

      const root = await repoRoot(this.repoPath);
      const branch = opts.branch ?? `${this.branchPrefix}${name}`;
      const wsPath = path.join(this.workspacesRoot, name);

      // Fetch the base so the worktree starts from the remote tip when possible.
      const remote = await hasOrigin(root);
      if (remote) {
        await git(root, ["fetch", "origin", baseBranch]);
      }
      const startPoint = remote ? `origin/${baseBranch}` : baseBranch;

      await git(root, ["worktree", "add", "-b", branch, wsPath, startPoint]);

      const ports = await reservePortRange(this.portBase, this.usedPorts(index));
      const rec: WorkspaceRecord = {
        name,
        path: wsPath,
        branch,
        baseBranch,
        ports,
        archived: false,
      };
      index[name] = rec;
      await this.writeIndex(index);
      return this.toWorkspace(rec);
    });
  }

  /** List known workspaces (active + archived). */
  async list(): Promise<Workspace[]> {
    const index = await this.readIndex();
    return Object.values(index).map((r) => this.toWorkspace(r));
  }

  /** Get one workspace by name, or null. */
  async get(name: string): Promise<Workspace | null> {
    const index = await this.readIndex();
    return index[name] ? this.toWorkspace(index[name]) : null;
  }

  /**
   * Archive (not delete): remove the worktree dir but keep the branch and its
   * commits. The run is restorable later; transcripts live in agent_sessions.
   */
  async archive(name: string): Promise<void> {
    const ws = await this.get(name);
    if (!ws) throw new Error(`unknown workspace: ${name}`);
    if (ws.archived) return;
    // Run the workspace's archive script first (outside the index lock — it
    // touches only the workspace dir), so it can release the run's resources.
    const settings = await loadNexusSettings(ws.path);
    if (settings.scripts.archive) {
      await runScriptBounded({ cwd: ws.path, env: ws.env, command: settings.scripts.archive });
    }
    await this.withLock(async () => {
      const index = await this.readIndex();
      const rec = index[name];
      if (!rec || rec.archived) return;
      const root = await repoRoot(this.repoPath);
      // --force: drop the worktree even with uncommitted/untracked files; the
      // branch ref (and any commits) survive independently of the worktree.
      await git(root, ["worktree", "remove", "--force", rec.path]).catch(() => {});
      await fs.rm(rec.path, { recursive: true, force: true }).catch(() => {});
      rec.archived = true;
      await this.writeIndex(index);
    });
  }

  /** Restore an archived workspace: re-attach a worktree to its kept branch. */
  async restore(name: string): Promise<Workspace> {
    return this.withLock(async () => {
      const index = await this.readIndex();
      const rec = index[name];
      if (!rec) throw new Error(`unknown workspace: ${name}`);
      if (!rec.archived) return this.toWorkspace(rec);
      const root = await repoRoot(this.repoPath);
      // Clear any stale registration for this path, then re-add a worktree
      // pointing at the existing branch (no -b — the branch already exists).
      await git(root, ["worktree", "prune"]).catch(() => {});
      await git(root, ["worktree", "add", rec.path, rec.branch]);
      rec.ports = await reservePortRange(this.portBase, this.usedPorts(index));
      rec.archived = false;
      await this.writeIndex(index);
      return this.toWorkspace(rec);
    });
  }

  /**
   * Run a `.nexus/settings.toml` script (setup/run/archive) in the workspace
   * with the per-workspace env merged in. Returns the spawned child so callers
   * can stream/stop it (use `stopProcess` for SIGHUP→SIGKILL teardown).
   */
  spawnScript(ws: Workspace, command: string): ChildProcess {
    return spawn("/bin/sh", ["-c", command], {
      cwd: ws.path,
      env: { ...process.env, ...ws.env },
    });
  }
}

/** A live `[scripts].run` process. `key` is what you pass to `stop`. */
export interface RunHandle {
  key: string;
  name: string;
  child: ChildProcess;
  port: number;
  url: string;
}

const SHARED_RUN_KEY = "__shared__";

interface RunEntry {
  handle: RunHandle;
  refs: number;
}

/**
 * Supervises long-lived `[scripts].run` processes. In `concurrent` mode each
 * workspace runs its own server (keyed by name); in `nonconcurrent` mode a
 * single shared server is reused across workspaces (ref-counted, so it is only
 * stopped once the last user releases it). Teardown is SIGHUP→200ms→SIGKILL.
 */
export class WorkspaceRunner {
  private readonly active = new Map<string, RunEntry>();

  /** Start (or, in nonconcurrent mode / if already up, reuse) the run server. */
  start(ws: Workspace, settings: NexusSettings): RunHandle | null {
    const cmd = settings.scripts.run;
    if (!cmd) return null;
    const key = settings.runMode === "nonconcurrent" ? SHARED_RUN_KEY : ws.name;
    const existing = this.active.get(key);
    if (existing) {
      existing.refs++;
      return existing.handle;
    }
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: ws.path,
      env: { ...process.env, ...ws.env },
    });
    const port = ws.ports[0] ?? 0;
    const handle: RunHandle = { key, name: ws.name, child, port, url: `http://127.0.0.1:${port}` };
    const entry: RunEntry = { handle, refs: 1 };
    this.active.set(key, entry);
    child.once("exit", () => {
      if (this.active.get(key) === entry) this.active.delete(key);
    });
    return handle;
  }

  /** Release one reference; stops the process when the last user releases it. */
  async stop(key: string): Promise<void> {
    const entry = this.active.get(key);
    if (!entry) return;
    if (--entry.refs > 0) return;
    this.active.delete(key);
    await stopProcess(entry.handle.child);
  }

  list(): RunHandle[] {
    return [...this.active.values()].map((e) => e.handle);
  }

  /** Stop every run process (e.g. on worker shutdown). */
  async stopAll(): Promise<void> {
    const entries = [...this.active.values()];
    this.active.clear();
    await Promise.all(entries.map((e) => stopProcess(e.handle.child)));
  }
}

/** Merge-gating signals for a workspace branch ("checks", Conductor model). */
export interface WorkspaceChecks {
  /** Working tree has uncommitted/untracked changes. */
  uncommittedChanges: boolean;
  /** Commits on this branch not yet on the base. */
  commitsAhead: number;
  /** Soft gate: clean tree with something to merge. */
  mergeReady: boolean;
}

/**
 * Aggregate merge-gating "checks" for a workspace: is the tree clean, and does
 * the branch have commits ahead of its base? `mergeReady` is a soft gate — a
 * caller can surface it without blocking. (CI/PR status + review-comment
 * round-trip are follow-ups that layer onto this.)
 */
export async function collectChecks(ws: Workspace): Promise<WorkspaceChecks> {
  const status = await git(ws.path, ["status", "--porcelain"]).catch(() => "");
  const uncommittedChanges = status.length > 0;
  let commitsAhead = 0;
  try {
    const base = (await hasOrigin(ws.path)) ? `origin/${ws.baseBranch}` : ws.baseBranch;
    commitsAhead = Number(await git(ws.path, ["rev-list", "--count", `${base}..HEAD`])) || 0;
  } catch {
    // base ref not resolvable — leave commitsAhead at 0
  }
  return { uncommittedChanges, commitsAhead, mergeReady: !uncommittedChanges && commitsAhead > 0 };
}
