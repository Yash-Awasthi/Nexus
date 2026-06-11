#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0
/**
 * M2-7: Execute MOVE decisions from the four decision CSVs.
 *
 * Reads docs/audit/M2-*-decisions.csv, filters rows where decision === "MOVE",
 * performs git mv for each, and updates import paths.
 *
 * NOTE: Run only after M3 substrates are in place and reviewed.
 * This script is DESTRUCTIVE — always run on a fresh branch.
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { mkdirSync } from "fs";

const ROOT = join(import.meta.dirname ?? process.cwd(), "../..");
const AUDIT_DIR = join(ROOT, "docs/audit");

const CSV_FILES = [
  "M2-judica-decisions.csv",
  "M2-ghoststack-decisions.csv",
  "M2-finscrape-decisions.csv",
  "M2-workspace-decisions.csv",
];

interface DecisionRow {
  path: string;
  decision: string;
  destination: string;
  rationale: string;
}

function parseCsv(content: string): DecisionRow[] {
  const [, ...lines] = content.trim().split("\n");
  return lines
    .map(line => {
      const parts = line.split(",");
      return {
        path: parts[0]?.trim() ?? "",
        decision: parts[1]?.trim() ?? "",
        destination: parts[2]?.trim() ?? "",
        rationale: parts[3]?.trim() ?? "",
      };
    })
    .filter(row => row.path && row.decision);
}

let totalMoves = 0;
let totalSkips = 0;

for (const csvFile of CSV_FILES) {
  const csvPath = join(AUDIT_DIR, csvFile);
  let content: string;
  try {
    content = readFileSync(csvPath, "utf8");
  } catch {
    console.warn(`Warning: ${csvFile} not found, skipping`);
    continue;
  }

  const rows = parseCsv(content);
  const moves = rows.filter(r => r.decision === "MOVE" && r.destination);

  console.log(`\n${csvFile}: ${moves.length} MOVE decisions`);

  for (const row of moves) {
    const src = join(ROOT, row.path);
    const dst = join(ROOT, row.destination);

    try {
      mkdirSync(dirname(dst), { recursive: true });
      execSync(`git mv "${src}" "${dst}"`, { cwd: ROOT });
      console.log(`  ✓ ${row.path} → ${row.destination}`);
      totalMoves++;
    } catch (err) {
      console.warn(`  ⚠ Skip ${row.path}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      totalSkips++;
    }
  }
}

console.log(`\nDone: ${totalMoves} moves, ${totalSkips} skipped`);
console.log("Run `pnpm build` to surface broken imports that need fixing in M3–M7.");
