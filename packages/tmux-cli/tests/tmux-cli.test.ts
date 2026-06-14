// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  TmuxClient,
  NullTmuxClient,
  TmuxError,
  type ITmuxClient,
  type ExecFn,
  type ExecResult,
} from "../src/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeExec(
  responses: Record<string, ExecResult>,
  fallback: ExecResult = { stdout: "", stderr: "", exitCode: 0 },
): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const key = args[0] ?? "";
    return responses[key] ?? fallback;
  };
  return { exec, calls };
}

function okExec(): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } {
  return makeExec({});
}

// ── TmuxClient ────────────────────────────────────────────────────────────────

describe("TmuxClient", () => {
  it("newSession passes -d -s flags by default", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.newSession("work");
    expect(calls[0]!.args).toContain("-d");
    expect(calls[0]!.args).toContain("-s");
    expect(calls[0]!.args).toContain("work");
  });

  it("newSession omits -d when detached: false", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.newSession("work", { detached: false });
    expect(calls[0]!.args).not.toContain("-d");
  });

  it("newSession passes startDir and windowName", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.newSession("work", { startDir: "/tmp", windowName: "main" });
    const args = calls[0]!.args;
    expect(args).toContain("-c");
    expect(args).toContain("/tmp");
    expect(args).toContain("-n");
    expect(args).toContain("main");
  });

  it("killSession sends kill-session -t", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.killSession("work");
    expect(calls[0]!.args).toEqual(["kill-session", "-t", "work"]);
  });

  it("hasSession returns true on exitCode 0", async () => {
    const { exec } = makeExec({ "has-session": { stdout: "", stderr: "", exitCode: 0 } });
    const client = new TmuxClient(exec);
    expect(await client.hasSession("work")).toBe(true);
  });

  it("hasSession returns false on non-zero exitCode", async () => {
    const { exec } = makeExec({ "has-session": { stdout: "", stderr: "no session", exitCode: 1 } });
    const client = new TmuxClient(exec);
    expect(await client.hasSession("nope")).toBe(false);
  });

  it("listSessions parses tmux format output", async () => {
    const raw = "work:2:0:1718000000\ndev:1:1:1718001000";
    const { exec } = makeExec({
      "list-sessions": { stdout: raw, stderr: "", exitCode: 0 },
    });
    const client = new TmuxClient(exec);
    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.name).toBe("work");
    expect(sessions[0]!.windows).toBe(2);
    expect(sessions[0]!.attached).toBe(false);
    expect(sessions[1]!.attached).toBe(true);
  });

  it("listSessions returns [] when tmux errors (no sessions)", async () => {
    const { exec } = makeExec({
      "list-sessions": { stdout: "", stderr: "no server", exitCode: 1 },
    });
    const client = new TmuxClient(exec);
    expect(await client.listSessions()).toEqual([]);
  });

  it("newWindow passes name and startDir", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.newWindow("work", { name: "editor", startDir: "/src" });
    const args = calls[0]!.args;
    expect(args).toContain("-n");
    expect(args).toContain("editor");
    expect(args).toContain("-c");
    expect(args).toContain("/src");
  });

  it("selectWindow calls select-window -t", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.selectWindow("work:1");
    expect(calls[0]!.args).toEqual(["select-window", "-t", "work:1"]);
  });

  it("listPanes parses pane format output", async () => {
    const raw = "0:1:220:50\n1:0:110:50";
    const { exec } = makeExec({
      "list-panes": { stdout: raw, stderr: "", exitCode: 0 },
    });
    const client = new TmuxClient(exec);
    const panes = await client.listPanes("work");
    expect(panes).toHaveLength(2);
    expect(panes[0]!.active).toBe(true);
    expect(panes[1]!.active).toBe(false);
    expect(panes[0]!.width).toBe(220);
  });

  it("splitPane uses -v by default", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.splitPane("work");
    expect(calls[0]!.args).toContain("-v");
    expect(calls[0]!.args).not.toContain("-h");
  });

  it("splitPane uses -h when horizontal: true", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.splitPane("work", { horizontal: true });
    expect(calls[0]!.args).toContain("-h");
  });

  it("splitPane passes percent option", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.splitPane("work", { percent: 30 });
    const args = calls[0]!.args;
    expect(args).toContain("-p");
    expect(args).toContain("30");
  });

  it("sendKeys without enter omits Enter arg", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.sendKeys("work", "ls -la");
    expect(calls[0]!.args).not.toContain("Enter");
    expect(calls[0]!.args).toContain("ls -la");
  });

  it("sendKeys with enter appends Enter", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.sendKeys("work", "ls", true);
    expect(calls[0]!.args).toContain("Enter");
  });

  it("runCommand calls sendKeys with enter=true", async () => {
    const { exec, calls } = okExec();
    const client = new TmuxClient(exec);
    await client.runCommand("work", "npm test");
    expect(calls[0]!.args).toContain("Enter");
    expect(calls[0]!.args).toContain("npm test");
  });

  it("capturePane passes joinLines -J flag", async () => {
    const { exec, calls } = makeExec({
      "capture-pane": { stdout: "output", stderr: "", exitCode: 0 },
    });
    const client = new TmuxClient(exec);
    await client.capturePane("work", { joinLines: true });
    expect(calls[0]!.args).toContain("-J");
  });

  it("capturePane passes startLine and endLine", async () => {
    const { exec, calls } = makeExec({
      "capture-pane": { stdout: "", stderr: "", exitCode: 0 },
    });
    const client = new TmuxClient(exec);
    await client.capturePane("work", { startLine: -50, endLine: 0 });
    const args = calls[0]!.args;
    expect(args).toContain("-S");
    expect(args).toContain("-50");
    expect(args).toContain("-E");
    expect(args).toContain("0");
  });

  it("throws TmuxError on non-zero exit", async () => {
    const { exec } = makeExec({
      "new-session": { stdout: "", stderr: "duplicate session", exitCode: 1 },
    });
    const client = new TmuxClient(exec);
    await expect(client.newSession("dup")).rejects.toThrow(TmuxError);
  });

  it("waitForOutput resolves when pattern matches", async () => {
    let callCount = 0;
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "capture-pane") {
        callCount++;
        const out = callCount >= 3 ? "$ done\n" : "$ running\n";
        return { stdout: out, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const client = new TmuxClient(exec);
    const out = await client.waitForOutput("work", /done/, { intervalMs: 10 });
    expect(out).toContain("done");
  });

  it("waitForOutput throws TmuxError on timeout", async () => {
    const exec: ExecFn = async () => ({ stdout: "still running", stderr: "", exitCode: 0 });
    const client = new TmuxClient(exec);
    await expect(
      client.waitForOutput("work", /finished/, { intervalMs: 10, timeoutMs: 50 }),
    ).rejects.toThrow(TmuxError);
  });

  it("TmuxError has code WAIT_TIMEOUT", async () => {
    const exec: ExecFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const client = new TmuxClient(exec);
    try {
      await client.waitForOutput("work", /x/, { timeoutMs: 30, intervalMs: 10 });
    } catch (e) {
      expect(e instanceof TmuxError).toBe(true);
      expect((e as TmuxError).code).toBe("WAIT_TIMEOUT");
    }
  });
});

