// SPDX-License-Identifier: Apache-2.0
import * as os from "node:os";

import { describe, expect, it } from "vitest";

import {
  WorkspaceRunner,
  type NexusSettings,
  type Workspace,
} from "../../src/handlers/workspace-manager.js";

// A long-lived command that blocks on EVERY platform (workspace-manager used to
// spawn through /bin/sh, so `sleep 30` ENOENT'd on Windows before any process
// semantics could be exercised). Node itself is the only guaranteed binary.
const NEVER = `"${process.execPath}" -e "setInterval(()=>{},1<<30)"`;
// Portable "sleep until killed": blocks on stdin, exits cleanly on EOF/SIGHUP.
const PENDING = `"${process.execPath}" -e "process.stdin.resume()"`;

const ws = (name: string, port: number): Workspace => ({
  name,
  path: os.tmpdir(),
  branch: `nexus/${name}`,
  baseBranch: "main",
  rootPath: os.tmpdir(),
  ports: Array.from({ length: 10 }, (_, i) => port + i),
  env: { NEXUS_PORT: String(port) },
  archived: false,
});

const settings = (
  run?: string,
  runMode: "concurrent" | "nonconcurrent" = "concurrent",
): NexusSettings => ({
  scripts: run ? { run } : {},
  runMode,
});

const exited = (child: { exitCode: number | null; signalCode: NodeJS.Signals | null }): boolean =>
  child.exitCode !== null || child.signalCode !== null;

describe("WorkspaceRunner", () => {
  it("returns null when there is no run script", () => {
    const runner = new WorkspaceRunner();
    expect(runner.start(ws("x", 44000), settings())).toBeNull();
  });

  it("concurrent mode runs one server per workspace", async () => {
    const runner = new WorkspaceRunner();
    const h1 = runner.start(ws("a", 41000), settings(NEVER))!;
    const h2 = runner.start(ws("b", 41010), settings(NEVER))!;
    expect(h1.child).not.toBe(h2.child);
    expect(h1.port).toBe(41000);
    expect(exited(h1.child)).toBe(false);
    expect(runner.list()).toHaveLength(2);

    await runner.stop(h1.key);
    await runner.stop(h2.key);
    expect(exited(h1.child)).toBe(true);
    expect(exited(h2.child)).toBe(true);
    expect(runner.list()).toHaveLength(0);
  });

  it("nonconcurrent mode shares one ref-counted server", async () => {
    const runner = new WorkspaceRunner();
    const s = settings(PENDING, "nonconcurrent");
    const h1 = runner.start(ws("a", 42000), s)!;
    const h2 = runner.start(ws("b", 42010), s)!;
    expect(h2.child).toBe(h1.child); // shared
    expect(runner.list()).toHaveLength(1);

    await runner.stop(h1.key); // refs 2→1, still running
    expect(exited(h1.child)).toBe(false);
    await runner.stop(h1.key); // refs 1→0, stops
    expect(exited(h1.child)).toBe(true);
  });

  it("stopAll stops every run process", async () => {
    const runner = new WorkspaceRunner();
    runner.start(ws("a", 43000), settings(NEVER));
    runner.start(ws("b", 43010), settings(NEVER));
    expect(runner.list()).toHaveLength(2);
    await runner.stopAll();
    expect(runner.list()).toHaveLength(0);
  });
});
