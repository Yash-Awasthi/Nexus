// SPDX-License-Identifier: Apache-2.0
/**
 * Real language-server integration. Each case skips with a reason when the
 * server binary is not installed, so CI without servers stays green while a
 * developer machine still proves definition, hover and diagnostics.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { LspCommand, LspConfig } from "./config.ts";
import type { LspLanguage } from "./languages.ts";
import { createLspManager, type LspManager } from "./manager.ts";

const isWindows = process.platform === "win32";

/** Locate an executable the way a shell would, honouring PATHEXT on Windows. */
function onPath(name: string): string | undefined {
  const exts = isWindows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(
        dir,
        name + (name.toLowerCase().endsWith(ext.toLowerCase()) ? "" : ext),
      );
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Operator-configured command wins, then PATH; absent means skip. */
function resolveServer(envName: string, binary: string, args: string[]): LspCommand | undefined {
  const configured = process.env[envName];
  if (configured) {
    const [command, ...rest] = configured.split(/\s+/);
    return { command, args: [...rest, ...args] };
  }
  const found = onPath(binary);
  return found ? { command: found, args } : undefined;
}

const tsServer = resolveServer("NEXUS_LSP_TYPESCRIPT_CMD", "typescript-language-server", [
  "--stdio",
]);
const pyServer = resolveServer("NEXUS_LSP_PYTHON_CMD", "pyright-langserver", ["--stdio"]);

let dir: string;
let managers: LspManager[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-lsp-real-"));
  managers = [];
});

afterEach(async () => {
  for (const manager of managers) await manager.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function managerWith(server: LspCommand, language: LspLanguage): LspManager {
  const manager = createLspManager({
    workingDir: dir,
    env: {},
    config: {
      enabled: true,
      commands: { typescript: server, python: server, go: server, rust: server },
      startTimeoutMs: 30_000,
      requestTimeoutMs: 20_000,
      diagnosticsWaitMs: 8_000,
    } satisfies Partial<LspConfig>,
    authorize: async () => "allow",
  });
  managers.push(manager);
  return manager;
}

const TS_FIXTURE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");
const TS_USER = [
  'import { add } from "./lib";',
  "",
  "export const total = add(1, 2);",
  "export const bad: string = add(1, 2);",
  "",
].join("\n");

describe("real typescript-language-server", () => {
  const run = tsServer ? it : it.skip;

  run(
    "answers definition, hover and diagnostics",
    async () => {
      write("lib.ts", TS_FIXTURE);
      const user = write("use.ts", TS_USER);
      const manager = managerWith(tsServer!, "typescript");

      const definition = await manager.definition({ path: user, line: 3, column: 22 });
      expect(definition.ok).toBe(true);
      if (definition.ok) {
        expect(definition.locations.length).toBeGreaterThan(0);
        expect(definition.locations[0]?.path.endsWith("lib.ts")).toBe(true);
      }

      const hover = await manager.hover({ path: user, line: 3, column: 22 });
      expect(hover.ok).toBe(true);
      if (hover.ok) expect(hover.contents.toLowerCase()).toContain("add");

      const diagnostics = await manager.diagnostics({ path: user });
      expect(diagnostics.ok).toBe(true);
      if (diagnostics.ok) {
        expect(diagnostics.diagnostics.some((d) => d.message.includes("string"))).toBe(true);
      }
    },
    60_000,
  );

  run(
    "writes nothing on rename",
    async () => {
      write("lib.ts", TS_FIXTURE);
      const user = write("use.ts", TS_USER);
      const before = TS_USER;
      const manager = managerWith(tsServer!, "typescript");
      const edit = await manager.rename({ path: user, line: 3, column: 22, newName: "sum" });
      expect(edit.ok).toBe(true);
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(user, "utf8")).toBe(before);
    },
    60_000,
  );
});

describe("real pyright-langserver", () => {
  const run = pyServer ? it : it.skip;

  run(
    "answers definition and diagnostics",
    async () => {
      write("lib.py", "def add(a: int, b: int) -> int:\n    return a + b\n");
      const user = write(
        "use.py",
        "from lib import add\n\ntotal: int = add(1, 2)\nbad: str = add(1, 2)\n",
      );
      const manager = managerWith(pyServer!, "python");

      const definition = await manager.definition({ path: user, line: 3, column: 16 });
      expect(definition.ok).toBe(true);
      if (definition.ok) expect(definition.locations[0]?.path.endsWith("lib.py")).toBe(true);

      const diagnostics = await manager.diagnostics({ path: user });
      expect(diagnostics.ok).toBe(true);
    },
    60_000,
  );
});

describe("process hygiene", () => {
  it("leaves no server entry after dispose", async () => {
    const manager = createLspManager({
      workingDir: dir,
      env: {},
      config: {
        enabled: true,
        commands: {
          typescript: { command: process.execPath, args: [join(dir, "missing.mjs")] },
          python: { command: process.execPath, args: [] },
          go: { command: process.execPath, args: [] },
          rust: { command: process.execPath, args: [] },
        },
      },
      authorize: async () => "allow",
    });
    managers.push(manager);
    await manager.dispose();
    expect(manager.status().servers).toHaveLength(0);
  });
});
