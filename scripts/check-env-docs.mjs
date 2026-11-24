// SPDX-License-Identifier: Apache-2.0
/**
 * Docs/env agreement: every environment variable the code reads is documented in
 * `.env.example`, and every documented variable is still read somewhere.
 *
 * Literal reads (`process.env.NAME`, `import.meta.env.NAME`) are checked; dynamic
 * reads (`process.env[key]`) cannot be resolved statically and are listed for
 * manual review. Documented-but-unread variables are warnings only: compose,
 * Python and shell read some of them.
 *
 * Usage: node scripts/check-env-docs.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_FILE = resolve(ROOT, process.argv[2] ?? ".env.example");

/** Directories whose `src` tree is scanned, plus extra literal roots. */
const SCAN_DIRS = ["apps", "packages"];
const EXTRA_ROOTS = [join("apps", "ui", "app")];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);

/**
 * Names read from an env object a caller passes in (not `process.env` at the read
 * site), so the literal scan cannot see them. Warning suppression only.
 */
const INDIRECT_READS = new Set([
  "NEXUS_EXEC_MODE",
  "NEXUS_EXEC_ALLOW",
  "NEXUS_EXEC_DENY",
  "NEXUS_EXEC_ROOTS",
  "NEXUS_EXEC_ASK_SURFACES",
  // @nexus/lsp parses its environment through parseLspConfig(env), so the
  // literal names never appear in a process.env read at the call site.
  "NEXUS_LSP",
  "NEXUS_LSP_TYPESCRIPT_CMD",
  "NEXUS_LSP_PYTHON_CMD",
  "NEXUS_LSP_GO_CMD",
  "NEXUS_LSP_RUST_CMD",
  "NEXUS_LSP_ROOTS",
  "NEXUS_LSP_MAX_SERVERS",
  "NEXUS_LSP_IDLE_MS",
  "NEXUS_LSP_START_TIMEOUT_MS",
  "NEXUS_LSP_REQUEST_TIMEOUT_MS",
  "NEXUS_LSP_DIAGNOSTICS_WAIT_MS",
  "NEXUS_LSP_MAX_MEMORY_MB",
  "NEXUS_LSP_MAX_DOCUMENTS",
  "NEXUS_LSP_MAX_FILE_BYTES",
  "NEXUS_LSP_LOG",
]);
/** Framework, platform and tooling variables the environment supplies; never this project's contract. */
const ALLOWLIST = new Set([
  // Node/npm
  "NODE_ENV",
  "PORT",
  "HOST",
  "CI",
  "PATH",
  "HOME",
  "PWD",
  "TMPDIR",
  "npm_package_version",
  // Windows shell/process platform
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  // Test runners and deploy platforms
  "VITEST",
  "DEV",
  "RENDER_GIT_COMMIT",
  // Set by the desktop shell or its smoke test, never by an operator
  "NEXUS_DESKTOP",
  "NEXUS_DESKTOP_SMOKE",
]);

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
          if (ALLOWLIST.has(name)) continue;
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

function documentedNames() {
  const names = new Map();
  const lines = readFileSync(ENV_FILE, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(lines[index]);
    if (match && !names.has(match[1])) names.set(match[1], index + 1);
  }
  return names;
}

const files = scanFiles();
const { reads, dynamic } = scanReads(files);
const documented = documentedNames();

const missing = [];
const testOnly = [];
for (const [name, info] of reads) {
  if (documented.has(name)) continue;
  if (info.testOnly) {
    testOnly.push({ name, ...info.first });
  } else {
    missing.push({ name, ...info.first, files: info.files.size });
  }
}

const unread = [...documented].filter(
  ([name]) => !reads.has(name) && !ALLOWLIST.has(name) && !INDIRECT_READS.has(name),
);

for (const { file, line, text } of dynamic) {
  console.log(`review: dynamic env access in ${file}:${line} — ${text}`);
}
for (const entry of testOnly) {
  console.log(
    `info: test-only ${entry.name} (${entry.file}:${entry.line}) — not required in .env.example`,
  );
}
for (const [name, line] of unread) {
  console.warn(`warning: ${name} is documented in .env.example:${line} but no code reads it`);
}

if (missing.length > 0) {
  for (const entry of missing) {
    console.error(
      `error: ${entry.name} is read in ${entry.file}:${entry.line}` +
        `${entry.files > 1 ? ` (+${entry.files - 1} more file(s))` : ""}` +
        " but missing from .env.example",
    );
  }
  console.error(
    `\ncheck:env-docs failed: ${missing.length} env variable(s) read but undocumented ` +
      `(${files.length} files scanned).`,
  );
  process.exit(1);
}

console.log(
  `\ncheck:env-docs passed: ${reads.size} variable(s) read, all documented in .env.example ` +
    `(${files.length} files scanned, ${unread.length} warning(s), ${dynamic.length} dynamic access(es)).`,
);
