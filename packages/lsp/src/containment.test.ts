// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { containFile, resolveWorkspaceRoot } from "./containment.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-lsp-contain-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mkdir(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function mkfile(name: string, content = "const x = 1;\n"): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("resolveWorkspaceRoot", () => {
  it("prefers the tool-context working directory", () => {
    const context = mkdir("context");
    const result = resolveWorkspaceRoot({
      workingDir: context,
      lspRoots: [mkdir("lsp")],
      workspaceDir: mkdir("workspace"),
    });
    expect(result).toMatchObject({ available: true, source: "context", root: context });
  });

  it("falls back to NEXUS_LSP_ROOTS", () => {
    const lsp = mkdir("lsp");
    const result = resolveWorkspaceRoot({
      env: { NEXUS_LSP_ROOTS: lsp, NEXUS_WORKSPACE_DIR: mkdir("workspace") },
    });
    expect(result).toMatchObject({ available: true, source: "lsp", root: lsp });
  });

  it("falls back to NEXUS_EXEC_ROOTS", () => {
    const exec = mkdir("exec");
    const result = resolveWorkspaceRoot({
      env: { NEXUS_EXEC_ROOTS: exec, NEXUS_WORKSPACE_DIR: mkdir("workspace") },
    });
    expect(result).toMatchObject({ available: true, source: "exec", root: exec });
  });

  it("falls back to NEXUS_WORKSPACE_DIR", () => {
    const workspace = mkdir("workspace");
    const result = resolveWorkspaceRoot({ env: { NEXUS_WORKSPACE_DIR: workspace } });
    expect(result).toMatchObject({ available: true, source: "workspace", root: workspace });
  });

  it("reports unavailable when no root is configured", () => {
    const result = resolveWorkspaceRoot({ env: {} });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.code).toBe("NO_ROOT");
  });

  it("refuses a root outside a non-empty NEXUS_EXEC_ROOTS", () => {
    const context = mkdir("context");
    const exec = mkdir("exec");
    const result = resolveWorkspaceRoot({
      workingDir: context,
      env: { NEXUS_EXEC_ROOTS: exec },
    });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.code).toBe("ROOT_OUTSIDE_EXEC_ROOTS");
  });
});

describe("containFile", () => {
  it("returns a canonical file inside the root", () => {
    const root = mkdir("root");
    const file = join(root, "inside.ts");
    writeFileSync(file, "const x = 1;\n");
    const result = containFile({ path: file, root, maxFileBytes: 1_000 });
    expect(result).toMatchObject({ ok: true, relative: "inside.ts" });
  });

  it("refuses a .. escape", () => {
    const root = mkdir("root");
    const outside = mkfile("outside.ts");
    const result = containFile({
      path: join(root, "..", "outside.ts"),
      root,
      maxFileBytes: 1_000,
    });
    expect(result).toMatchObject({ ok: false, code: "OUTSIDE_ROOT" });
    expect(outside).toContain("outside.ts");
  });

  it("refuses an absolute path outside the root, including another user's root", () => {
    const root = mkdir("root");
    const other = mkdir("other-user-root");
    const outside = join(other, "secret.ts");
    writeFileSync(outside, "const secret = 1;\n");
    expect(containFile({ path: outside, root, maxFileBytes: 1_000 })).toMatchObject({
      ok: false,
      code: "OUTSIDE_ROOT",
    });
  });

  it("refuses a symlink that resolves outside the root", () => {
    const root = mkdir("root");
    const outside = mkfile("outside.ts");
    const link = join(root, "link.ts");
    try {
      symlinkSync(outside, link, "file");
    } catch {
      return; // Windows without developer mode cannot create file symlinks.
    }
    expect(containFile({ path: link, root, maxFileBytes: 1_000 })).toMatchObject({
      ok: false,
      code: "OUTSIDE_ROOT",
    });
  });

  it("refuses a directory", () => {
    const root = mkdir("root");
    const folder = mkdir("root/folder.ts");
    expect(containFile({ path: folder, root, maxFileBytes: 1_000 })).toMatchObject({
      ok: false,
      code: "NOT_A_FILE",
    });
  });

  it("treats a shell metacharacter in the file name as one path", () => {
    const root = mkdir("root");
    const name = "a;touch pwned.ts";
    writeFileSync(join(root, name), "const x = 1;\n");
    expect(containFile({ path: join(root, name), root, maxFileBytes: 1_000 })).toMatchObject({
      ok: true,
      relative: name,
    });
  });

  it("refuses a file above NEXUS_LSP_MAX_FILE_BYTES", () => {
    const root = mkdir("root");
    const file = join(root, "big.ts");
    writeFileSync(file, "x".repeat(2_000));
    expect(containFile({ path: file, root, maxFileBytes: 1_000 })).toMatchObject({
      ok: false,
      code: "TOO_LARGE",
    });
  });

  it("refuses a root outside a non-empty exec-root list", () => {
    const root = mkdir("root");
    const exec = mkdir("exec");
    const file = join(root, "inside.ts");
    writeFileSync(file, "const x = 1;\n");
    expect(containFile({ path: file, root, execRoots: [exec], maxFileBytes: 1_000 })).toMatchObject(
      { ok: false, code: "ROOT_OUTSIDE_EXEC_ROOTS" },
    );
  });
});
