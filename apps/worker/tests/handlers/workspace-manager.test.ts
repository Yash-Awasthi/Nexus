// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  WorkspaceManager,
  collectChecks,
  loadNexusSettings,
  parseNexusSettings,
} from "../../src/handlers/workspace-manager.js";

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]): Promise<{ stdout: string }> =>
  execFileAsync("git", args, { cwd });

let tmpRoot: string;
let originRepo: string;
let repoPath: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-ws-"));

  // Origin: a real working repo with one commit on `main`.
  originRepo = path.join(tmpRoot, "origin");
  await fs.mkdir(originRepo, { recursive: true });
  await git(originRepo, ["init", "-b", "main"]);
  await git(originRepo, ["config", "user.email", "t@t.dev"]);
  await git(originRepo, ["config", "user.name", "t"]);
  await fs.writeFile(path.join(originRepo, "README.md"), "seed\n");
  await git(originRepo, ["add", "."]);
  await git(originRepo, ["commit", "-m", "seed"]);

  // Main checkout the manager cuts worktrees from (has an `origin` remote).
  repoPath = path.join(tmpRoot, "checkout");
  await git(tmpRoot, ["clone", originRepo, repoPath]);
  await git(repoPath, ["config", "user.email", "t@t.dev"]);
  await git(repoPath, ["config", "user.name", "t"]);
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeManager(): WorkspaceManager {
  return new WorkspaceManager({
    repoPath,
    workspacesRoot: path.join(tmpRoot, "ws"),
    portBase: 39000,
  });
}

describe("parseNexusSettings", () => {
  it("parses scripts + run_mode, ignoring comments/quotes", () => {
    const s = parseNexusSettings(
      [
        "# top comment",
        'run_mode = "nonconcurrent"',
        "[scripts]",
        "setup = 'pnpm install'   # inline comment",
        'run = "pnpm dev"',
        "archive = pnpm clean",
        "[other]",
        "ignored = 1",
      ].join("\n"),
    );
    expect(s.runMode).toBe("nonconcurrent");
    expect(s.scripts.setup).toBe("pnpm install");
    expect(s.scripts.run).toBe("pnpm dev");
    expect(s.scripts.archive).toBe("pnpm clean");
  });

  it("defaults to concurrent with no scripts", () => {
    const s = parseNexusSettings("");
    expect(s.runMode).toBe("concurrent");
    expect(s.scripts).toEqual({});
  });
});

describe("loadNexusSettings", () => {
  it("returns defaults when the file is absent", async () => {
    const s = await loadNexusSettings(path.join(tmpRoot, "nope"));
    expect(s).toEqual({ scripts: {}, runMode: "concurrent" });
  });
});

