// SPDX-License-Identifier: Apache-2.0
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AUTO_ALLOWED_TOOLS,
  classifyTool,
  createEditFileTool,
  createFilesystemTools,
  createRunCommandTool,
  globToRegExp,
  resolveInWorkspace,
  RuntimeToolSet,
  type CommandExecutor,
  type RuntimeTool,
} from "../src/index.js";

// A throwaway workspace tree shared by the read tests.
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-fs-tools-"));
  await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, "readme.md"), "# Title\nhello world\nsecond line\n");
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n// TODO: refactor\n");
  await fs.writeFile(path.join(root, "src", "nested", "b.ts"), "export const b = 2;\n");
  await fs.writeFile(path.join(root, "src", "c.json"), '{"k":"v"}\n');
  await fs.writeFile(path.join(root, "node_modules", "pkg", "index.ts"), "TODO ignored\n");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function tools(): Record<string, RuntimeTool> {
  return Object.fromEntries(createFilesystemTools().map((t) => [t.name, t]));
}

describe("resolveInWorkspace", () => {
  it("resolves a relative path inside the root", () => {
    expect(resolveInWorkspace("/ws", "src/a.ts")).toBe(path.resolve("/ws/src/a.ts"));
  });

  it("allows the root itself", () => {
    expect(resolveInWorkspace("/ws", ".")).toBe(path.resolve("/ws"));
  });

  it("rejects `..` traversal that escapes the root", () => {
    expect(() => resolveInWorkspace("/ws", "../etc/passwd")).toThrow(/escapes workspace/);
    expect(() => resolveInWorkspace("/ws", "src/../../secret")).toThrow(/escapes workspace/);
  });

  it("rejects absolute paths outside the root", () => {
    expect(() => resolveInWorkspace("/ws", "/etc/passwd")).toThrow(/escapes workspace/);
  });
});

describe("globToRegExp", () => {
  it("matches `*` within a single segment only", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
  });

  it("matches `**` across path separators", () => {
    expect(globToRegExp("**/*.ts").test("src/nested/b.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("b.ts")).toBe(true);
  });

  it("escapes regex metacharacters literally", () => {
    expect(globToRegExp("a.(b)").test("a.(b)")).toBe(true);
    expect(globToRegExp("a.(b)").test("axxbx")).toBe(false);
  });
});

describe("createFilesystemTools — names auto-allow", () => {
  it("every tool name is in AUTO_ALLOWED_TOOLS", () => {
    for (const t of createFilesystemTools()) {
      expect(AUTO_ALLOWED_TOOLS.has(t.name)).toBe(true);
      expect(classifyTool(t.name)).toBe("auto_allowed");
    }
  });
});

describe("read_file", () => {
  it("reads full file contents", async () => {
    const out = await tools().read_file.handler({ path: "readme.md" }, { workingDir: root });
    expect(out).toBe("# Title\nhello world\nsecond line\n");
  });

  it("honours offset/limit line slicing", async () => {
    const out = await tools().read_file.handler({ path: "readme.md", offset: 1, limit: 1 }, { workingDir: root });
    expect(out).toBe("hello world");
  });

  it("rejects a path escaping the workspace", async () => {
    await expect(tools().read_file.handler({ path: "../outside" }, { workingDir: root })).rejects.toThrow(
      /escapes workspace/,
    );
  });

  it("throws when no workspace root is set", async () => {
    await expect(tools().read_file.handler({ path: "readme.md" }, {})).rejects.toThrow(/workspace root/);
  });
});

describe("list_files", () => {
  it("lists the root non-recursively with dir markers", async () => {
    const out = (await tools().list_files.handler({}, { workingDir: root })) as string[];
    expect(out).toContain("readme.md");
    expect(out).toContain("src/");
    expect(out).toContain("node_modules/");
  });

  it("recurses and skips ignored dirs", async () => {
    const out = (await tools().list_files.handler({ recursive: true }, { workingDir: root })) as string[];
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/nested/b.ts");
    expect(out.some((p) => p.includes("node_modules"))).toBe(false);
  });
});

describe("glob", () => {
  it("finds files matching a `**` pattern, sorted, skipping node_modules", async () => {
    const out = (await tools().glob.handler({ pattern: "**/*.ts" }, { workingDir: root })) as string[];
    expect(out).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("scopes the search to `path`", async () => {
    const out = (await tools().glob.handler({ pattern: "*.ts", path: "src/nested" }, { workingDir: root })) as string[];
    expect(out).toEqual(["src/nested/b.ts"]);
  });
});

describe("grep", () => {
  it("returns {file,line,text} matches", async () => {
    const out = (await tools().grep.handler({ pattern: "TODO" }, { workingDir: root })) as Array<{
      file: string;
      line: number;
      text: string;
    }>;
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("src/a.ts");
    expect(out[0].line).toBe(2);
    expect(out[0].text).toContain("TODO");
  });

  it("filters scanned files by glob", async () => {
    const out = (await tools().grep.handler({ pattern: "k", glob: "**/*.json" }, { workingDir: root })) as Array<{
      file: string;
    }>;
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("src/c.json");
  });

  it("respects an aborted signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      tools().grep.handler({ pattern: "x" }, { workingDir: root, signal: ctrl.signal }),
    ).rejects.toThrow(/aborted/);
  });
});

describe("edit_file", () => {
  // Each test gets its own scratch dir so writes don't perturb the shared read fixtures.
  let ws: string;
  beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-fs-edit-"));
  });
  afterAll(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("is gated (requires_permission, not auto-allowed)", () => {
    const t = createEditFileTool();
    expect(t.name).toBe("edit_file");
    expect(AUTO_ALLOWED_TOOLS.has("edit_file")).toBe(false);
    expect(classifyTool("edit_file")).toBe("requires_permission");
  });

  it("replaces a unique occurrence and writes back", async () => {
    const f = path.join(ws, "u.txt");
    await fs.writeFile(f, "alpha beta gamma\n");
    const res = await createEditFileTool().handler(
      { path: "u.txt", old_string: "beta", new_string: "BETA" },
      { workingDir: ws },
    );
    expect(res).toEqual({ path: "u.txt", replaced: 1 });
    expect(await fs.readFile(f, "utf8")).toBe("alpha BETA gamma\n");
  });

  it("rejects a non-unique old_string unless replace_all", async () => {
    const f = path.join(ws, "dup.txt");
    await fs.writeFile(f, "x x x\n");
    await expect(
      createEditFileTool().handler({ path: "dup.txt", old_string: "x", new_string: "y" }, { workingDir: ws }),
    ).rejects.toThrow(/not unique/);
    const res = await createEditFileTool().handler(
      { path: "dup.txt", old_string: "x", new_string: "y", replace_all: true },
      { workingDir: ws },
    );
    expect(res).toEqual({ path: "dup.txt", replaced: 3 });
    expect(await fs.readFile(f, "utf8")).toBe("y y y\n");
  });

  it("throws when old_string is absent", async () => {
    const f = path.join(ws, "n.txt");
    await fs.writeFile(f, "nothing here\n");
    await expect(
      createEditFileTool().handler({ path: "n.txt", old_string: "zzz", new_string: "q" }, { workingDir: ws }),
    ).rejects.toThrow(/not found/);
  });

  it("rejects a path escaping the workspace", async () => {
    await expect(
      createEditFileTool().handler({ path: "../evil", old_string: "a", new_string: "b" }, { workingDir: ws }),
    ).rejects.toThrow(/escapes workspace/);
  });
});

