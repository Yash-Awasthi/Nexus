// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  parseFile,
  buildCodeMap,
  searchSymbol,
  getImporters,
  getExportedBy,
  listAllSymbols,
  getSymbolsByKind,
  getFileIndex,
  type SourceFile,
} from "../src/index.js";

// buildCodeMap takes SourceFile[] = { path, content }[]

// ── detectLanguage ────────────────────────────────────────────────────────────

describe("detectLanguage", () => {
  it("detects TypeScript from .ts", () => { expect(detectLanguage("src/index.ts")).toBe("typescript"); });
  it("detects TypeScript from .tsx", () => { expect(detectLanguage("App.tsx")).toBe("typescript"); });
  it("detects JavaScript from .js", () => { expect(detectLanguage("util.js")).toBe("javascript"); });
  it("detects JavaScript from .mjs", () => { expect(detectLanguage("worker.mjs")).toBe("javascript"); });
  it("detects Python from .py", () => { expect(detectLanguage("main.py")).toBe("python"); });
  it("detects Go from .go", () => { expect(detectLanguage("main.go")).toBe("go"); });
  it("detects Rust from .rs", () => { expect(detectLanguage("lib.rs")).toBe("rust"); });
  it("detects Java from .java", () => { expect(detectLanguage("Main.java")).toBe("java"); });
  it("returns unknown for unrecognised extensions", () => { expect(detectLanguage("file.xyz")).toBe("unknown"); });
});

// ── parseFile — TypeScript ────────────────────────────────────────────────────

describe("parseFile (TypeScript)", () => {
  const TS_SOURCE = `
import { foo } from "./foo.js";
import type { Bar } from "../types.js";

export function greet(name: string): string {
  return \`Hello \${name}\`;
}

export const PI = 3.14159;

export class Calculator {
  add(a: number, b: number) { return a + b; }
}

export interface Shape {
  area(): number;
}

export type Status = "active" | "inactive";
`.trim();

  it("extracts function symbols", () => {
    const idx = parseFile("src/util.ts", TS_SOURCE);
    expect(idx.symbols.find((s) => s.name === "greet")).toBeDefined();
  });

  it("function symbol has kind 'function'", () => {
    const idx = parseFile("src/util.ts", TS_SOURCE);
    expect(idx.symbols.find((s) => s.name === "greet")?.kind).toBe("function");
  });

  it("extracts class symbols with kind 'class'", () => {
    const idx = parseFile("src/util.ts", TS_SOURCE);
    expect(idx.symbols.find((s) => s.name === "Calculator")?.kind).toBe("class");
  });

  it("extracts interface symbols", () => {
    const idx = parseFile("src/util.ts", TS_SOURCE);
    expect(idx.symbols.find((s) => s.name === "Shape")).toBeDefined();
  });

  it("extracts type alias symbols", () => {
    const idx = parseFile("src/util.ts", TS_SOURCE);
    expect(idx.symbols.find((s) => s.name === "Status")).toBeDefined();
  });

  it("extracts const/variable symbols", () => {
    const idx = parseFile("src/util.ts", TS_SOURCE);
    expect(idx.symbols.find((s) => s.name === "PI")).toBeDefined();
  });

  it("records imports with from field", () => {
    const idx = parseFile("src/util.ts", TS_SOURCE);
    expect(idx.imports.length).toBeGreaterThanOrEqual(1);
    expect(idx.imports.some((imp) => imp.from.includes("foo"))).toBe(true);
  });

  it("records the file path", () => {
    expect(parseFile("src/util.ts", TS_SOURCE).path).toBe("src/util.ts");
  });

  it("marks exported symbols", () => {
    const idx = parseFile("src/util.ts", TS_SOURCE);
    const greet = idx.symbols.find((s) => s.name === "greet");
    expect(greet?.exported).toBe(true);
  });

  it("exports array contains exported symbols", () => {
    const idx = parseFile("src/util.ts", TS_SOURCE);
    expect(idx.exports.some((e) => e.name === "greet")).toBe(true);
  });
});

// ── parseFile — Python ────────────────────────────────────────────────────────

describe("parseFile (Python)", () => {
  const PY_SOURCE = `
from utils import helper
import os

def process(text: str) -> str:
    return text.strip()

class Transformer:
    def transform(self, data):
        return data

MY_CONST = 42
`.trim();

  it("extracts function symbols", () => {
    expect(parseFile("app/main.py", PY_SOURCE).symbols.find((s) => s.name === "process")).toBeDefined();
  });

  it("extracts class symbols", () => {
    expect(parseFile("app/main.py", PY_SOURCE).symbols.find((s) => s.name === "Transformer")).toBeDefined();
  });

  it("records imports", () => {
    expect(parseFile("app/main.py", PY_SOURCE).imports.length).toBeGreaterThanOrEqual(1);
  });
});

// ── parseFile — Go ────────────────────────────────────────────────────────────

