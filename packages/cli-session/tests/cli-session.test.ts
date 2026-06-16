// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  MockProcessSpawner,
  MockProcess,
  StderrCapture,
  AllowedDirPolicy,
  AuthTokenInjector,
  CliSession,
  SessionManager,
} from "../src/index.js";

// ── MockProcessSpawner ────────────────────────────────────────────────────────

describe("MockProcessSpawner", () => {
  it("spawns a process with increasing PID", () => {
    const spawner = new MockProcessSpawner();
    const p1 = spawner.spawn({ command: "echo" });
    const p2 = spawner.spawn({ command: "cat" });
    expect(p2.pid).toBeGreaterThan(p1.pid);
  });

  it("stores spawn options", () => {
    const spawner = new MockProcessSpawner();
    spawner.spawn({ command: "node", args: ["server.js"], cwd: "/app" });
    expect(spawner.lastOptions?.command).toBe("node");
    expect(spawner.lastOptions?.cwd).toBe("/app");
  });

  it("lastProcess returns most recent process", () => {
    const spawner = new MockProcessSpawner();
    spawner.spawn({ command: "a" });
    const p2 = spawner.spawn({ command: "b" });
    expect(spawner.lastProcess()).toBe(p2);
  });
});

// ── MockProcess ───────────────────────────────────────────────────────────────

describe("MockProcess", () => {
  it("captures written inputs", () => {
    const proc = new MockProcess(1);
    proc.write("hello");
    proc.write("world");
    expect(proc.writtenInputs).toEqual(["hello", "world"]);
  });

  it("emits stdout to subscribers", () => {
    const proc = new MockProcess(1);
    const lines: string[] = [];
    proc.onStdout((l) => lines.push(l));
    proc.emitStdout("line 1");
    proc.emitStdout("line 2");
    expect(lines).toEqual(["line 1", "line 2"]);
  });

  it("emits stderr to subscribers", () => {
    const proc = new MockProcess(1);
    const errs: string[] = [];
    proc.onStderr((l) => errs.push(l));
    proc.emitStderr("error!");
    expect(errs).toContain("error!");
  });

  it("kill emits exit and sets killed=true", () => {
    const proc = new MockProcess(1);
    let exitCode: number | null = 999;
    proc.onExit((code) => {
      exitCode = code;
    });
    proc.kill("SIGKILL");
    expect(proc.killed).toBe(true);
    expect(proc.killSignal).toBe("SIGKILL");
    expect(exitCode).toBeNull();
  });

  it("emitExit triggers callbacks", () => {
    const proc = new MockProcess(1);
    let received: number | null = undefined as any;
    proc.onExit((c) => {
      received = c;
    });
    proc.emitExit(0);
    expect(received).toBe(0);
  });
});

// ── StderrCapture ─────────────────────────────────────────────────────────────

describe("StderrCapture", () => {
  it("captures lines", () => {
    const cap = new StderrCapture();
    cap.push("err1");
    cap.push("err2");
    expect(cap.all()).toEqual(["err1", "err2"]);
    expect(cap.count()).toBe(2);
  });

  it("evicts oldest when maxLines exceeded", () => {
    const cap = new StderrCapture(3);
    cap.push("a");
    cap.push("b");
    cap.push("c");
    cap.push("d"); // evicts "a"
    expect(cap.all()).toEqual(["b", "c", "d"]);
  });

  it("recent returns last N lines", () => {
    const cap = new StderrCapture();
    for (let i = 0; i < 10; i++) cap.push(`line ${i}`);
    const recent = cap.recent(3);
    expect(recent).toHaveLength(3);
    expect(recent[2]).toBe("line 9");
  });

  it("clear empties capture", () => {
    const cap = new StderrCapture();
    cap.push("err");
    cap.clear();
    expect(cap.count()).toBe(0);
  });
});

// ── AllowedDirPolicy ──────────────────────────────────────────────────────────

describe("AllowedDirPolicy", () => {
  const policy = new AllowedDirPolicy(["/workspace/project", "/tmp"]);

  it("allows paths inside allowed dirs", () => {
    expect(policy.isAllowed("/workspace/project/src")).toBe(true);
    expect(policy.isAllowed("/tmp/scratch")).toBe(true);
  });

  it("denies paths outside allowed dirs", () => {
    expect(policy.isAllowed("/etc/passwd")).toBe(false);
    expect(policy.isAllowed("/home/user/secret")).toBe(false);
  });

  it("allows the root dir itself", () => {
    expect(policy.isAllowed("/workspace/project")).toBe(true);
  });

  it("empty dirs allow everything", () => {
    const p = new AllowedDirPolicy([]);
    expect(p.isAllowed("/etc/passwd")).toBe(true);
  });

  it("getAllowed returns dirs", () => {
    expect(policy.getAllowed()).toHaveLength(2);
  });
});

// ── AuthTokenInjector ─────────────────────────────────────────────────────────

describe("AuthTokenInjector", () => {
  it("injects tokens into env", () => {
    const inj = new AuthTokenInjector();
    inj.setToken("API_KEY", "secret123").setToken("AUTH_TOKEN", "bearer-abc");
    const env = inj.inject({ EXISTING: "value" });
    expect(env["API_KEY"]).toBe("secret123");
    expect(env["AUTH_TOKEN"]).toBe("bearer-abc");
    expect(env["EXISTING"]).toBe("value");
  });

  it("setToken supports chaining", () => {
    const inj = new AuthTokenInjector();
    expect(inj.setToken("K", "V")).toBe(inj);
  });

  it("inject without args creates new env", () => {
    const inj = new AuthTokenInjector();
    inj.setToken("X", "Y");
    expect(inj.inject()["X"]).toBe("Y");
  });

  it("clear removes all tokens", () => {
    const inj = new AuthTokenInjector();
    inj.setToken("K", "V");
    inj.clear();
    expect(inj.inject()).toEqual({});
  });
});

