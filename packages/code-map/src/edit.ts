// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/code-map — structural import editing (ts-morph parity slice).
 *
 * code-map is otherwise a read-only indexer; ts-morph's most-used
 * manipulation is programmatic import management (`addImportDeclaration` /
 * `removeImportDeclaration`). Import statements have fixed single-line
 * syntax, so these edits are precise on source text — no AST required —
 * and purely additive, so they cannot silently break existing code
 * (unlike identifier renames, which need a type checker to resolve
 * references and stay out of scope here).
 *
 * Contract
 * ────────
 *   • Only single-line import declarations are matched/merged. Files
 *     containing multi-line imports still work — new declarations are
 *     inserted after the last single-line import (or before the first
 *     body statement) and existing multi-line declarations are left
 *     untouched.
 *   • `import type` declarations are a separate family: a type-only
 *     spec never merges into a value import (and vice versa), matching
 *     how ts-morph treats type-only import declarations.
 *   • Namespace imports (`import * as ns`) cannot merge named
 *     specifiers; a new declaration is inserted instead.
 *   • Semicolons follow the file's prevailing style; merging preserves
 *     the existing line's terminator.
 *
 * Usage
 * ─────
 * ```ts
 * const next = addImportDeclaration(src, { namedImports: ["login"], from: "./auth" });
 * const clean = removeImportDeclaration(next, "./auth", ["login"]);
 * ```
 */

export interface ImportSpec {
  /** Named specifiers, e.g. `import { login, logout } from ...`. */
  namedImports?: string[];
  /** Default binding, e.g. `import express from ...`. */
  defaultImport?: string;
  /** Emit an `import type` declaration (separate merge family). */
  typeOnly?: boolean;
  /** Module specifier (relative path or package name). */
  from: string;
}

interface ParsedImport {
  indent: string;
  typeOnly: boolean;
  defaultImport?: string;
  /** Specifiers as written, possibly carrying inline `type ` prefixes. */
  names: string[];
  namespace?: string;
  semicolon: boolean;
  from: string;
}

const IMPORT_LINE_RE = /^(\s*)import\s+(type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"];?\s*$/;

function parseImportLine(line: string): ParsedImport | undefined {
  const m = line.match(IMPORT_LINE_RE);
  if (!m) return undefined;
  const [, indent, typePrefix, body, from] = m as [string, string, string | undefined, string, string];
  const parsed: ParsedImport = {
    indent,
    typeOnly: typePrefix !== undefined,
    names: [],
    semicolon: line.trimEnd().endsWith(";"),
    from,
  };
  const ns = body.match(/^\* as (\$?[\w$]+)$/);
  if (ns) {
    parsed.namespace = ns[1];
    return parsed;
  }
  const brace = body.match(/\{([^}]*)\}/);
  if (brace) {
    for (const spec of (brace[1] ?? "").split(/\s*,\s*/)) {
      const s = spec.trim();
      if (s) parsed.names.push(s);
    }
  }
  const defaultPart = body.replace(/\{[^}]*\}/, "").trim().replace(/,$/, "");
  if (defaultPart) parsed.defaultImport = defaultPart;
  return parsed;
}

function formatImport(p: ParsedImport, semicolon: boolean): string {
  const parts: string[] = [];
  if (p.defaultImport !== undefined) parts.push(p.defaultImport);
  if (p.names.length > 0) {
    const sorted = [...p.names].sort((a, b) =>
      a.replace(/^type\s+/, "").localeCompare(b.replace(/^type\s+/, "")),
    );
    parts.push(`{ ${sorted.join(", ")} }`);
  }
  return `${p.indent}import ${p.typeOnly ? "type " : ""}${parts.join(", ")} from '${p.from}'${semicolon ? ";" : ""}`;
}

function styleUsesSemicolons(content: string): boolean {
  for (const line of content.split("\n").slice(0, 200)) {
    const t = line.trim();
    if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    return t.endsWith(";");
  }
  return false;
}