// ── NullTmuxClient ────────────────────────────────────────────────────────────

describe("NullTmuxClient", () => {
  let client: NullTmuxClient;

  beforeEach(() => {
    client = new NullTmuxClient();
  });

  it("implements ITmuxClient interface", () => {
    const c: ITmuxClient = client;
    expect(typeof c.newSession).toBe("function");
    expect(typeof c.killSession).toBe("function");
    expect(typeof c.hasSession).toBe("function");
  });

  it("newSession creates a session", async () => {
    await client.newSession("work");
    expect(await client.hasSession("work")).toBe(true);
  });

  it("newSession throws SESSION_EXISTS on duplicate", async () => {
    await client.newSession("work");
    await expect(client.newSession("work")).rejects.toThrow(TmuxError);
    try {
      await client.newSession("work");
    } catch (e) {
      expect((e as TmuxError).code).toBe("SESSION_EXISTS");
    }
  });

  it("killSession removes session", async () => {
    await client.newSession("work");
    await client.killSession("work");
    expect(await client.hasSession("work")).toBe(false);
  });

  it("killSession throws NO_SESSION on missing session", async () => {
    await expect(client.killSession("ghost")).rejects.toThrow(TmuxError);
  });

  it("listSessions returns all sessions", async () => {
    await client.newSession("a");
    await client.newSession("b");
    const sessions = await client.listSessions();
    expect(sessions.map((s) => s.name)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("hasSession returns false for unknown session", async () => {
    expect(await client.hasSession("none")).toBe(false);
  });

  it("newWindow increments window count", async () => {
    await client.newSession("work");
    await client.newWindow("work", { name: "editor" });
    const sessions = await client.listSessions();
    expect(sessions[0]!.windows).toBe(2);
  });

  it("newWindow throws on missing session", async () => {
    await expect(client.newWindow("ghost")).rejects.toThrow(TmuxError);
  });

  it("listPanes returns default pane", async () => {
    const panes = await client.listPanes("work");
    expect(panes).toHaveLength(1);
    expect(panes[0]!.active).toBe(true);
  });

  it("sendKeys records sent keys", async () => {
    await client.sendKeys("work", "ls -la");
    expect(client.getSentKeys()[0]).toEqual({ target: "work", keys: "ls -la" });
  });

  it("sendKeys with enter appends newline", async () => {
    await client.sendKeys("work", "npm test", true);
    expect(client.getSentKeys()[0]!.keys).toBe("npm test\n");
  });

  it("runCommand records command with newline", async () => {
    await client.runCommand("work", "make build");
    expect(client.getSentKeys()[0]!.keys).toBe("make build\n");
  });

  it("capturePane returns seeded output", async () => {
    client.setPaneOutput("work", "$ hello world");
    const out = await client.capturePane("work");
    expect(out).toBe("$ hello world");
  });

  it("capturePane returns empty string for unknown session", async () => {
    expect(await client.capturePane("unknown")).toBe("");
  });

  it("capturePane works with pane-qualified target", async () => {
    client.setPaneOutput("work", "ready");
    const out = await client.capturePane("work:0.0");
    expect(out).toBe("ready");
  });

  it("waitForOutput resolves when pattern found immediately", async () => {
    client.setPaneOutput("work", "$ npm test passed");
    const out = await client.waitForOutput("work", /passed/);
    expect(out).toContain("passed");
  });

  it("waitForOutput works with string pattern", async () => {
    client.setPaneOutput("work", "build: SUCCESS");
    const out = await client.waitForOutput("work", "SUCCESS");
    expect(out).toContain("SUCCESS");
  });

  it("waitForOutput throws WAIT_TIMEOUT when pattern never matches", async () => {
    client.setPaneOutput("work", "nope");
    try {
      await client.waitForOutput("work", /done/, { timeoutMs: 50 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e instanceof TmuxError).toBe(true);
      expect((e as TmuxError).code).toBe("WAIT_TIMEOUT");
    }
  });

  it("clearSentKeys empties the queue", async () => {
    await client.sendKeys("work", "ls");
    client.clearSentKeys();
    expect(client.getSentKeys()).toHaveLength(0);
  });
});

// ── TmuxError ─────────────────────────────────────────────────────────────────

describe("TmuxError", () => {
  it("has correct name, code, and message", () => {
    const e = new TmuxError("session not found", "NO_SESSION");
    expect(e.name).toBe("TmuxError");
    expect(e.code).toBe("NO_SESSION");
    expect(e.message).toBe("session not found");
    expect(e instanceof Error).toBe(true);
  });
});
