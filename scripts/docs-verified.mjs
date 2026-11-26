// SPDX-License-Identifier: Apache-2.0
/**
 * Every document says which commit it was last true against.
 *
 * The stamp is not a promise, it is a coordinate: "these words were checked against
 * this tree". It is computed, not typed — the last commit that touched the file — so it
 * moves when the document moves, and `--check` fails when a document was edited without
 * the stamp following it (which happens when someone writes the stamp by hand, or edits
 * a file in a branch that the stamp has not caught up with).
 *
 * Run it after committing a document, then amend: the stamp names the commit that last
 * touched the file, so stamping before the commit leaves it pointing one commit back.
 *
 * A shallow clone cannot answer "which commit last touched this file", so it skips with
 * a note instead of failing on a guess.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DOCS = "docs";
const MARKER = /^<!-- verified: ([0-9a-f]{7,40}) (\d{4}-\d{2}-\d{2}) -->$/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function isShallow() {
  try {
    return git(["rev-parse", "--is-shallow-repository"]) === "true";
  } catch {
    return true;
  }
}

/** The commit and date that last changed a path. */
function lastTouched(file) {
  const out = git(["log", "-1", "--format=%h %cs", "--", file]);
  if (out) {
    const [sha, date] = out.split(" ");
    return { sha, date };
  }
  // Never committed: the working tree is the only truth available.
  const [sha, date] = git(["log", "-1", "--format=%h %cs"]).split(" ");
  return { sha, date: date ?? "1970-01-01" };
}

/** Files under docs/, excluding ADRs (they carry their own Status/Date header). */
export function documents(dir = DOCS) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `${dir}/${name}`);
}

export function stamp(file, { sha, date }) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const existing = lines.findIndex((line) => MARKER.test(line.trim()));
  if (existing !== -1) {
    lines[existing] = `<!-- verified: ${sha} ${date} -->`;
    return lines.join("\n");
  }
  const marker = `<!-- verified: ${sha} ${date} -->`;
  // After the SPDX header when there is one, so the licence stays the first line.
  if (lines[0]?.includes("SPDX-License-Identifier")) lines.splice(1, 0, marker);
  else lines.unshift(marker);
  return lines.join("\n");
}

export function staleness(files = documents()) {
  const stale = [];
  for (const file of files) {
    const expected = lastTouched(file);
    const first = readFileSync(file, "utf8")
      .split("\n")
      .find((line) => MARKER.test(line.trim()));
    const [, sha, date] = first?.match(MARKER) ?? [];
    // The stamp matches the last commit *and* nothing is uncommitted: fresh.
    if (sha === expected.sha && date === expected.date && !uncommitted(file)) continue;
    // A stamp only goes stale when the *document* changed: a commit that touched
    // nothing but the stamp line is the stamp doing its job, not a contradiction.
    if (sha && markerOnly(sha, file)) continue;
    stale.push({
      file,
      found: first ? `${sha} ${date}` : "none",
      expected: `${expected.sha} ${expected.date}`,
    });
  }
  return stale;
}

/** True when the working tree differs from the last commit in this file. */
function uncommitted(file) {
  try {
    execFileSync("git", ["diff", "--quiet", "--", file]);
    return false;
  } catch {
    return true;
  }
}

/** True when everything that changed between `sha` and the working tree is a stamp. */
function markerOnly(sha, file) {
  try {
    // Working tree, not HEAD: an uncommitted edit is a stale stamp too.
    const diff = execFileSync("git", ["diff", "-U0", sha, "--", file], {
      encoding: "utf8",
    });
    return diff
      .split("\n")
      .filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
      .every((line) => MARKER.test(line.slice(1).trim()));
  } catch {
    return false;
  }
}

if (process.argv[1]?.endsWith("docs-verified.mjs")) {
  if (isShallow()) {
    console.log("docs-verified: shallow clone — skipping (needs full history to date a file)");
  } else {
    const check = process.argv.includes("--check");
    const files = documents();
    if (check) {
      const stale = staleness(files);
      for (const item of stale)
        console.error(
          `✖ ${item.file}: stamp says ${item.found}, the file was last changed by ${item.expected} — run \`node scripts/docs-verified.mjs\``,
        );
      console.log(`docs-verified: ${files.length} document(s), ${stale.length} stale`);
      if (stale.length > 0) process.exit(1);
    } else {
      let written = 0;
      for (const file of files) {
        const next = stamp(file, lastTouched(file));
        if (next !== readFileSync(file, "utf8")) {
          writeFileSync(file, next);
          written += 1;
        }
      }
      console.log(`docs-verified: stamped ${written} of ${files.length} document(s)`);
    }
  }
}
