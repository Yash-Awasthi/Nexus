// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Runner, RunnerResult } from "./index.js";
import { ShellSession, QUIET_SHELL_PRESETS, filterOutput } from "./shell-session.js";

/** Deterministic fake runner recording cwd-tracking + filter behavior. */
function makeRunner(record: string[]): Runner {
  return async (_cmd, args, opts): Promise<RunnerResult> => {
    record.push(args.join(" "));
    void opts;
    return { stdout: "line1\nWARN noisy\nline2\n", stderr: "", exitCode: 0, timedOut: false };
  };
}

describe("filterOutput", () => {
  it("passes text through untouched when no rules are given", () => {
    expect(filterOutput("a\nb\nc")).toBe("a\nb\nc");
  });

  it("drops matching lines and keeps everything else", () => {
    const drop = [/^WARN /, /^error:/];
    expect(filterOutput("a\nWARN noisy\nb\nerror: boom\nc", { drop })).toBe("a\nb\nc");
  });

  it("keep rules win over drop rules", () => {
    const rules = { drop: [/WARN/], keep: [/important/] };
    expect(filterOutput("WARN noisy\nWARN important\nplain", rules)).toBe("WARN important\nplain");
  });

  it("include rules switch to quiet-shell whitelist mode", () => {
    const out = filterOutput("line1\nwarn: something\nerror: boom\nline2\nFound 3 errors", {
      include: [/(error|Found \d+ errors)/],
    });
    expect(out).toBe("error: boom\nFound 3 errors");
  });

  it("tail paragraphs survive even when they match nothing", () => {
    const out = filterOutput("warn: noisy\nnote: spam\n\nBUILD SUCCESS\nDone in 1.2s", {
      include: [/warn/],
      tailParagraphs: 1,
    });
    expect(out).toBe("warn: noisy\nBUILD SUCCESS\nDone in 1.2s");
  });

  it("presets mirror quiet-shell tool templates", () => {
    const out = filterOutput(
      "tsc: no inputs\nerror TS2322: type mismatch\n\nFound 1 error",
      QUIET_SHELL_PRESETS.tsc!,
    );
    expect(out).toContain("error TS2322: type mismatch");
    expect(out).toContain("Found 1 error");
    expect(out).not.toContain("tsc: no inputs");
  });
});

describe("ShellSession", () => {
  it("tracks cwd across pure cd builtins without spawning", async () => {
    const record: string[] = [];
    const s = new ShellSession({ runner: makeRunner(record) });
    await s.exec("cd /tmp/project");
    expect(s.workingDirectory).toBe("/tmp/project");
    await s.exec("cd src");
    expect(s.workingDirectory).toBe("/tmp/project/src");
    await s.exec("cd ..");
    expect(s.workingDirectory).toBe("/tmp/project");
    expect(record).toEqual([]); // no process spawned for pure cd
  });

  it("prefixes non-cd commands with the tracked cwd", async () => {
    const record: string[] = [];
    const s = new ShellSession({ runner: makeRunner(record), initialCwd: "/app" });
    await s.exec("npm test");
    expect(record[0]).toContain('cd "/app"');
    expect(record[0]).toContain("npm test");
  });

  it("filters output through the configured rules and reports exit code", async () => {
    const s = new ShellSession({
      runner: makeRunner([]),
      filter: { drop: [/WARN/] },
    });
    const res = await s.exec("make build");
    expect(res.stdout).toBe("line1\nline2\n");
    expect(res.exitCode).toBe(0);
    expect(res.cwd).toBe(s.workingDirectory);
  });

  it("truncates filtered output over maxOutputChars", async () => {
    const s = new ShellSession({
      runner: makeRunner([]),
      maxOutputChars: 8,
    });
    const res = await s.exec("make build");
    expect(res.stdout).toContain("[output truncated]");
    expect(res.stdout.length).toBeLessThan(40);
  });
});
