// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/code-map — AST-based multi-language codebase indexer.
 *
 * Builds structured symbol / type / dependency maps from source files using
 * regex-based extraction (no native tree-sitter bindings required).
 * Gives the Librarian agent real code understanding instead of filename /
 * memory substring search.
 *
 * Supported languages
 * ───────────────────
 *   TypeScript / JavaScript   .ts .tsx .js .jsx .mjs .cjs
 *   Python                    .py
 *   Go                        .go
 *   Rust                      .rs
 *   Java / Kotlin             .java .kt
 *
 * Architecture
 * ────────────
 *   buildCodeMap()     — index a set of (path, content) pairs → CodeMap.
 *   parseFile()        — extract symbols from one file → FileIndex.
 *   searchSymbol()     — find all files that define / use a symbol.
 *   getImporters()     — which files import a given file?
 *   getExportedBy()    — which symbols does a file export?
 *
 * Usage
 * ─────
 * ```ts
 * const map = buildCodeMap([
 *   { path: "src/auth.ts", content: "export function login(...) {...}" },
 *   { path: "src/app.ts",  content: "import { login } from './auth';" },
 * ]);
 * searchSymbol(map, "login"); // → ["src/auth.ts", "src/app.ts"]
 * getImporters(map, "src/auth.ts"); // → ["src/app.ts"]
 * ```
 */

// ── Language detection ────────────────────────────────────────────────────────

export type SupportedLanguage = "typescript" | "javascript" | "python" | "go" | "rust" | "java";

/** Detect language. */
export function detectLanguage(path: string): SupportedLanguage | "unknown" {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
    case "kt":
      return "java";
    default:
      return "unknown";
  }
}

// ── Symbol types ──────────────────────────────────────────────────────────────

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "const"
  | "struct"
  | "method"
  | "module";

/** Symbol def interface definition. */
export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
}

/** Import entry interface definition. */
export interface ImportEntry {
  /** Module specifier (relative or package name). */
  from: string;
  /** Specific names imported (empty means namespace/default import). */
  names: string[];
  line: number;
}

/** Export entry interface definition. */
export interface ExportEntry {
  name: string;
  kind: SymbolKind;
  line: number;
}

/** File index interface definition. */
export interface FileIndex {
  path: string;
  language: SupportedLanguage | "unknown";
  symbols: SymbolDef[];
  imports: ImportEntry[];
  exports: ExportEntry[];
  /** All identifier names referenced in the file (calls, usages). */
  references: string[];
}

// ── Code map ──────────────────────────────────────────────────────────────────

export interface CodeMap {
  files: Map<string, FileIndex>;
  /** Inverted index: symbol name → files that define it. */
  symbolIndex: Map<string, string[]>;
  /** Import graph: path → set of paths it imports from (resolved). */
  importGraph: Map<string, Set<string>>;
  /** Reverse import graph: path → set of paths that import it. */
  reverseImportGraph: Map<string, Set<string>>;
}

// ── Language-specific extractors ──────────────────────────────────────────────

// TypeScript / JavaScript

