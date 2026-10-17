// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createCodingToolSet, shellNote } from "../../src/handlers/agent-tools.ts";

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "run-command-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const run = async (dir: string, command: string, commandTimeoutMs: number) =>
  (
    await createCodingToolSet({ rootDir: dir, commandTimeoutMs }).invoke(
      "run_command",
      { command },
      { workingDir: dir },
    )
  ).output as string;

describe("run_command", () => {
  it("gives a command that waits for input an immediate end of input", async () => {
    const dir = workspace({
      "ask.js": "process.stdin.on('end', () => console.log('no answer')).resume();",
    });
    const t0 = Date.now();
    const out = await run(dir, "node ask.js", 10_000);
    expect(out).toContain("no answer");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("stops the processes a command started when it times out", async () => {
    const dir = workspace({
      "child.js":
        "setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 2000); setInterval(() => {}, 1000);",
      "parent.js":
        "require('child_process').spawn(process.execPath, ['child.js'], { stdio: 'inherit' }); setInterval(() => {}, 1000);",
    });
    const out = await run(dir, "node parent.js", 500);
    expect(out).toContain("killed after 500ms");
    await new Promise((r) => setTimeout(r, 3_000));
    expect(existsSync(join(dir, "late.txt"))).toBe(false);
  }, 10_000);
});

describe("run_command on a small host", () => {
  it("refuses instead of letting a package install exhaust the server's memory", async () => {
    vi.spyOn(process, "constrainedMemory").mockReturnValue(512 * 1024 * 1024);
    try {
      const dir = workspace({});
      const out = await run(dir, "node -e \"require('fs').writeFileSync('ran.txt','x')\"", 10_000);
      expect(out).toMatch(/512 MB/);
      expect(existsSync(join(dir, "ran.txt"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("shellNote", () => {
  it("tells the model which shell runs its commands", () => {
    expect(shellNote(undefined, "win32")).toContain("cmd.exe");
    expect(shellNote(undefined, "linux")).toContain("/bin/sh");
    expect(shellNote({}, "win32")).toContain("/bin/sh");
  });
});
