// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// No sessionId is used below, so the db layer is never touched — mock it inert
// to avoid a real pool/connection on import.
vi.mock("@nexus/db", () => ({ db: {} }));
vi.mock("@nexus/db/schema", () => ({ agentSessions: {} }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

// Fake driver: one turn, no tool calls → the loop ends after a single step.
// Defined inside the factory because vi.mock is hoisted above module scope.
vi.mock("@nexus/llm-drivers", () => {
  class FakeDriver {
    readonly model = "fake-model";
    async stream(): Promise<{
      content: string;
      toolCalls: never[];
      usage: Record<string, number>;
    }> {
      return {
        content: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    }
  }
  return { AnthropicDriver: FakeDriver, GroqDriver: FakeDriver, OpenRouterDriver: FakeDriver };
});

import { handleAgentRunJob } from "../../src/handlers/agent-handler.js";

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]): Promise<unknown> => execFileAsync("git", args, { cwd });

let tmpRoot: string;
let repoPath: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-wire-"));
  const origin = path.join(tmpRoot, "origin");
  await fs.mkdir(origin, { recursive: true });
  await git(origin, ["init", "-b", "main"]);
  await git(origin, ["config", "user.email", "t@t.dev"]);
  await git(origin, ["config", "user.name", "t"]);
  await fs.writeFile(path.join(origin, "README.md"), "seed\n");
  await fs.mkdir(path.join(origin, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(origin, ".nexus", "settings.toml"), '[scripts]\nrun = "sleep 30"\n');
  await git(origin, ["add", "."]);
  await git(origin, ["commit", "-m", "seed"]);

  repoPath = path.join(tmpRoot, "checkout");
  await git(tmpRoot, ["clone", origin, repoPath]);
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("handleAgentRunJob — worktree workspace", () => {
  it("provisions a worktree, runs the agent inside it, and returns workspace info", async () => {
    const res = await handleAgentRunJob({
      instruction: "noop",
      provider: "anthropic",
      apiKey: "test-key",
      worktree: {
        repoPath,
        baseBranch: "main",
        name: "wired",
        runSetup: false,
        workspacesRoot: path.join(tmpRoot, "ws"),
        portBase: 39100,
      },
    });

    expect(res.ok).toBe(true);
    expect(res.finalContent).toBe("done");
    const ws = res.workspace as {
      name: string;
      branch: string;
      path: string;
      ports: number[];
      checks: { mergeReady: boolean; commitsAhead: number };
    };
    expect(ws.name).toBe("wired");
    expect(ws.branch).toBe("nexus/wired");
    expect(ws.ports).toHaveLength(10);
    // Merge-gating checks are always computed for a worktree run.
    expect(ws.checks).toEqual({ uncommittedChanges: false, commitsAhead: 0, mergeReady: false });
    // The worktree exists on disk and the branch was registered in the repo.
    await expect(fs.readFile(path.join(ws.path, "README.md"), "utf8")).resolves.toContain("seed");
    const branches = (await execFileAsync("git", ["branch", "--list", "nexus/wired"], {
      cwd: repoPath,
    })) as { stdout: string };
    expect(branches.stdout).toContain("nexus/wired");
  });

  it("archives the workspace after the run when archiveOnComplete is set", async () => {
    const res = await handleAgentRunJob({
      instruction: "noop",
      provider: "anthropic",
      apiKey: "test-key",
      worktree: {
        repoPath,
        baseBranch: "main",
        name: "ephemeral",
        runSetup: false,
        archiveOnComplete: true,
        workspacesRoot: path.join(tmpRoot, "ws"),
        portBase: 39200,
      },
    });
    const ws2 = res.workspace as { path: string; branch: string };
    // Working dir removed…
    await expect(fs.stat(ws2.path)).rejects.toThrow();
    // …branch kept.
    const branches = (await execFileAsync("git", ["branch", "--list", "nexus/ephemeral"], {
      cwd: repoPath,
    })) as { stdout: string };
    expect(branches.stdout).toContain("nexus/ephemeral");
  });

  it("starts the run server for the duration and returns its url", async () => {
    const res = await handleAgentRunJob({
      instruction: "noop",
      provider: "anthropic",
      apiKey: "test-key",
      worktree: {
        repoPath,
        baseBranch: "main",
        name: "running",
        runSetup: false,
        startRun: true,
        workspacesRoot: path.join(tmpRoot, "ws"),
        portBase: 39300,
      },
    });
    const ws = res.workspace as { ports: number[]; run?: { url: string; port: number } };
    expect(ws.run).toBeDefined();
    expect(ws.run!.port).toBe(ws.ports[0]);
    expect(ws.run!.url).toBe(`http://127.0.0.1:${ws.ports[0]}`);
  });
});