describe("parseFile (Go)", () => {
  const GO_SOURCE = `
package main

import "fmt"

func Add(a, b int) int { return a + b }

type Server struct { port int }

func (s *Server) Start() {}
`.trim();

  it("extracts function symbols", () => {
    expect(parseFile("main.go", GO_SOURCE).symbols.find((s) => s.name === "Add")).toBeDefined();
  });

  it("extracts struct symbols", () => {
    expect(parseFile("main.go", GO_SOURCE).symbols.find((s) => s.name === "Server")).toBeDefined();
  });
});

// ── buildCodeMap ──────────────────────────────────────────────────────────────
// Takes SourceFile[] (not Map)

// Use bare relative imports (without .js) so resolveImport can match file paths directly
const SAMPLE_FILES: SourceFile[] = [
  {
    path: "src/math.ts",
    content: `export function add(a: number, b: number) { return a + b; }
export function sub(a: number, b: number) { return a - b; }`,
  },
  {
    path: "src/utils.ts",
    content: `import { add } from "./math";
export function double(n: number) { return add(n, n); }`,
  },
  {
    path: "src/index.ts",
    content: `import { double } from "./utils";
import { sub } from "./math";
export { double, sub };`,
  },
];

describe("buildCodeMap", () => {
  it("returns a CodeMap with symbolIndex Map", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    expect(map.symbolIndex).toBeDefined();
    expect(map.symbolIndex instanceof Map).toBe(true);
  });

  it("symbolIndex maps symbol name to file paths", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    expect(map.symbolIndex.get("add")).toContain("src/math.ts");
  });

  it("builds importGraph as Map<string, Set>", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    expect(map.importGraph instanceof Map).toBe(true);
    const utilsImports = map.importGraph.get("src/utils.ts");
    expect(utilsImports).toBeDefined();
  });

  it("builds reverseImportGraph", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    expect(map.reverseImportGraph instanceof Map).toBe(true);
  });

  it("files map contains FileIndex for each file", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    expect(map.files.get("src/math.ts")).toBeDefined();
  });

  it("handles empty input", () => {
    const map = buildCodeMap([]);
    expect(map.symbolIndex.size).toBe(0);
  });
});

// ── Query helpers ─────────────────────────────────────────────────────────────

describe("searchSymbol", () => {
  it("returns files containing the symbol", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    expect(searchSymbol(map, "add")).toContain("src/math.ts");
  });

  it("returns empty array for unknown symbol", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    expect(searchSymbol(map, "nonExistentXYZ")).toEqual([]);
  });
});

describe("getImporters", () => {
  it("returns files that import the given file", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    const importers = getImporters(map, "src/math.ts");
    expect(importers.some((p) => p.includes("utils"))).toBe(true);
  });

  it("returns empty array for a file with no importers", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    const importers = getImporters(map, "src/index.ts");
    expect(importers).toEqual([]);
  });
});

describe("getExportedBy", () => {
  it("returns ExportEntry[] for a file", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    const exports = getExportedBy(map, "src/math.ts");
    expect(exports.some((e) => e.name === "add")).toBe(true);
    expect(exports.some((e) => e.name === "sub")).toBe(true);
  });

  it("each ExportEntry has name, kind, line", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    for (const e of getExportedBy(map, "src/math.ts")) {
      expect(e.name).toBeTruthy();
      expect(e.kind).toBeTruthy();
      expect(typeof e.line).toBe("number");
    }
  });
});

describe("listAllSymbols", () => {
  it("returns all symbol names (strings) across the map", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    const names = listAllSymbols(map);
    expect(names).toContain("add");
    expect(names).toContain("double");
    // listAllSymbols returns string[] (names), not SymbolDef[]
    expect(typeof names[0]).toBe("string");
  });
});

describe("getSymbolsByKind", () => {
  // getSymbolsByKind(map, filePath, kind) — takes 3 args
  const FILES: SourceFile[] = [
    {
      path: "src/mixed.ts",
      content: `export function doThing() {}
export class MyClass {}
export interface IShape { area(): number; }
export const VALUE = 1;`,
    },
  ];

  it("filters symbols of a given kind from a specific file", () => {
    const map = buildCodeMap(FILES);
    const fns = getSymbolsByKind(map, "src/mixed.ts", "function");
    expect(fns.every((s) => s.kind === "function")).toBe(true);
    expect(fns.some((s) => s.name === "doThing")).toBe(true);
  });

  it("returns classes", () => {
    const map = buildCodeMap(FILES);
    expect(getSymbolsByKind(map, "src/mixed.ts", "class").some((s) => s.name === "MyClass")).toBe(true);
  });

  it("returns empty array for unrecognised filePath", () => {
    const map = buildCodeMap(FILES);
    expect(getSymbolsByKind(map, "nonexistent.ts", "function")).toHaveLength(0);
  });
});

describe("getFileIndex", () => {
  it("returns FileIndex for a known path", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    const idx = getFileIndex(map, "src/math.ts");
    expect(idx).toBeDefined();
    expect(idx?.path).toBe("src/math.ts");
  });

  it("returns undefined for unknown path", () => {
    const map = buildCodeMap(SAMPLE_FILES);
    expect(getFileIndex(map, "nonexistent.ts")).toBeUndefined();
  });
});
