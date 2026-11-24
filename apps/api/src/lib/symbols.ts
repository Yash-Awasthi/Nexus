// SPDX-License-Identifier: Apache-2.0
/**
 * The `@symbol` index: ask the language servers first, fall back to the regex
 * walk, and cache the merged answer for 30 seconds per caller and query.
 *
 * Both sources return the same shape, so the picker never needs to care which
 * one answered. A successful file write drops the cache; see routes/agents.ts
 * and routes/missions.ts.
 */

import fs from "node:fs";
import path from "node:path";

import { getLspManager, withLspRequest } from "./lsp.ts";
/** One row of the picker; `source` says which backend produced it. */
export interface SymbolHit {
  name: string;
  type: string;
  file: string;
  line: number;
  source: "lsp" | "regex";
}

export const SYMBOL_CAP = 50;
export const SYMBOL_CACHE_TTL_MS = 30_000;

export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage"]);
export const CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"]);

const SYMBOL_RE =
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*=/g;

const SYMBOL_KINDS: Readonly<Record<number, string>> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type parameter",
};

interface CacheEntry {
  at: number;
  hits: SymbolHit[];
}

const _cache = new Map<string, CacheEntry>();

/** The folder @file and @symbol mentions may read. Opt-in only. */
export function workspaceRoot(): string | null {
  return process.env.NEXUS_WORKSPACE_DIR ? path.resolve(process.env.NEXUS_WORKSPACE_DIR) : null;
}

/** Workspace files under `root`, bounded in depth and count. */
export function collectWorkspaceFiles(
  root: string | null,
  maxDepth = 4,
  maxFiles = 2_000,
): string[] {
  const out: string[] = [];
  if (!root) return out;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries: fs.Dirent[] = [];
    try {
      // Deterministic order: directories first, dot-dirs last, then name.
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        const adot = a.name.startsWith(".") ? 1 : 0;
        const bdot = b.name.startsWith(".") ? 1 : 0;
        if (adot !== bdot) return adot - bdot;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && !e.name.startsWith(".env")) {
        out.push(path.join(dir, e.name));
        if (out.length >= maxFiles) return;
      }
    }
  };
  walk(root, 0);
  return out;
}

function kindLabel(kind: number): string {
  return SYMBOL_KINDS[kind] ?? "symbol";
}

/** The existing regex walk, kept as the fallback when no server answers. */
export function regexSymbols(root: string | null, query: string): SymbolHit[] {
  const q = query.toLowerCase();
  const hits: SymbolHit[] = [];
  for (const f of collectWorkspaceFiles(root)) {
    if (!CODE_EXT.has(path.extname(f))) continue;
    if (hits.length >= SYMBOL_CAP) break;
    let src = "";
    try {
      src = fs.readFileSync(f, "utf8").slice(0, 200_000);
    } catch {
      continue;
    }
    SYMBOL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SYMBOL_RE.exec(src)) && hits.length < SYMBOL_CAP) {
      const name = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
      if (!name || !name.toLowerCase().includes(q)) continue;
      const type = m[1]
        ? "function"
        : m[2]
          ? "class"
          : m[3]
            ? "const"
            : m[4]
              ? "interface"
              : "type";
      const line = src.slice(0, m.index).split("\n").length;
      hits.push({
        name,
        type,
        file: path.relative(root ?? "", f),
        line,
        source: "regex",
      });
    }
  }
  return hits;
}

/** Ask every running language server for `workspace/symbol`; failures are skipped. */
async function lspSymbols(ownerId: string, query: string, root: string): Promise<SymbolHit[]> {
  const manager = getLspManager();
  const status = manager.status();
  if (!status.enabled || !status.available || status.root === undefined) return [];

  const languages = [
    ...new Set(status.servers.filter((s) => s.health === "ready").map((s) => s.language)),
  ];
  const hits: SymbolHit[] = [];
  const seen = new Set<string>();

  await Promise.all(
    languages.map(async (language) => {
      const result = await withLspRequest(ownerId, undefined, () =>
        manager.workspaceSymbols({ query, language }),
      ).catch(() => null);
      if (!result?.ok) return;
      for (const symbol of result.symbols) {
        if (hits.length >= SYMBOL_CAP) return;
        if (!symbol.path) continue;
        const file = path.relative(root, symbol.path);
        const key = `${file}:${symbol.line}:${symbol.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          name: symbol.name,
          type: kindLabel(symbol.kind),
          file,
          line: symbol.line,
          source: "lsp",
        });
      }
    }),
  );
  return hits.slice(0, SYMBOL_CAP);
}

/**
 * The picker's answer for one caller and query: LSP when a server answers,
 * regex otherwise. Cached for 30 s; a write invalidates the whole cache.
 */
export async function searchSymbols(
  ownerId: string | undefined,
  query: string,
): Promise<SymbolHit[]> {
  const q = query.trim();
  if (!q) return [];
  const key = `${ownerId ?? ""}\u0000${q.toLowerCase()}`;
  const now = Date.now();
  const cached = _cache.get(key);
  if (cached && now - cached.at < SYMBOL_CACHE_TTL_MS) return cached.hits;

  const root = workspaceRoot();
  if (!root) return [];

  const fromLsp = await lspSymbols(ownerId ?? "", q, root).catch(() => []);
  const hits = fromLsp.length > 0 ? fromLsp : regexSymbols(root, q);

  if (_cache.size > 200) {
    for (const [k, v] of _cache) if (now - v.at >= SYMBOL_CACHE_TTL_MS) _cache.delete(k);
  }
  _cache.set(key, { at: now, hits });
  return hits;
}

/** Drop every cached answer; a successful workspace write calls this. */
export function invalidateSymbolCache(): void {
  _cache.clear();
}

/** Tests use this between environment changes. */
export function _resetSymbolCacheForTests(): void {
  _cache.clear();
}
