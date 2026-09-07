// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { FilesystemSandbox, SandboxConstraint } from "../src/filesystem-sandbox.js";

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-"));
});

afterEach(() => {
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

describe("SandboxConstraint", () => {
  it("accepts writes inside the prefix within the byte budget", () => {
    const c = new SandboxConstraint(100, sandboxDir);
    expect(c.validateWrite(path.join(sandboxDir, "a.txt"), 40, 30)).toBe(true);
  });

  it("rejects writes outside the prefix or over the budget", () => {
    const c = new SandboxConstraint(100, sandboxDir);
    expect(c.validateWrite(path.join(os.tmpdir(), "outside.txt"), 5, 0)).toBe(false);
    expect(c.validateWrite(path.join(sandboxDir, "a.txt"), 101, 0)).toBe(false);
    expect(c.validateWrite(path.join(sandboxDir, "a.txt"), 70, 40)).toBe(false);
  });
});

describe("FilesystemSandbox", () => {
  it("creates the sandbox root on construction", () => {
    const nested = path.join(sandboxDir, "root");
    const sandbox = new FilesystemSandbox(nested, new SandboxConstraint(1024, nested));
    expect(fs.existsSync(nested)).toBe(true);
    return sandbox.cleanup();
  });

  it("writes, reads, deletes files and tracks the write log", async () => {
    const constraint = new SandboxConstraint(1024, sandboxDir);
    const sandbox = new FilesystemSandbox(sandboxDir, constraint);
    const target = path.join(sandboxDir, "sub", "f.txt");
    await sandbox.writeFile(target, "hello world");
    expect(await sandbox.readFile(target)).toBe("hello world");
    expect(sandbox.getWriteLog()).toHaveLength(1);
    expect(sandbox.getWriteLog()[0].bytes).toBe(11);
    await sandbox.deleteFile(target);
    await expect(sandbox.readFile(target)).rejects.toThrow(/not found/);
  });

  it("creates directories and rejects out-of-bounds paths", async () => {
    const sandbox = new FilesystemSandbox(sandboxDir, new SandboxConstraint(1024, sandboxDir));
    const created = await sandbox.createDirectory("deep/nested");
    expect(fs.existsSync(created)).toBe(true);
    await expect(sandbox.createDirectory("../escape")).rejects.toThrow(/Path violation/);
  });

  it("enforces read/delete/write sandbox boundaries", async () => {
    const sandbox = new FilesystemSandbox(sandboxDir, new SandboxConstraint(4, sandboxDir));
    await expect(sandbox.writeFile(path.join(sandboxDir, "big.txt"), "too big for quota")).rejects.toThrow(
      /Write violation/,
    );
    const outside = path.join(os.tmpdir(), "outside-file.txt");
    fs.writeFileSync(outside, "x");
    try {
      await expect(sandbox.readFile(outside)).rejects.toThrow(/Read violation/);
      await expect(sandbox.deleteFile(outside)).rejects.toThrow(/Delete violation/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("cleanup removes the sandbox root", async () => {
    const sandbox = new FilesystemSandbox(sandboxDir, new SandboxConstraint(1024, sandboxDir));
    await sandbox.writeFile(path.join(sandboxDir, "x.txt"), "data");
    await sandbox.cleanup();
    expect(fs.existsSync(sandboxDir)).toBe(false);
  });
});