describe("WorkspaceManager", () => {
  it("creates a worktree off origin/main with ports + env", async () => {
    const mgr = makeManager();
    const ws = await mgr.create({ name: "alpha", baseBranch: "main" });

    expect(ws.branch).toBe("nexus/alpha");
    expect(ws.baseBranch).toBe("main");
    // Worktree dir exists and contains the seeded file.
    await expect(fs.readFile(path.join(ws.path, "README.md"), "utf8")).resolves.toContain("seed");
    // 10 contiguous reserved ports.
    expect(ws.ports).toHaveLength(10);
    expect(ws.ports[9] - ws.ports[0]).toBe(9);
    // Env block.
    expect(ws.env.NEXUS_WORKSPACE_NAME).toBe("alpha");
    expect(ws.env.NEXUS_WORKSPACE_PATH).toBe(ws.path);
    expect(ws.env.NEXUS_ROOT_PATH).toBe(repoPath);
    expect(ws.env.NEXUS_PORT).toBe(String(ws.ports[0]));
    // Git registered the worktree on the new branch.
    const wl = await git(repoPath, ["worktree", "list", "--porcelain"]);
    expect(wl.stdout).toContain(ws.path);
    const branches = await git(repoPath, ["branch", "--list", "nexus/alpha"]);
    expect(branches.stdout).toContain("nexus/alpha");
  });

  it("rejects a duplicate active name and invalid names", async () => {
    const mgr = makeManager();
    await expect(mgr.create({ name: "alpha", baseBranch: "main" })).rejects.toThrow(/already active/);
    await expect(mgr.create({ name: "bad name", baseBranch: "main" })).rejects.toThrow(/invalid/);
  });

  it("lists and gets workspaces", async () => {
    const mgr = makeManager();
    await mgr.create({ name: "beta", baseBranch: "main" });
    const all = await mgr.list();
    expect(all.map((w) => w.name).sort()).toEqual(["alpha", "beta"]);
    const got = await mgr.get("beta");
    expect(got?.branch).toBe("nexus/beta");
    expect(await mgr.get("ghost")).toBeNull();
  });

  it("archives (dir gone, branch kept) and restores", async () => {
    const mgr = makeManager();
    const ws = await mgr.create({ name: "gamma", baseBranch: "main" });
    expect(await fs.stat(ws.path).then(() => true)).toBe(true);

    await mgr.archive("gamma");
    // Working dir removed…
    await expect(fs.stat(ws.path)).rejects.toThrow();
    // …but the branch survives.
    const branches = await git(repoPath, ["branch", "--list", "nexus/gamma"]);
    expect(branches.stdout).toContain("nexus/gamma");
    expect((await mgr.get("gamma"))?.archived).toBe(true);

    const restored = await mgr.restore("gamma");
    expect(restored.archived).toBe(false);
    await expect(fs.readFile(path.join(restored.path, "README.md"), "utf8")).resolves.toContain(
      "seed",
    );
  });

  it("serializes concurrent creates: disjoint ports, none clobbered", async () => {
    const root = path.join(tmpRoot, "ws-conc");
    const mk = (): WorkspaceManager =>
      new WorkspaceManager({ repoPath, workspacesRoot: root, portBase: 40000 });
    const names = ["c1", "c2", "c3", "c4"];
    // Separate manager instances → exercises the cross-process file lock, not
    // an in-process mutex. The shared index must not be clobbered.
    const created = await Promise.all(names.map((n) => mk().create({ name: n, baseBranch: "main" })));

    const all = await mk().list();
    expect(all.map((w) => w.name).sort()).toEqual(names);

    const seen = new Set<number>();
    for (const ws of created) {
      for (const p of ws.ports) {
        expect(seen.has(p)).toBe(false); // no overlap across workspaces
        seen.add(p);
      }
    }
    expect(seen.size).toBe(names.length * 10);
  });

  it("runs [scripts].archive before removing the worktree", async () => {
    const mgr = makeManager();
    const ws = await mgr.create({ name: "delta", baseBranch: "main" });
    const flag = path.join(tmpRoot, "delta-archived.flag");
    await fs.mkdir(path.join(ws.path, ".nexus"), { recursive: true });
    await fs.writeFile(
      path.join(ws.path, ".nexus", "settings.toml"),
      `[scripts]\narchive = "touch ${flag}"\n`,
    );

    await mgr.archive("delta");
    await expect(fs.stat(flag)).resolves.toBeTruthy(); // archive script ran…
    await expect(fs.stat(ws.path)).rejects.toThrow(); // …then the dir was removed
  });
});

describe("collectChecks", () => {
  it("reports clean → ahead → dirty as the branch evolves", async () => {
    const mgr = makeManager();
    const ws = await mgr.create({ name: "checks", baseBranch: "main" });

    // Fresh worktree at origin/main tip: clean, nothing ahead, not merge-ready.
    let c = await collectChecks(ws);
    expect(c).toEqual({ uncommittedChanges: false, commitsAhead: 0, mergeReady: false });

    // Commit a change: one ahead, clean → merge-ready.
    await fs.writeFile(path.join(ws.path, "f.txt"), "x");
    await git(ws.path, ["add", "."]);
    await git(ws.path, ["commit", "-m", "work"]);
    c = await collectChecks(ws);
    expect(c).toEqual({ uncommittedChanges: false, commitsAhead: 1, mergeReady: true });

    // Dirty the tree: not merge-ready while uncommitted changes remain.
    await fs.writeFile(path.join(ws.path, "f2.txt"), "y");
    c = await collectChecks(ws);
    expect(c.uncommittedChanges).toBe(true);
    expect(c.mergeReady).toBe(false);
  });
});
