// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { isSafeCommandName, parseNpmCmdShim, PtyManager, resolveCommand } from "./index";

describe("isSafeCommandName", () => {
  it("accepts plain command names", () => {
    expect(isSafeCommandName("claude")).toBe(true);
    expect(isSafeCommandName("codex")).toBe(true);
    expect(isSafeCommandName("node-v20")).toBe(true);
    expect(isSafeCommandName("my_agent.2")).toBe(true);
  });

  it("rejects anything with shell metacharacters", () => {
    expect(isSafeCommandName("ls -la")).toBe(false);
    expect(isSafeCommandName("rm -rf /")).toBe(false);
    expect(isSafeCommandName("echo;whoami")).toBe(false);
    expect(isSafeCommandName("$(curl evil)")).toBe(false);
    expect(isSafeCommandName("claude &")).toBe(false);
  });
});

describe("resolveCommand", () => {
  it("passes absolute paths through with a disk check", () => {
    const r = resolveCommand("C:\\Windows\\System32\\cmd.exe");
    // On Windows the path exists; on POSIX it does not — both are valid outcomes.
    expect(r.found).toBe(typeof r.path === "string" && r.path.length > 0);
  });

  it("never resolves an unsafe name against PATH", () => {
    const r = resolveCommand("echo;id");
    expect(r.found).toBe(false);
  });
});

describe("parseNpmCmdShim", () => {
  it("parses a standard npm .cmd shim", () => {
    const shim = '@ECHO off\r\nnode "%~dp0\\..\\claude-code\\bin\\cli.js" %*\r\n';
    const r = parseNpmCmdShim(shim);
    expect(r).not.toBeNull();
    expect(r!.target).toContain("claude-code");
  });

  it("returns null for a non-shim file", () => {
    expect(parseNpmCmdShim("hello world")).toBeNull();
  });
});

describe("PtyManager — spawn / write / exit lifecycle", () => {
  it("spawns a real PTY, streams output, and reports exit", async () => {
    const mgr = new PtyManager();
    const isWin = process.platform === "win32";
    const session = mgr.spawn({
      id: "t1",
      command: isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      args: isWin ? ["/c", "echo pty-test-output"] : ["-c", "echo pty-test-output"],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    expect(session.id).toBe("t1");
    expect(mgr.liveCount).toBe(1);

    const output: string[] = [];
    mgr.onData("t1", (d) => output.push(d));

    await new Promise<void>((resolve) => {
      mgr.onExit("t1", () => resolve());
      // Safety timeout in case the PTY never exits.
      setTimeout(resolve, 15_000);
    });

    expect(output.join("")).toContain("pty-test-output");
    const list = mgr.list();
    expect(list[0]!.exited).toBe(true);
    expect(list[0]!.exitCode).toBe(0);
    expect(mgr.liveCount).toBe(0);
  }, 30_000);

  it("throws on unknown session id for write", () => {
    const mgr = new PtyManager();
    expect(() => mgr.write("nope", "x")).toThrow(/no such pty session/);
    expect(() => mgr.resize("nope", 80, 24)).toThrow(/no such pty session/);
  });

  it("rejects duplicate session ids", () => {
    const mgr = new PtyManager();
    const isWin = process.platform === "win32";
    const opts = {
      id: "dup",
      command: isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      cwd: process.cwd(),
    };
    mgr.spawn(opts);
    expect(() => mgr.spawn(opts)).toThrow(/already exists/);
  });

  it("throws a helpful error for a missing command", () => {
    const mgr = new PtyManager();
    expect(() => mgr.spawn({ id: "x", command: "definitely-not-a-real-command-xyz" })).toThrow(
      /command not found/,
    );
  });
});

describe("PtyManager — onData replay for late subscribers", () => {
  it("replays the tail to a late subscriber", async () => {
    const mgr = new PtyManager();
    const isWin = process.platform === "win32";
    mgr.spawn({
      id: "t2",
      command: isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      args: isWin ? ["/c", "echo early-output"] : ["-c", "echo early-output"],
      cwd: process.cwd(),
    });
    await new Promise<void>((resolve) => {
      mgr.onExit("t2", () => resolve());
      setTimeout(resolve, 15_000);
    });
    // After exit, a fresh onData subscriber still sees the retained tail.
    const late: string[] = [];
    mgr.onData("t2", (d) => late.push(d));
    expect(late.join("")).toContain("early-output");
  }, 30_000);
});

describe("PtyManager — remove + retention bound", () => {
  it("remove() drops the session from the list entirely", () => {
    const mgr = new PtyManager();
    const isWin = process.platform === "win32";
    mgr.spawn({
      id: "gone",
      command: isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      cwd: process.cwd(),
    });
    expect(mgr.list().some((s) => s.id === "gone")).toBe(true);
    mgr.remove("gone");
    expect(mgr.list().some((s) => s.id === "gone")).toBe(false);
    expect(() => mgr.write("gone", "x")).toThrow(/no such pty session/);
  });

  it("evicts the oldest exited sessions beyond the retention cap", async () => {
    const mgr = new PtyManager();
    const isWin = process.platform === "win32";
    // Spawn + wait for exit 25 times (over the 20 cap) so eviction must run.
    for (let i = 0; i < 25; i++) {
      mgr.spawn({
        id: `e${i}`,
        command: isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
        args: isWin ? ["/c", "exit"] : ["-c", "exit 0"],
        cwd: process.cwd(),
      });
    }
    await new Promise<void>((resolve) => {
      mgr.onExit("e24", () => resolve());
      setTimeout(resolve, 30_000);
    });
    await new Promise((r) => setTimeout(r, 500)); // let remaining exits settle
    const exited = mgr.list().filter((s) => s.exited);
    expect(exited.length).toBeLessThanOrEqual(20);
    // The OLDEST ids must be the ones evicted.
    expect(mgr.list().some((s) => s.id === "e0")).toBe(false);
    expect(mgr.list().some((s) => s.id === "e24")).toBe(true);
  }, 60_000);
});