const TS_FUNCTION_RE = /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const TS_CLASS_RE = /(?:^|\s)(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const TS_INTERFACE_RE = /(?:^|\s)(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const TS_TYPE_RE = /(?:^|\s)(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/gm;
const TS_ENUM_RE = /(?:^|\s)(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const TS_CONST_RE = /(?:^|\s)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const TS_IMPORT_RE =
  /^import\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z_$*][A-Za-z0-9_$*]*))\s+from\s+['"]([^'"]+)['"]/gm;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TS_EXPORT_RE =
  /^export\s+(?:type\s+)?(?:default\s+)?(?:function|class|interface|type|enum|const|let|var|abstract\s+class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const TS_EXPORT_FROM_RE = /^export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm;

// Python

const PY_FUNCTION_RE = /^(?: {4})*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
const PY_CLASS_RE = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const PY_IMPORT_RE = /^(?:from\s+([.\w]+)\s+import\s+([\w,\s*]+)|import\s+([\w,\s]+))/gm;
const PY_CONST_RE = /^([A-Z_][A-Z0-9_]{2,})\s*=/gm;

// Go

const GO_FUNC_RE = /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
const GO_TYPE_RE = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/gm;
const GO_IMPORT_RE = /^\s+"([^"]+)"/gm;
const GO_CONST_RE = /^(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

// Rust

const RUST_FN_RE = /^(?:pub(?:\s+\(crate\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const RUST_STRUCT_RE = /^(?:pub(?:\s+\(crate\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const RUST_ENUM_RE = /^(?:pub(?:\s+\(crate\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const RUST_TRAIT_RE = /^(?:pub(?:\s+\(crate\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const RUST_USE_RE = /^use\s+([\w:]+(?:::\{[^}]+\})?);/gm;

// Java

const JAVA_CLASS_RE =
  /^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?(?:class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const JAVA_METHOD_RE =
  /^\s+(?:public|private|protected|static|final|abstract|\s)+\s+\w+\s+([a-z][A-Za-z0-9_]*)\s*\(/gm;
const JAVA_IMPORT_RE = /^import\s+([\w.]+(?:\.\*)?);/gm;

// ── Helper: extract line number ───────────────────────────────────────────────

function getLine(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function isExported(fullMatch: string): boolean {
  return /\bexport\b/.test(fullMatch) || /^pub/.test(fullMatch.trim());
}

// ── File parser ───────────────────────────────────────────────────────────────

export function parseFile(path: string, content: string): FileIndex {
  const language = detectLanguage(path);
  const symbols: SymbolDef[] = [];
  const imports: ImportEntry[] = [];
  const exports: ExportEntry[] = [];
  const references = new Set<string>();

  function extractSymbols(
    re: RegExp,
    kind: SymbolKind,
    exported: (match: RegExpExecArray) => boolean = () => false,
  ): void {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const line = getLine(content, m.index);
      const exp = exported(m);
      symbols.push({ name, kind, line, exported: exp });
      references.add(name);
      if (exp) exports.push({ name, kind, line });
    }
  }

  switch (language) {
    case "typescript":
    case "javascript": {
      const expCheck = (m: RegExpExecArray) => isExported(m[0]);
      extractSymbols(TS_FUNCTION_RE, "function", expCheck);
      extractSymbols(TS_CLASS_RE, "class", expCheck);
      extractSymbols(TS_INTERFACE_RE, "interface", expCheck);
      extractSymbols(TS_TYPE_RE, "type", expCheck);
      extractSymbols(TS_ENUM_RE, "enum", expCheck);
      extractSymbols(TS_CONST_RE, "const", expCheck);

      // Imports
      TS_IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TS_IMPORT_RE.exec(content)) !== null) {
        const namedGroup = m[1];
        const defaultName = m[2];
        const from = m[3] ?? "";
        const names = namedGroup
          ? namedGroup
              .split(",")
              .map(
                (n) =>
                  n
                    .trim()
                    .split(/\s+as\s+/)[0]
                    ?.trim() ?? "",
              )
              .filter(Boolean)
          : defaultName
            ? [defaultName]
            : [];
        imports.push({ from, names, line: getLine(content, m.index) });
        for (const n of names) references.add(n);
      }

      // Export-from re-exports
      TS_EXPORT_FROM_RE.lastIndex = 0;
      while ((m = TS_EXPORT_FROM_RE.exec(content)) !== null) {
        const names = (m[1] ?? "")
          .split(",")
          .map(
            (n) =>
              n
                .trim()
                .split(/\s+as\s+/)[0]
                ?.trim() ?? "",
          )
          .filter(Boolean);
        const from = m[2] ?? "";
        imports.push({ from, names, line: getLine(content, m.index) });
      }

      break;
    }

    case "python": {
      extractSymbols(PY_FUNCTION_RE, "function");
      extractSymbols(PY_CLASS_RE, "class");
      extractSymbols(PY_CONST_RE, "const");

      PY_IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PY_IMPORT_RE.exec(content)) !== null) {
        const fromModule = m[1] ?? "";
        const importedNames = m[2] ?? m[3] ?? "";
        const names = importedNames
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        imports.push({ from: fromModule, names, line: getLine(content, m.index) });
        for (const n of names) references.add(n);
      }
      break;
    }

    case "go": {
      extractSymbols(GO_FUNC_RE, "function");
      extractSymbols(GO_TYPE_RE, "struct");
      extractSymbols(GO_CONST_RE, "const");

      GO_IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = GO_IMPORT_RE.exec(content)) !== null) {
        const from = m[1] ?? "";
        imports.push({ from, names: [], line: getLine(content, m.index) });
      }
      break;
    }

    case "rust": {
      extractSymbols(RUST_FN_RE, "function", (m) => /^pub/.test(m[0].trim()));
      extractSymbols(RUST_STRUCT_RE, "struct", (m) => /^pub/.test(m[0].trim()));
      extractSymbols(RUST_ENUM_RE, "enum", (m) => /^pub/.test(m[0].trim()));
      extractSymbols(RUST_TRAIT_RE, "interface", (m) => /^pub/.test(m[0].trim()));

      RUST_USE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RUST_USE_RE.exec(content)) !== null) {
        const from = m[1] ?? "";
        imports.push({ from, names: [], line: getLine(content, m.index) });
      }
      break;
    }

    case "java": {
      extractSymbols(JAVA_CLASS_RE, "class", (m) => /\bpublic\b/.test(m[0]));
      extractSymbols(JAVA_METHOD_RE, "method", (m) => /\bpublic\b/.test(m[0]));

      JAVA_IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = JAVA_IMPORT_RE.exec(content)) !== null) {
        const from = m[1] ?? "";
        imports.push({ from, names: [], line: getLine(content, m.index) });
      }
      break;
    }

    default:
      break;
  }

  return {
    path,
    language,
    symbols,
    imports,
    exports,
    references: Array.from(references),
  };
}

// ── Resolve import path ───────────────────────────────────────────────────────

function resolveImport(fromFile: string, importSpecifier: string): string | null {
  if (!importSpecifier.startsWith(".")) return null; // external package
  const dir = fromFile.split("/").slice(0, -1).join("/");
  const resolved = dir ? `${dir}/${importSpecifier}` : importSpecifier;
  return resolved.replace(/\/\.\//g, "/").replace(/\/[^/]+\/\.\.\//g, "/");
}

// ── Build code map ────────────────────────────────────────────────────────────

export interface SourceFile {
  path: string;
  content: string;
}

/** Build code map. */
export function buildCodeMap(files: SourceFile[]): CodeMap {
  const fileMap = new Map<string, FileIndex>();
  const symbolIndex = new Map<string, string[]>();
  const importGraph = new Map<string, Set<string>>();
  const reverseImportGraph = new Map<string, Set<string>>();

  // Parse all files
  for (const f of files) {
    const index = parseFile(f.path, f.content);
    fileMap.set(f.path, index);

    for (const sym of index.symbols) {
      const list = symbolIndex.get(sym.name) ?? [];
      list.push(f.path);
      symbolIndex.set(sym.name, list);
    }
  }

  // Build import graphs
  for (const [filePath, index] of fileMap) {
    const outSet = new Set<string>();

    for (const imp of index.imports) {
      const resolved = resolveImport(filePath, imp.from);
      if (resolved === null) continue;

      // Try to find exact match in the map (with/without extension)
      for (const candidatePath of fileMap.keys()) {
        const stripped = candidatePath.replace(/\.(ts|tsx|js|jsx|py|go|rs|java|kt)$/, "");
        if (stripped === resolved || candidatePath === resolved) {
          outSet.add(candidatePath);
          const rev = reverseImportGraph.get(candidatePath) ?? new Set();
          rev.add(filePath);
          reverseImportGraph.set(candidatePath, rev);
        }
      }
    }

    importGraph.set(filePath, outSet);
  }

  return { files: fileMap, symbolIndex, importGraph, reverseImportGraph };
}

// ── Query API ─────────────────────────────────────────────────────────────────

/**
 * Find all files that define the given symbol name.
 */
export function searchSymbol(map: CodeMap, name: string): string[] {
  return map.symbolIndex.get(name) ?? [];
}

/**
 * Find all files that import from the given file path.
 */
export function getImporters(map: CodeMap, filePath: string): string[] {
  return Array.from(map.reverseImportGraph.get(filePath) ?? []);
}

/**
 * Get the names exported by a file.
 */
export function getExportedBy(map: CodeMap, filePath: string): ExportEntry[] {
  return map.files.get(filePath)?.exports ?? [];
}

/**
 * Get the full FileIndex for a path.
 */
export function getFileIndex(map: CodeMap, filePath: string): FileIndex | undefined {
  return map.files.get(filePath);
}

/**
 * List all symbol names across the entire map.
 */
export function listAllSymbols(map: CodeMap): string[] {
  return Array.from(map.symbolIndex.keys());
}

/**
 * Get symbols of a specific kind from a file.
 */
export function getSymbolsByKind(map: CodeMap, filePath: string, kind: SymbolKind): SymbolDef[] {
  return (map.files.get(filePath)?.symbols ?? []).filter((s) => s.kind === kind);
}