describe("run_command", () => {
  it("is gated (requires_permission, not auto-allowed)", () => {
    const t = createRunCommandTool(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }));
    expect(t.name).toBe("run_command");
    expect(AUTO_ALLOWED_TOOLS.has("run_command")).toBe(false);
    expect(classifyTool("run_command")).toBe("requires_permission");
  });

  it("delegates to the injected executor, forwarding cwd/timeout/signal", async () => {
    const calls: Array<{ command: string; opts: unknown }> = [];
    const exec: CommandExecutor = async (command, opts) => {
      calls.push({ command, opts });
      return { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false };
    };
    const ctrl = new AbortController();
    const out = await createRunCommandTool(exec).handler(
      { command: "echo ok", timeout_ms: 5000 },
      { workingDir: "/ws", signal: ctrl.signal },
    );
    expect(out).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("echo ok");
    expect(calls[0].opts).toEqual({ cwd: "/ws", timeoutMs: 5000, signal: ctrl.signal });
  });

  it("omits timeout when not provided", async () => {
    let seen: { timeoutMs?: number } | undefined;
    const exec: CommandExecutor = async (_c, opts) => {
      seen = opts;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    await createRunCommandTool(exec).handler({ command: "ls" }, { workingDir: "/ws" });
    expect(seen?.timeoutMs).toBeUndefined();
  });

  it("surfaces a non-zero exit / timeout result verbatim", async () => {
    const exec: CommandExecutor = async () => ({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false });
    const out = (await createRunCommandTool(exec).handler({ command: "false" }, { workingDir: "/ws" })) as {
      exitCode: number;
      stderr: string;
    };
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe("boom");
  });

  it("rejects an already-aborted signal before executing", async () => {
    let ran = false;
    const exec: CommandExecutor = async () => {
      ran = true;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      createRunCommandTool(exec).handler({ command: "x" }, { workingDir: "/ws", signal: ctrl.signal }),
    ).rejects.toThrow(/aborted/);
    expect(ran).toBe(false);
  });
});

describe("integration with RuntimeToolSet", () => {
  it("registers and invokes as auto-allowed tools", async () => {
    const set = new RuntimeToolSet();
    for (const t of createFilesystemTools()) set.add(t);
    expect(set.names().sort()).toEqual(["glob", "grep", "list_files", "read_file"]);
    const res = await set.invoke("read_file", { path: "readme.md" }, { workingDir: root });
    expect(res.error).toBeUndefined();
    expect(res.output).toContain("hello world");
  });
});