/** First body position: after leading comments/blanks, before first statement. */
function firstBodyIndex(lines: string[]): number {
  let i = 0;
  while (i < lines.length) {
    const t = (lines[i] ?? "").trim();
    if (t && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*")) break;
    i++;
  }
  return i;
}

/**
 * Add an import declaration, merging into an existing declaration from
 * the same module when possible. Returns the new source text; the input
 * is returned unchanged when every requested specifier is already
 * present.
 */
export function addImportDeclaration(content: string, spec: ImportSpec): string {
  const from = spec.from;
  const named = spec.namedImports ?? [];
  if (!from) throw new Error("addImportDeclaration: `from` is required");
  if (named.length === 0 && spec.defaultImport === undefined) {
    throw new Error("addImportDeclaration: nothing to import (names or defaultImport required)");
  }
  const lines = content.split("\n");
  const semicolon = styleUsesSemicolons(content);
  const request = { from, typeOnly: spec.typeOnly === true, names: [...named], defaultImport: spec.defaultImport };

  // Find the same-module declaration in the same type family.
  for (let i = 0; i < lines.length; i++) {
    const p = parseImportLine(lines[i] ?? "");
    if (!p || p.from !== from || p.typeOnly !== request.typeOnly) continue;
    if (p.namespace !== undefined) {
      // Cannot merge named/default into a namespace import — insert a new
      // declaration right after it instead.
      lines.splice(i + 1, 0, formatImport({ ...request, indent: p.indent, semicolon }, semicolon));
      return lines.join("\n");
    }
    if (p.defaultImport !== undefined && request.defaultImport !== undefined && p.defaultImport !== request.defaultImport) {
      throw new Error(
        `addImportDeclaration: module '${from}' already has default import '${p.defaultImport}'`,
      );
    }
    const existing = new Set(p.names);
    const merged = new Set([...p.names, ...request.names]);
    const defaultName = p.defaultImport ?? request.defaultImport;
    const alreadyPresent = defaultName === p.defaultImport && [...request.names].every((n) => existing.has(n));
    if (alreadyPresent) return content;
    lines[i] = formatImport(
      { ...p, defaultImport: defaultName, names: [...merged] },
      p.semicolon,
    );
    return lines.join("\n");
  }

  // No same-module declaration: insert after the last single-line import,
  // or before the first body statement when the file has none.
  const fresh: ParsedImport = { ...request, indent: "", semicolon };
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (parseImportLine(lines[i] ?? "")) insertAt = i;
  }
  if (insertAt >= 0) {
    lines.splice(insertAt + 1, 0, formatImport(fresh, semicolon));
  } else {
    lines.splice(firstBodyIndex(lines), 0, formatImport(fresh, semicolon));
  }
  return lines.join("\n");
}

/**
 * Remove an import declaration (whole declaration when `names` is
 * omitted, otherwise just the named specifiers — dropping the
 * declaration entirely once nothing remains).
 */
export function removeImportDeclaration(content: string, from: string, names?: string[]): string {
  if (!from) throw new Error("removeImportDeclaration: `from` is required");
  const lines = content.split("\n");
  let changed = false;
  const wanted = new Set(names ?? []);
  for (let i = 0; i < lines.length; i++) {
    const p = parseImportLine(lines[i] ?? "");
    if (!p || p.from !== from) continue;
    if (names === undefined) {
      lines.splice(i, 1);
      changed = true;
      i--;
      continue;
    }
    if (p.namespace !== undefined) {
      throw new Error(`removeImportDeclaration: cannot remove named specifiers from namespace import '${from}'`);
    }
    const remaining = p.names.filter((n) => !wanted.has(n.replace(/^type\s+/, "")));
    const keepDefault = p.defaultImport !== undefined && !wanted.has(p.defaultImport);
    if (remaining.length === 0 && !keepDefault) {
      lines.splice(i, 1);
      changed = true;
      i--;
      continue;
    }
    const defaultChanged = keepDefault !== (p.defaultImport !== undefined);
    if (remaining.length !== p.names.length || defaultChanged) {
      lines[i] = formatImport({ ...p, defaultImport: keepDefault ? p.defaultImport : undefined, names: remaining }, p.semicolon);
      changed = true;
    }
  }
  return changed ? lines.join("\n") : content;
}