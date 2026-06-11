#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0
/**
 * M2 pruning toolchain runner.
 *
 * Usage:
 *   pnpm tsx scripts/prune/run-knip.ts
 *
 * Runs knip across all workspace packages and writes results to
 * docs/audit/M2-knip-report.json + docs/audit/M2-knip-report.md
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname ?? process.cwd(), "../..");
const AUDIT_DIR = join(ROOT, "docs/audit");

mkdirSync(AUDIT_DIR, { recursive: true });

console.log("Running knip analysis across workspace…");

try {
  const output = execSync("pnpm knip --reporter json 2>&1", {
    cwd: ROOT,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
  });

  writeFileSync(join(AUDIT_DIR, "M2-knip-report.json"), output);

  // Parse and produce markdown summary
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    parsed = { raw: output };
  }

  const md = `# M2 Knip Analysis Report

Generated: ${new Date().toISOString()}

\`\`\`json
${JSON.stringify(parsed, null, 2).slice(0, 50_000)}
\`\`\`

> Full JSON report: \`docs/audit/M2-knip-report.json\`
`;

  writeFileSync(join(AUDIT_DIR, "M2-knip-report.md"), md);
  console.log("✓ Report written to docs/audit/M2-knip-report.{json,md}");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("knip failed:", message.slice(0, 500));
  process.exit(1);
}
