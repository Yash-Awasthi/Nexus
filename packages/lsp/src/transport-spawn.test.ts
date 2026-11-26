// SPDX-License-Identifier: Apache-2.0
/** The availability probe and the spawn must agree on npm's Windows shims. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveSpawn } from "./transport.ts";

describe("resolveSpawn", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "nexus-lsp-spawn-"));
    dirs.push(dir);
    return dir;
  }

  it.runIf(process.platform === "win32")("routes an npm .cmd shim through cmd.exe", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "fake-lsp.cmd"), "@echo off\r\n");
    const resolved = resolveSpawn("fake-lsp", ["--stdio"], {
      PATH: dir,
      PATHEXT: ".CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(resolved.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(resolved.windowsVerbatimArguments).toBe(true);
    expect(resolved.args.at(-1)?.toLowerCase()).toContain("fake-lsp.cmd");
    expect(resolved.args.at(-1)).toContain("--stdio");
  });

  it.runIf(process.platform === "win32")("passes an .exe through without a shell", () => {
    const dir = tempDir();
    const exe = join(dir, "fake-lsp.exe");
    writeFileSync(exe, "");
    const resolved = resolveSpawn("fake-lsp", ["--stdio"], { PATH: dir, PATHEXT: ".EXE" });
    expect(resolved.command.toLowerCase()).toBe(exe.toLowerCase());
    expect(resolved.args).toEqual(["--stdio"]);
    expect(resolved.windowsVerbatimArguments).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("leaves a POSIX command unchanged", () => {
    expect(resolveSpawn("node", ["--version"], { PATH: "/usr/bin" })).toEqual({
      command: "node",
      args: ["--version"],
    });
  });
});
