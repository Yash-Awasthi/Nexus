// SPDX-License-Identifier: Apache-2.0
/**
 * Keep a generated markdown block honest.
 *
 * One document, one generator: `--write` replaces the block between the markers, `--check` fails when a
 * fresh run no longer matches what is committed. Two evaluations use this (retrieval and council), so the
 * comparison and the formatting live here once.
 *
 *   node scripts/evals.mjs --write
 *   node scripts/evals.mjs --check
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Compare content, not alignment.
 *
 * The document is formatted by `vp fmt` like every other markdown file, which pads table cells; the
 * generator emits the same cells unpadded. Comparing raw text would make the two gates fight — write the
 * block, format it, fail the check — so the comparison collapses whitespace and separator padding while
 * still failing on any changed number, row or sentence.
 */
export function canonical(text) {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n")
      .replace(/ *\| */g, "|")
      // A separator row is `|---|---|` after formatting and `|---|-|---|` as generated: same table.
      .replace(/^\|[-: |]+\|$/gm, (row) => row.replace(/-+/g, "---"))
  );
}

/**
 * Format one markdown file the way the repository formats everything else.
 *
 * A generator that writes a table and leaves it unformatted makes `--check` and `format:check` fight: the
 * gate writes un-padded cells, the formatter pads them, and the next `--check` calls the committed file
 * stale. Exporting the formatter means a generator can finish the job it started.
 */
export function formatDoc(docRelative) {
  try {
    // One string with `shell: true` (no argument array) so Windows and POSIX resolve `vp` the same way
    // without Node's argument-escaping warning.
    execFileSync(`npx vp fmt ${JSON.stringify(docRelative)}`, {
      cwd: ROOT,
      stdio: "ignore",
      shell: true,
    });
  } catch {
    console.warn(`could not format ${docRelative}; run \`pnpm format\` before committing.`);
  }
}

/**
 * @param {{ doc: string, cli: string, start: string, end: string, label: string, hint: string }} options
 */
export function syncGeneratedDoc({ doc, cli, start, end, label, hint }) {
  const docPath = path.join(ROOT, doc);
  const mode = process.argv.includes("--check") ? "check" : "write";

  const generated = execFileSync(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(ROOT, cli)],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ).trim();

  if (!fs.existsSync(docPath)) {
    console.error(`${doc} is missing; run \`${hint} --write\` after creating it.`);
    process.exit(1);
  }

  const current = fs.readFileSync(docPath, "utf8");
  const startAt = current.indexOf(start);
  const endAt = current.indexOf(end);
  if (startAt === -1 || endAt === -1 || endAt < startAt) {
    console.error(`${doc} has no ${start} … ${end} block.`);
    process.exit(1);
  }

  const next = `${current.slice(0, startAt + start.length)}\n${generated}\n${current.slice(endAt)}`;

  if (mode === "check") {
    const blockOf = (text) => text.slice(text.indexOf(start) + start.length, text.indexOf(end));
    if (canonical(blockOf(next)) !== canonical(blockOf(current))) {
      console.error(
        `${doc} is stale: the evaluation output changed.\nRun \`${hint}\` and commit the result, ` +
          "or if the change is intended, update the numbers deliberately.",
      );
      process.exit(1);
    }
    console.log(`${label}: ${doc} matches a fresh run (${generated.split("\n").length} lines).`);
    process.exit(0);
  }

  fs.writeFileSync(docPath, next);
  formatDoc(doc);
  console.log(`${label}: wrote ${doc} from a fresh run.`);
}
