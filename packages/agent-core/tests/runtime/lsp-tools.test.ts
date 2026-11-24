// SPDX-License-Identifier: Apache-2.0
/**
 * LSP tools through the real manager and the fake language server: one call
 * per tool, permission classification, flag/root gating, a missing binary, and
 * the `lsp.language` / `lsp.operation` span attributes.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createLspManager, type LspCommand, type LspLanguage, type LspManager } from "@nexus/lsp";
import { startTracing, stopTracing } from "@nexus/telemetry";

import { classifyTool, type RuntimeTool } from "../../src/runtime/index.ts";
import { createLspRuntime, createLspTools } from "../../src/runtime/lsp-tools.ts";

const FAKE_SERVER = fileURLToPath(
  new URL("../../../lsp/src/testing/fake-server.mjs", import.meta.url),
);

interface EndedSpan {
  name: string;
  attributes: Record<string, unknown>;
}

const ended: EndedSpan[] = [];
const exporter = {
  export: (spans: EndedSpan[], done: (result: { code: number }) => void) => {
    ended.push(...spans);
    done({ code: 0 });
  },
  shutdown: () => Promise.resolve(),
  forceFlush: () => Promise.resolve(),
};
startTracing("nexus-agent-core-lsp-test", exporter);

afterAll(async () => {
  await stopTracing();
});

let dir: string;
let manager: LspManager;
let tools: Map<string, RuntimeTool>;

function fake(extra: string[] = []): LspCommand {
  return { command: process.execPath, args: [FAKE_SERVER, ...extra] };
}

function allCommands(extra: string[] = []): Record<LspLanguage, LspCommand> {
  return {
    typescript: fake(extra),
    python: fake(extra),
    go: fake(extra),
    rust: fake(extra),
  };
}

function makeManager(): LspManager {
  return createLspManager({
    workingDir: dir,
    env: {},
    authorize: () => "allow",
    config: { enabled: true, commands: allCommands() },
  });
}

function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.handler(args);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-agent-lsp-"));
  writeFileSync(join(dir, "main.ts"), "const value = 1;\nconst other = value;\n");
  writeFileSync(join(dir, "main.py"), "value = 1\n");
  manager = makeManager();
  tools = new Map(createLspTools({ root: dir, manager }).map((tool) => [tool.name, tool]));
});

afterEach(async () => {
  await manager.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("lsp tools", () => {
  it("classifies the five read-only tools as auto-allowed and two as gated", () => {
    for (const name of [
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_document_symbols",
      "lsp_diagnostics",
    ]) {
      expect(classifyTool(name)).toBe("auto_allowed");
    }
    expect(classifyTool("lsp_rename")).toBe("requires_permission");
    expect(classifyTool("lsp_code_actions")).toBe("requires_permission");
  });

  it("returns normalised definition locations", async () => {
    const result = (await call("lsp_definition", {
      path: "main.ts",
      line: 1,
      column: 1,
    })) as {
      locations: { path: string; line: number; column: number; preview: string }[];
      truncated: boolean;
    };
    expect(result.truncated).toBe(false);
    expect(result.locations[0]).toMatchObject({ path: "main.ts", line: 1, column: 1 });
    expect(result.locations[0]?.preview).toBe("const value = 1;");
  });

  it("returns references through the manager", async () => {
    const result = (await call("lsp_references", {
      path: "main.ts",
      line: 1,
      column: 1,
    })) as { locations: { path: string; line: number }[]; truncated: boolean };
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]).toMatchObject({ path: "main.ts", line: 1 });
  });

  it("returns hover text", async () => {
    const result = (await call("lsp_hover", {
      path: "main.ts",
      line: 1,
      column: 1,
    })) as { contents: string; truncated: boolean };
    expect(result.contents).toBe("fake hover");
    expect(result.truncated).toBe(false);
  });

  it("returns document symbols", async () => {
    const result = (await call("lsp_document_symbols", { path: "main.ts" })) as {
      symbols: { name: string; kind: number; path?: string; line: number; column: number }[];
      truncated: boolean;
    };
    expect(result.symbols[0]).toMatchObject({
      name: "fakeSymbol",
      kind: 12,
      path: "main.ts",
      line: 1,
      column: 1,
    });
    expect(result.truncated).toBe(false);
  });

  it("returns diagnostics without mutating the file", async () => {
    const before = readFileSync(join(dir, "main.ts"), "utf8");
    const result = (await call("lsp_diagnostics", { path: "main.ts" })) as {
      diagnostics: {
        path: string;
        line: number;
        column: number;
        severity: string;
        message: string;
      }[];
      stale: boolean;
      truncated: boolean;
    };
    expect(result.diagnostics[0]).toMatchObject({
      path: "main.ts",
      line: 1,
      column: 1,
      severity: "error",
      message: "fake diagnostic",
    });
    expect(result.stale).toBe(false);
    expect(readFileSync(join(dir, "main.ts"), "utf8")).toBe(before);
  });

  it("returns a rename edit and never writes", async () => {
    const before = readFileSync(join(dir, "main.ts"), "utf8");
    const result = (await call("lsp_rename", {
      path: "main.ts",
      line: 1,
      column: 1,
      new_name: "renamed",
    })) as {
      edits: {
        path: string;
        range: { start: { line: number; column: number } };
        newText: string;
      }[];
      applied: boolean;
      truncated: boolean;
    };
    expect(result.applied).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.edits[0]).toMatchObject({
      path: "main.ts",
      newText: "renamed",
      range: { start: { line: 1, column: 1 } },
    });
    expect(readFileSync(join(dir, "main.ts"), "utf8")).toBe(before);
  });

  it("lists code actions without executing them", async () => {
    const before = readFileSync(join(dir, "main.ts"), "utf8");
    const result = (await call("lsp_code_actions", {
      path: "main.ts",
      line: 1,
      column: 1,
    })) as {
      actions: { title: string; kind?: string; edits: { newText: string }[] }[];
      applied: boolean;
      truncated: boolean;
    };
    expect(result.applied).toBe(false);
    expect(result.actions[0]).toMatchObject({ title: "Fake fix", kind: "quickfix" });
    expect(result.actions[0]?.edits[0]?.newText).toBe("fixed");
    expect(readFileSync(join(dir, "main.ts"), "utf8")).toBe(before);
  });

  it("emits tool spans with lsp.language and lsp.operation", async () => {
    ended.length = 0;
    await call("lsp_definition", { path: "main.ts", line: 1, column: 1 });
    const span = ended.find(
      (entry) => entry.name === "tool.call" && entry.attributes["tool.name"] === "lsp_definition",
    );
    expect(span).toBeDefined();
    expect(span!.attributes["lsp.language"]).toBe("typescript");
    expect(span!.attributes["lsp.operation"]).toBe("definition");
  });
});

describe("lsp runtime wiring", () => {
  it("builds the toolset only when NEXUS_LSP=1 and a root resolves", () => {
    const off = createLspRuntime({ env: {}, workingDir: dir });
    expect(off).toBeUndefined();

    const on = createLspRuntime({
      env: { NEXUS_LSP: "1" },
      workingDir: dir,
      config: { commands: allCommands() },
    });
    expect(on).toBeDefined();
    expect(on!.root).toBe(dir);
    expect(on!.tools.map((tool) => tool.name)).toEqual([
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_document_symbols",
      "lsp_diagnostics",
      "lsp_rename",
      "lsp_code_actions",
    ]);
    void on!.dispose();
  });

  it("names the variable for a missing binary while other languages work", async () => {
    const runtime = createLspRuntime({
      env: {
        NEXUS_LSP: "1",
        NEXUS_LSP_TYPESCRIPT_CMD: `"${process.execPath}" "${FAKE_SERVER}"`,
        NEXUS_LSP_PYTHON_CMD: join(dir, "missing-pyright-langserver"),
        NEXUS_LSP_GO_CMD: `"${process.execPath}" "${FAKE_SERVER}"`,
        NEXUS_LSP_RUST_CMD: `"${process.execPath}" "${FAKE_SERVER}"`,
      },
      workingDir: dir,
    });
    expect(runtime).toBeDefined();
    const localTools = new Map(runtime!.tools.map((tool) => [tool.name, tool]));
    await expect(
      localTools.get("lsp_definition")!.handler({ path: "main.py", line: 1, column: 1 }),
    ).rejects.toThrow(/NEXUS_LSP_PYTHON_CMD/);

    const ts = (await localTools
      .get("lsp_definition")!
      .handler({ path: "main.ts", line: 1, column: 1 })) as { locations: unknown[] };
    expect(ts.locations).toHaveLength(1);
    await runtime!.dispose();
  });
});
