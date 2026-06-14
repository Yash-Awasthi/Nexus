// SPDX-License-Identifier: Apache-2.0
/**
 * check-license-headers.ts
 *
 * Verifies that every .ts, .tsx, .py, and .sql source file in the repo
 * starts with an SPDX license identifier comment.
 *
 * Usage: tsx scripts/check-license-headers.ts
 * Exit 0 = all files compliant. Exit 1 = violations found.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const EXTENSIONS = new Set([".ts", ".tsx", ".py", ".sql"]);

const SPDX_PATTERNS: Record<string, RegExp> = {
  ".ts": /^\/\/ SPDX-License-Identifier: Apache-2\.0/m,
  ".tsx": /^\/\/ SPDX-License-Identifier: Apache-2\.0/m,
  ".py": /^# SPDX-License-Identifier: Apache-2\.0/m,
  ".sql": /^-- SPDX-License-Identifier: Apache-2\.0/m,
};

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  ".git",
  ".changeset",
  "vendor",
  ".venv",
  "__pycache__",
]);

const IGNORE_PATTERNS = [
  /\.gen\.(ts|py)$/, // generated files
  /\.d\.ts$/, // declaration files
  /migrations\/\d+_/, // DB migrations (Drizzle-generated)
];

function shouldIgnore(filePath: string): boolean {
  return IGNORE_PATTERNS.some((p) => p.test(filePath));
}

function walk(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...walk(fullPath));
    } else if (EXTENSIONS.has(extname(entry))) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = walk(ROOT);
const violations: string[] = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  if (shouldIgnore(rel)) continue;
  const ext = extname(file);
  const pattern = SPDX_PATTERNS[ext];
  if (!pattern) continue;
  const content = readFileSync(file, "utf8");
  if (!pattern.test(content)) {
    violations.push(rel);
  }
}

if (violations.length === 0) {
  console.log(`✅  All ${files.length} source files have SPDX headers.`);
  process.exit(0);
} else {
  console.error(`\n❌  ${violations.length} file(s) missing SPDX header:\n`);
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error("\nAdd this as the first line of each file:");
  console.error("  .ts/.tsx  →  // SPDX-License-Identifier: Apache-2.0");
  console.error("  .py       →  # SPDX-License-Identifier: Apache-2.0");
  console.error("  .sql      →  -- SPDX-License-Identifier: Apache-2.0\n");
  process.exit(1);
}