// ── CliSession ────────────────────────────────────────────────────────────────

describe("CliSession", () => {
  let spawner: MockProcessSpawner;

  beforeEach(() => {
    spawner = new MockProcessSpawner();
  });

  it("starts and runs a session", () => {
    const session = new CliSession("s1", spawner, { command: "node", args: ["app.js"] });
    session.start();
    expect(session.getStatus()).toBe("running");
    expect(session.getPid()).toBeGreaterThan(0);
  });

  it("cannot start an already running session", () => {
    const session = new CliSession("s1", spawner, { command: "node" });
    session.start();
    expect(() => session.start()).toThrow("Cannot start session");
  });

  it("stop sends kill signal", () => {
    const session = new CliSession("s1", spawner, { command: "node" });
    session.start();
    session.stop("SIGTERM");
    expect(spawner.lastProcess()?.killed).toBe(true);
  });

  it("captures stdout lines", () => {
    const session = new CliSession("s1", spawner, { command: "node" });
    session.start();
    spawner.lastProcess()!.emitStdout("output line 1");
    spawner.lastProcess()!.emitStdout("output line 2");
    expect(session.getOutput().stdout).toEqual(["output line 1", "output line 2"]);
  });

  it("captures stderr lines", () => {
    const session = new CliSession("s1", spawner, { command: "node" });
    session.start();
    spawner.lastProcess()!.emitStderr("error occurred");
    expect(session.recentStderr()).toContain("error occurred");
  });

  it("onOutput listener fires for each line", () => {
    const session = new CliSession("s1", spawner, { command: "node" });
    const received: string[] = [];
    session.start();
    session.onOutput((line) => received.push(line));
    spawner.lastProcess()!.emitStdout("hello");
    expect(received).toContain("hello");
  });

  it("onOutput unsubscribe works", () => {
    const session = new CliSession("s1", spawner, { command: "node" });
    const received: string[] = [];
    session.start();
    const unsub = session.onOutput((l) => received.push(l));
    unsub();
    spawner.lastProcess()!.emitStdout("after unsub");
    expect(received).toHaveLength(0);
  });

  it("transitions to stopped on exit code 0", () => {
    const session = new CliSession("s1", spawner, { command: "node" });
    session.start();
    spawner.lastProcess()!.emitExit(0);
    expect(session.getStatus()).toBe("stopped");
    expect(session.getExitCode()).toBe(0);
  });

  it("transitions to crashed on non-zero exit", () => {
    const session = new CliSession("s1", spawner, { command: "node" });
    session.start();
    spawner.lastProcess()!.emitExit(1);
    expect(session.getStatus()).toBe("crashed");
  });

  it("write sends input to process", () => {
    const session = new CliSession("s1", spawner, { command: "node" });
    session.start();
    session.write("test input");
    expect(spawner.lastProcess()!.writtenInputs).toContain("test input");
  });

  it("write throws when not running", () => {
    const session = new CliSession("s1", spawner, { command: "node" });
    expect(() => session.write("data")).toThrow("not running");
  });

  it("injects auth tokens into env", () => {
    const inj = new AuthTokenInjector().setToken("AUTH_TOKEN", "secret");
    const session = new CliSession("s1", spawner, { command: "node", authInjector: inj });
    session.start();
    expect(spawner.lastOptions?.env?.["AUTH_TOKEN"]).toBe("secret");
  });

  it("isAllowedDir respects allowedDirs", () => {
    const session = new CliSession("s1", spawner, { command: "node", allowedDirs: ["/safe"] });
    expect(session.isAllowedDir("/safe/file.js")).toBe(true);
    expect(session.isAllowedDir("/unsafe/file.js")).toBe(false);
  });
});

// ── SessionManager ────────────────────────────────────────────────────────────

describe("SessionManager", () => {
  let spawner: MockProcessSpawner;
  let manager: SessionManager;

  beforeEach(() => {
    spawner = new MockProcessSpawner();
    manager = new SessionManager(spawner);
  });

  it("creates and retrieves a session", () => {
    const session = manager.create({ command: "node" }, "my-session");
    expect(manager.get("my-session")).toBe(session);
  });

  it("throws on duplicate session id", () => {
    manager.create({ command: "node" }, "s1");
    expect(() => manager.create({ command: "node" }, "s1")).toThrow("already exists");
  });

  it("auto-assigns ID when none provided", () => {
    const s = manager.create({ command: "node" });
    expect(s.id).toMatch(/^cli-/);
  });

  it("remove stops and removes session", () => {
    const session = manager.create({ command: "node" }, "s1");
    session.start();
    expect(manager.remove("s1")).toBe(true);
    expect(manager.get("s1")).toBeUndefined();
    expect(spawner.lastProcess()?.killed).toBe(true);
  });

  it("remove returns false for unknown id", () => {
    expect(manager.remove("ghost")).toBe(false);
  });

  it("list returns all sessions", () => {
    manager.create({ command: "a" }, "a");
    manager.create({ command: "b" }, "b");
    expect(manager.list()).toHaveLength(2);
  });

  it("stopAll stops running sessions", () => {
    const s1 = manager.create({ command: "a" }, "a");
    const s2 = manager.create({ command: "b" }, "b");
    s1.start();
    s2.start();
    manager.stopAll();
    expect(spawner.processes[0]!.killed).toBe(true);
    expect(spawner.processes[1]!.killed).toBe(true);
  });

  it("count returns session count", () => {
    manager.create({ command: "a" }, "a");
    manager.create({ command: "b" }, "b");
    expect(manager.count()).toBe(2);
  });
});
