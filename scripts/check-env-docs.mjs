// SPDX-License-Identifier: Apache-2.0
/**
 * Docs/env agreement: every environment variable the code reads is documented in
 * `.env.example`, and every documented variable is read somewhere.
 *
 * Literal reads (`process.env.NAME`, `import.meta.env.NAME`) are checked; dynamic
 * reads (`process.env[key]`) cannot be resolved statically and are listed for
 * manual review. A documented variable the literal scan does not see fails the
 * check unless `scripts/env-docs-allowlist.mjs` names it with the reader behind it
 * (compose, Python, a helper that takes the name, bracket access).
 *
 * Usage: node scripts/check-env-docs.mjs [env-file]
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { ALLOWLIST, PLATFORM_ENV } from "./env-docs-allowlist.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_FILE = resolve(ROOT, process.argv[2] ?? ".env.example");

/** Directories whose `src` tree is scanned, plus extra literal roots. */
const SCAN_DIRS = ["apps", "packages"];
const EXTRA_ROOTS = [join("apps", "ui", "app")];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);

const LITERAL_PATTERNS = [
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
];
const DYNAMIC_PATTERN = /\b(?:process\.env|import\.meta\.env)\s*\[/g;

function isTestFile(path) {
  const parts = path.split(sep);
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    parts.includes("tests") ||
    parts.includes("__tests__")
  );
}

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name), files);
    } else if (CODE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function scanFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    let entries;
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(...walk(join(ROOT, dir, entry.name, "src")));
    }
  }
  for (const extra of EXTRA_ROOTS) files.push(...walk(join(ROOT, extra)));
  return files;
}

/** name -> { first: { file, line }, files: Set, testOnly: boolean } */
function scanReads(files) {
  const reads = new Map();
  const dynamic = [];

  for (const file of files) {
    const relativeFile = relative(ROOT, file);
    const test = isTestFile(relativeFile);
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      for (const pattern of LITERAL_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of line.matchAll(pattern)) {
          const name = match[1];
          if (PLATFORM_ENV.has(name)) continue;
          const existing = reads.get(name);
          if (existing) {
            existing.files.add(relativeFile);
            existing.testOnly = existing.testOnly && test;
          } else {
            reads.set(name, {
              first: { file: relativeFile, line: index + 1 },
              files: new Set([relativeFile]),
              testOnly: test,
            });
          }
        }
      }

      DYNAMIC_PATTERN.lastIndex = 0;
      if (DYNAMIC_PATTERN.test(line)) {
        dynamic.push({ file: relativeFile, line: index + 1, text: line.trim() });
      }
    }
  }

  return { reads, dynamic };
}

function documentedNames(envFile) {
  const names = new Map();
  const lines = readFileSync(envFile, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(lines[index]);
    if (match && !names.has(match[1])) names.set(match[1], index + 1);
  }
  return names;
}

/**
 * Compare documented names, literal reads and dynamic accesses.
 *
 * @param {{
 *   documented: Map<string, number>,
 *   reads: Map<string, { first: { file: string, line: number }, testOnly: boolean, files: Set<string> }>,
 *   dynamic: Array<{ file: string, line: number, text: string }>,
 *   allowlist?: Record<string, string>,
 *   platform?: Set<string>,
 *   fileCount?: number,
 * }} input
 */
export function evaluate({
  documented,
  reads,
  dynamic = [],
  allowlist = ALLOWLIST,
  platform = PLATFORM_ENV,
  fileCount = 0,
}) {
  const undocumented = [];
  const testOnly = [];
  for (const [name, info] of reads) {
    if (documented.has(name)) continue;
    if (info.testOnly) {
      testOnly.push({ name, ...info.first });
    } else {
      undocumented.push({ name, ...info.first, files: info.files.size });
    }
  }

  const unread = [];
  const allowedUnread = [];
  for (const [name, line] of documented) {
    if (reads.has(name) || platform.has(name)) continue;
    if (allowlist[name]) allowedUnread.push({ name, line, reason: allowlist[name] });
    else unread.push({ name, line });
  }

  const documentedRead = [...documented.keys()].filter((name) => reads.has(name)).length;
  const counts = {
    documentedRead,
    unreadOutsideAllowlist: unread.length,
    readUndocumented: undocumented.length,
    dynamic: dynamic.length,
    allowlistedUnread: allowedUnread.length,
    allowlistSize: Object.keys(allowlist).length,
  };

  const info = [];
  for (const { file, line, text } of dynamic) {
    info.push(`review: dynamic env access in ${file}:${line} — ${text}`);
  }
  for (const entry of testOnly) {
    info.push(
      `info: test-only ${entry.name} (${entry.file}:${entry.line}) — not required in .env.example`,
    );
  }
  for (const { name, line, reason } of allowedUnread) {
    info.push(`info: ${name} documented in .env.example:${line}, unread by the scan: ${reason}`);
  }

  const errors = [];
  for (const { name, line } of unread) {
    errors.push(
      `error: ${name} is documented in .env.example:${line} but no code reads it ` +
        "and it is not in scripts/env-docs-allowlist.mjs",
    );
  }
  for (const entry of undocumented) {
    errors.push(
      `error: ${entry.name} is read in ${entry.file}:${entry.line}` +
        `${entry.files > 1 ? ` (+${entry.files - 1} more file(s))` : ""}` +
        " but missing from .env.example",
    );
  }

  const tally =
    `${counts.documentedRead} documented and read, ` +
    `${counts.unreadOutsideAllowlist} documented but unread outside the allowlist, ` +
    `${counts.readUndocumented} read but undocumented, ` +
    `${counts.dynamic} dynamic access(es) (${fileCount} files scanned, ` +
    `${counts.allowlistSize} allowlist entries)`;
  const summary =
    errors.length === 0 ? `check:env-docs passed: ${tally}.` : `check:env-docs failed: ${tally}.`;

  return { exitCode: errors.length === 0 ? 0 : 1, info, errors, summary, counts };
}

export function run({ envFile = ENV_FILE } = {}) {
  const files = scanFiles();
  const { reads, dynamic } = scanReads(files);
  return evaluate({
    documented: documentedNames(envFile),
    reads,
    dynamic,
    fileCount: files.length,
  });
}

function main(argv = process.argv) {
  const envFile = resolve(ROOT, argv[2] ?? ".env.example");
  const result = run({ envFile });
  for (const line of result.info) console.log(line);
  for (const line of result.errors) console.error(line);
  const write = result.exitCode === 0 ? console.log : console.error;
  write(`\n${result.summary}`);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
