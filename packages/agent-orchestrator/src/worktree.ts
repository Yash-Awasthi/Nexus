// SPDX-License-Identifier: Apache-2.0
/**
 * Git-worktree manager — isolates each parallel agent run on its own branch +
 * working tree so concurrent agents never collide. Thin wrapper over `git
 * worktree`; no external deps. The orchestrator depends on the WorktreeManager
 * interface, not this class, so unit tests inject a fake and skip real git.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Worktree {
  /** Absolute path to the isolated working tree. */
  path: string;
  /** Branch checked out in that worktree. */
  branch: string;
}

export interface WorktreeManager {
  /** Create an isolated worktree on a fresh branch off `baseRef`. */
  create(runId: string, baseRef: string): Promise<Worktree>;
  /** Unified diff of the worktree against `baseRef` (what the agent changed). */
  diff(wt: Worktree, baseRef: string): Promise<string>;
  /** Fast-forward/merge the worktree's branch into `baseRef` in the main repo. */
  merge(wt: Worktree, baseRef: string): Promise<void>;
  /** Tear down the worktree and delete its branch. Best-effort; never throws. */
  remove(wt: Worktree): Promise<void>;
}

/** Default implementation backed by the `git` CLI. */
export class GitWorktreeManager implements WorktreeManager {
  /** @param repoDir absolute path to the main repository (the merge target). */
  constructor(private readonly repoDir: string) {}

  private git(args: string[], cwd = this.repoDir): Promise<{ stdout: string }> {
    // execFile (not exec) — args are passed as an array, so no shell, no
    // injection surface even though runId/branch flow in from callers.
    return run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  }

  async create(runId: string, baseRef: string): Promise<Worktree> {
    const branch = `orchestrator/${runId}`;
    const path = await mkdtemp(join(tmpdir(), `nexus-wt-${runId}-`));
    // -B resets the branch if a stale one exists from a crashed prior run.
    await this.git(["worktree", "add", "-B", branch, path, baseRef]);
    return { path, branch };
  }

  async diff(wt: Worktree, baseRef: string): Promise<string> {
    // Stage everything first so new/untracked files show up in the diff.
    await this.git(["add", "-A"], wt.path);
    const { stdout } = await this.git(["diff", "--cached", baseRef], wt.path);
    return stdout;
  }

  async merge(wt: Worktree, baseRef: string): Promise<void> {
    // Commit the agent's staged work on its branch, then merge into baseRef.
    await this.git(["commit", "--no-verify", "-m", `orchestrator: ${wt.branch}`], wt.path).catch(
      () => {
        /* nothing staged → no commit; merge becomes a no-op */
      },
    );
    await this.git(["checkout", baseRef]);
    await this.git(["merge", "--no-edit", wt.branch]);
  }

  async remove(wt: Worktree): Promise<void> {
    await this.git(["worktree", "remove", "--force", wt.path]).catch(() => {});
    await this.git(["branch", "-D", wt.branch]).catch(() => {});
    await rm(wt.path, { recursive: true, force: true }).catch(() => {});
  }
}
