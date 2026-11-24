// SPDX-License-Identifier: Apache-2.0
/**
 * `GET /api/context/symbols`: one shape whether an LSP server or the regex walk
 * answers, a 50-row cap, a 30 s cache, and invalidation after a write.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LspLanguage, LspManager, LspSymbol } from "@nexus/lsp";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { contextRoutes } = await import("../../src/routes/context.ts");
const { _resetLspForTests, _setLspManagerForTests } = await import("../../src/lib/lsp.ts");
const { _resetSymbolCacheForTests, invalidateSymbolCache } =
  await import("../../src/lib/symbols.ts");

const ROOT = mkdtempSync(join(tmpdir(), "nexus-symbols-"));

process.env.NEXUS_WORKSPACE_DIR = ROOT;
process.env.NEXUS_LSP = "1";
process.env.NEXUS_LSP_TYPESCRIPT_CMD = "fake-ls";

writeFileSync(join(ROOT, "a.ts"), "export function parseConfig() {}\n", "utf8");

const deps = {
  getMemory: () => {
    throw new Error("unused");
  },
  getScraper: () => {
    throw new Error("unused");
  },
  webSearch: async () => ({ results: [], provider: null }),
};

function symbol(name: string, kind = 12): LspSymbol {
  return { name, kind, path: join(ROOT, "a.ts"), line: 1, column: 1 };
}

function fakeManager(symbols: (query: string) => LspSymbol[]) {
  const workspaceSymbols = vi.fn(async (input: { query: string; language?: LspLanguage }) => ({
    ok: true as const,
    symbols: symbols(input.query),
    truncated: false,
  }));
  const manager = {
    workspaceSymbols,
    definition: vi.fn(),
    references: vi.fn(),
    hover: vi.fn(),
    documentSymbols: vi.fn(),
    diagnostics: vi.fn(),
    rename: vi.fn(),
    codeActions: vi.fn(),
    status: () => ({
      enabled: true,
      available: true,
      root: ROOT,
      servers: [
        {
          root: ROOT,
          language: "typescript" as const,
          health: "ready" as const,
          openDocuments: 0,
          lastUsedAt: 0,
          crashes: 0,
        },
      ],
    }),
    restart: async () => {},
    dispose: async () => {},
  } as unknown as LspManager;
  return { manager, workspaceSymbols };
}

let app: FastifyInstance;

beforeEach(async () => {
  _resetSymbolCacheForTests();
  _setLspManagerForTests(fakeManager(() => [symbol("fromServer")]).manager);
  process.env.NEXUS_LSP = "1";
  process.env.NEXUS_LSP_TYPESCRIPT_CMD = "fake-ls";
  await app?.close();
  app = Fastify();
  await contextRoutes(app, deps);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await _resetLspForTests();
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.NEXUS_WORKSPACE_DIR;
  delete process.env.NEXUS_LSP;
  delete process.env.NEXUS_LSP_TYPESCRIPT_CMD;
});

const search = (q: string) =>
  app.inject({ method: "GET", url: `/context/symbols?q=${encodeURIComponent(q)}` });

describe("GET /context/symbols", () => {
  it("returns LSP rows with source: lsp", async () => {
    const res = await search("fromServer");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([
      { name: "fromServer", type: "function", file: "a.ts", line: 1, source: "lsp" },
    ]);
  });

  it("falls back to the regex walk with source: regex", async () => {
    await _resetLspForTests();
    delete process.env.NEXUS_LSP;
    delete process.env.NEXUS_LSP_TYPESCRIPT_CMD;

    const res = await search("parseConfig");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([
      { name: "parseConfig", type: "function", file: "a.ts", line: 1, source: "regex" },
    ]);
  });

  it("uses one shape for both sources", async () => {
    const lsp = await search("fromServer");
    await _resetLspForTests();
    delete process.env.NEXUS_LSP;
    delete process.env.NEXUS_LSP_TYPESCRIPT_CMD;
    const regex = await search("parseConfig");

    const keys = (rows: unknown[]) =>
      rows.map((row) =>
        Object.keys(row as object)
          .sort()
          .join(","),
      );
    expect(keys(lsp.json())).toEqual(["file,line,name,source,type"]);
    expect(keys(regex.json())).toEqual(["file,line,name,source,type"]);
  });

  it("caps the merged answer at 50", async () => {
    _setLspManagerForTests(
      fakeManager((q) => Array.from({ length: 80 }, (_, i) => symbol(`${q}${i}`))).manager,
    );
    const res = await search("many");
    expect(res.json<unknown[]>()).toHaveLength(50);
  });

  it("caches per caller and query for 30 s", async () => {
    const { manager, workspaceSymbols } = fakeManager(() => [symbol("cached")]);
    _setLspManagerForTests(manager);

    expect((await search("cached")).json<unknown[]>()).toHaveLength(1);
    expect((await search("cached")).json<unknown[]>()).toHaveLength(1);
    expect(workspaceSymbols).toHaveBeenCalledTimes(1);
  });

  it("re-queries after a write invalidates the cache", async () => {
    const { manager, workspaceSymbols } = fakeManager(() => [symbol("edited")]);
    _setLspManagerForTests(manager);

    await search("edited");
    invalidateSymbolCache();
    await search("edited");
    expect(workspaceSymbols).toHaveBeenCalledTimes(2);
  });
});
